import {lookup} from 'node:dns/promises';
import {readFile, realpath, stat, mkdir, writeFile} from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import {isIP} from 'node:net';
import path from 'node:path';
import {Readable} from 'node:stream';
import {PDFParse} from 'pdf-parse';
import {z} from 'zod';
import {transactionUrl} from '../transaction-link.js';
import type {ResidentJournal} from './journal.js';
import type {ToolCallBlock, ToolDefinition} from './types.js';
import {AgentToolStore, lexicalScore, type ApprovalRecord} from './agent-tool-store.js';
import {UNIVERSAL_TOOLS} from './universal-tool-definitions.js';

interface ApiClient {get(route: string): Promise<any>; post(route: string, body: unknown): Promise<any>}
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Resolver = (hostname: string) => Promise<string[]>;
type ReceiptLookup = (hash: `0x${string}`) => Promise<unknown>;

interface UniversalToolOptions {
  fetcher?: Fetcher;
  resolver?: Resolver;
  receiptLookup?: ReceiptLookup;
  now?: () => Date;
  catalog?: () => ToolDefinition[];
}

const paging = z.object({limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(64).optional()});
const search = z.object({query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).default(8)});
const webSearch = search.extend({query: z.string().min(1).max(300), limit: z.number().int().min(1).max(10).default(5)});
const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

function route(route: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
  const suffix = query.toString();
  return suffix ? `${route}?${suffix}` : route;
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function readableText(value: string): string {
  return decodeEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(normalized) === 6) {
    // Only globally routable unicast IPv6 is accepted. This also rejects
    // IPv4-mapped, NAT64, loopback, link-local, ULA, and multicast ranges.
    if (!/^[23]/.test(normalized)) return true;
    return normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0:') || normalized.startsWith('2002:');
  }
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 100 && (b ?? 0) >= 64 && (b ?? 0) <= 127)
    || (a === 169 && b === 254) || (a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || (a ?? 0) >= 224;
}

function safeUrl(raw: string): URL {
  const value = new URL(raw);
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password) throw new Error('only credential-free http/https URLs are allowed');
  const hostname = value.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || (isIP(hostname) > 0 && privateAddress(hostname))) throw new Error('private or local network URLs are blocked');
  return value;
}

async function pinnedFetch(url: URL, address: string, init: RequestInit): Promise<Response> {
  const transport = url.protocol === 'https:' ? https : http;
  return await new Promise<Response>((resolve, reject) => {
    const requestOptions: http.RequestOptions = {
      method: 'GET', headers: init.headers as http.OutgoingHttpHeaders,
      lookup: ((_hostname: string, options: {all?: boolean}, callback: (...argumentsValue: any[]) => void) => {
        const family = isIP(address);
        if (options.all) callback(null, [{address, family}]);
        else callback(null, address, family);
      }) as any,
    };
    if (init.signal) requestOptions.signal = init.signal;
    const request = transport.request(url, requestOptions, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      const responseInit: ResponseInit = {status: response.statusCode ?? 500, headers};
      if (response.statusMessage) responseInit.statusText = response.statusMessage;
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, responseInit));
    });
    request.once('error', reject); request.end();
  });
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel('remote content exceeds size limit'); throw new Error('remote content exceeds size limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

function escapedXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function safeFilename(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chart'; }

export class UniversalToolHost {
  readonly store: AgentToolStore;
  readonly fetcher: Fetcher | null;
  readonly resolver: Resolver;
  readonly receiptLookup: ReceiptLookup;
  readonly now: () => Date;
  readonly catalog: () => ToolDefinition[];

  constructor(readonly workspace: string, readonly agentName: string, readonly client: ApiClient, readonly journal: ResidentJournal, options: UniversalToolOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.store = new AgentToolStore(workspace, this.now);
    this.fetcher = options.fetcher ?? null;
    this.resolver = options.resolver ?? (async hostname => (await lookup(hostname, {all: true})).map(item => item.address));
    this.receiptLookup = options.receiptLookup ?? (async () => { throw new Error('transaction receipt lookup is unavailable'); });
    this.catalog = options.catalog ?? (() => UNIVERSAL_TOOLS);
  }

  async pendingApprovals(): Promise<number> { return await this.store.pendingApprovals(); }

  async execute(call: ToolCallBlock, wakeId: string): Promise<unknown> {
    const a = call.arguments;
    switch (call.name) {
      case 'matter_list_assets': {
        const input = z.object({query: z.string().max(80).default(''), executable_only: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(50)}).parse(a);
        const value = await this.client.get('/assets'); const needle = input.query.toLowerCase();
        const items = (Array.isArray(value.items) ? value.items : []).filter((item: any) => (!input.executable_only || item.executable === true)
          && (!needle || String(item.symbol).toLowerCase().includes(needle) || String(item.name ?? '').toLowerCase().includes(needle))).slice(0, input.limit);
        return {...value, items, count: items.length};
      }
      case 'matter_get_market_data': {
        const input = z.object({asset: z.string().min(1).max(42), range: z.enum(['1d', '1w', '1m', '1y'])}).parse(a);
        return await this.client.get(route(`/assets/${encodeURIComponent(input.asset)}/history`, {range: input.range}));
      }
      case 'matter_get_history': {
        const input = paging.parse(a); return await this.client.get(route(`/agents/${encodeURIComponent(this.agentName)}/trades`, input));
      }
      case 'matter_get_tape': {
        const input = paging.parse(a); return await this.client.get(route('/tape', input));
      }
      case 'matter_get_leaderboard': {
        const input = z.object({limit: z.number().int().min(1).max(100).default(20), basis: z.enum(['trades', 'equity']).default('trades')}).parse(a);
        const page = await this.client.get(route('/agents', {limit: input.limit})); const agents = Array.isArray(page.items) ? page.items : [];
        const scored = await Promise.all(agents.map(async (agent: any) => {
          if (input.basis === 'trades') return {...agent, score: Number(agent.tradeCount ?? 0)};
          const portfolio = await this.client.get(`/agents/${encodeURIComponent(String(agent.name))}/portfolio`);
          return {...agent, score: String(portfolio.equityUsdg ?? '0')};
        }));
        scored.sort((left: any, right: any) => input.basis === 'trades' ? Number(right.score) - Number(left.score) : (BigInt(right.score) > BigInt(left.score) ? 1 : -1));
        return {basis: input.basis === 'trades' ? 'indexed_trade_count' : 'live_equity_usdg', items: scored.map((item, index) => ({rank: index + 1, ...item}))};
      }
      case 'matter_get_agent': {
        const input = z.object({agent: z.string().min(1).max(80).default(this.agentName)}).parse(a);
        return await this.client.get(`/agents/${encodeURIComponent(input.agent)}`);
      }
      case 'matter_pulse': {
        const input = z.object({status: z.string().trim().min(1).max(140)}).parse(a);
        const entry = await this.journal.append('agent.pulse', {status: input.status}, wakeId);
        return {ok: true, status: input.status, journalSequence: entry.sequence, published: false};
      }
      case 'matter_update_profile': {
        const input = z.object({metadata_uri: z.string().url().max(2048)}).parse(a);
        return await this.#approval('profile_update', {metadataUri: input.metadata_uri, authority: 'owner'}, wakeId);
      }
      case 'matter_get_transaction': {
        const hash = hashSchema.parse(a.hash) as `0x${string}`;
        return {hash, receipt: await this.receiptLookup(hash), explorerUrl: transactionUrl(hash)};
      }
      case 'matter_get_performance': {
        const input = z.object({window: z.enum(['24h', '7d', '30d', 'all']).default('7d')}).parse(a);
        return await this.client.get(route(`/agents/${encodeURIComponent(this.agentName)}/performance`, {window: input.window}));
      }
      case 'matter_search_memory': return await this.#searchMemory(search.parse(a));
      case 'matter_remember': {
        const input = z.object({text: z.string().trim().min(1).max(4000), tags: z.array(z.string().trim().min(1).max(40)).max(12).default([])}).parse(a);
        return await this.store.mutate(state => { const item = {id: this.store.id(), text: input.text, tags: [...new Set(input.tags)], createdAt: this.store.timestamp()}; state.memories.push(item); return item; });
      }
      case 'matter_list_projects': {
        const {status} = z.object({status: z.enum(['active', 'blocked', 'complete', 'all']).default('all')}).parse(a); const state = await this.store.snapshot();
        return {items: state.projects.filter(item => status === 'all' || item.status === status)};
      }
      case 'matter_update_project': {
        const input = z.object({id: z.string().max(80).optional(), title: z.string().trim().min(1).max(200), summary: z.string().max(4000), status: z.enum(['active', 'blocked', 'complete'])}).parse(a);
        return await this.store.mutate(state => { const existing = input.id ? state.projects.find(item => item.id === input.id) : undefined;
          if (input.id && !existing) throw new Error('project not found');
          const item = existing ?? {id: this.store.id(), title: '', summary: '', status: 'active' as const, updatedAt: ''};
          Object.assign(item, {title: input.title, summary: input.summary, status: input.status, updatedAt: this.store.timestamp()}); if (!existing) state.projects.push(item); return item; });
      }
      case 'matter_get_journal': {
        const input = z.object({count: z.number().int().min(1).max(100).default(20), type: z.string().max(100).default('')}).parse(a);
        const entries = await this.journal.latest(input.type ? 500 : input.count); return {items: entries.filter(item => !input.type || item.type === input.type).slice(-input.count)};
      }
      case 'matter_ask_owner': {
        const input = z.object({question: z.string().trim().min(1).max(1000), context: z.string().max(4000).default('')}).parse(a);
        return await this.#approval('owner_question', input, wakeId);
      }
      case 'matter_propose_strategy_patch': {
        const input = z.object({patch: z.string().min(1).max(20000), reason: z.string().trim().min(1).max(2000)}).parse(a);
        if (/matter\.toml|\.matter[\\/]/i.test(input.patch)) throw new Error('strategy proposals may only target MATTER.md');
        if (!/^---\s+(?:a\/)?MATTER\.md\s*$/mi.test(input.patch) || !/^\+\+\+\s+(?:b\/)?MATTER\.md\s*$/mi.test(input.patch)) throw new Error('patch must be a unified diff for MATTER.md');
        return await this.#approval('strategy_patch', input, wakeId);
      }
      case 'matter_search_news': return await this.#searchNews(webSearch.parse(a));
      case 'matter_search_web': return await this.#searchWeb(webSearch.parse(a));
      case 'matter_fetch_url': {
        const input = z.object({url: z.string().url().max(2048), max_chars: z.number().int().min(1000).max(100000).default(30000)}).parse(a);
        const fetched = await this.#fetchPublic(input.url, 1_048_576); return {url: fetched.url, contentType: fetched.contentType, text: readableText(fetched.bytes.toString('utf8')).slice(0, input.max_chars), untrusted: true};
      }
      case 'matter_read_pdf': {
        const input = z.object({source: z.string().min(1).max(2048), max_chars: z.number().int().min(1000).max(100000).default(50000)}).parse(a);
        const bytes = /^https?:\/\//i.test(input.source) ? (await this.#fetchPublic(input.source, 10_000_000)).bytes : await this.#workspaceFile(input.source, 10_000_000);
        const parser = new PDFParse({data: new Uint8Array(bytes)}); try { const result = await parser.getText(); return {source: input.source, text: result.text.slice(0, input.max_chars), truncated: result.text.length > input.max_chars}; } finally { await parser.destroy(); }
      }
      case 'matter_read_filing': return await this.#readFiling(a);
      case 'matter_index_research': {
        const input = z.object({title: z.string().trim().min(1).max(300), source: z.string().max(2048).default(''), content: z.string().min(1).max(100000)}).parse(a);
        return await this.store.mutate(state => { const item = {id: this.store.id(), ...input, createdAt: this.store.timestamp()}; state.research.push(item); return {...item, content: undefined, characters: input.content.length}; });
      }
      case 'matter_search_research': {
        const input = search.parse(a); const state = await this.store.snapshot();
        const items = state.research.map(item => ({item, score: lexicalScore(input.query, `${item.title} ${item.content}`)})).filter(row => row.score > 0).sort((l, r) => r.score - l.score).slice(0, input.limit)
          .map(({item, score}) => ({...item, content: item.content.slice(0, 4000), score})); return {query: input.query, items};
      }
      case 'matter_search_tools': {
        const input = z.object({query: z.string().max(100).default(''), limit: z.number().int().min(1).max(50).default(20)}).parse(a); const needle = input.query.toLowerCase();
        return {items: this.catalog().filter(tool => !needle || tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)).slice(0, input.limit).map(tool => ({name: tool.name, description: tool.description, mutating: tool.mutating}))};
      }
      case 'matter_describe_tool': {
        const {name} = z.object({name: z.string().min(1).max(128)}).parse(a); const tool = this.catalog().find(item => item.name.toLowerCase() === name.toLowerCase());
        if (!tool) throw new Error('tool not found'); return tool;
      }
      case 'matter_todo_add': {
        const {text} = z.object({text: z.string().trim().min(1).max(1000)}).parse(a); return await this.store.mutate(state => { const item = {id: this.store.id(), text, completed: false, createdAt: this.store.timestamp(), completedAt: null}; state.todos.push(item); return item; });
      }
      case 'matter_todo_list': {
        const {completed} = z.object({completed: z.enum(['true', 'false', 'all']).default('all')}).parse(a); const state = await this.store.snapshot(); return {items: state.todos.filter(item => completed === 'all' || item.completed === (completed === 'true'))};
      }
      case 'matter_todo_complete': {
        const {id} = z.object({id: z.string().min(1).max(80)}).parse(a); return await this.store.mutate(state => { const item = state.todos.find(todo => todo.id === id); if (!item) throw new Error('todo not found'); item.completed = true; item.completedAt = this.store.timestamp(); return item; });
      }
      case 'matter_delegate_research': {
        const input = z.object({objective: z.string().trim().min(1).max(500), queries: z.array(z.string().trim().min(1).max(300)).max(4).default([])}).parse(a);
        const queries = input.queries.length ? input.queries : [input.objective]; const results = [];
        for (const query of queries) results.push({query, web: await this.#searchWeb({query, limit: 3}), news: await this.#searchNews({query, limit: 3})});
        return {objective: input.objective, bounded: true, delegatedTools: ['matter_search_web', 'matter_search_news'], results};
      }
      case 'matter_render_chart': return await this.#renderChart(a);
      case 'matter_send_file': {
        const {path: inputPath} = z.object({path: z.string().min(1).max(500)}).parse(a); const resolved = await this.#confinedFile(inputPath, 10_000_000, true); const info = await stat(resolved);
        return {ok: true, path: path.relative(this.workspace, resolved).replace(/\\/g, '/'), bytes: info.size, delivery: 'attached_cli'};
      }
      case 'matter_set_reminder': {
        const input = z.object({text: z.string().trim().min(1).max(1000), due_at: z.string().datetime()}).parse(a); if (Date.parse(input.due_at) <= this.now().getTime()) throw new Error('reminder must be in the future');
        return await this.store.mutate(state => { const item = {id: this.store.id(), text: input.text, dueAt: input.due_at, completed: false, createdAt: this.store.timestamp()}; state.reminders.push(item); return item; });
      }
      case 'matter_list_reminders': {
        const {include_completed} = z.object({include_completed: z.boolean().default(false)}).parse(a); const state = await this.store.snapshot(); const current = this.now().getTime();
        return {items: state.reminders.filter(item => include_completed || !item.completed).map(item => ({...item, due: !item.completed && Date.parse(item.dueAt) <= current}))};
      }
      case 'matter_send_message': return await this.#sendMessage(a, wakeId);
      default: throw new Error(`unknown universal Matter tool ${call.name}`);
    }
  }

  async #approval(kind: ApprovalRecord['kind'], payload: unknown, wakeId: string): Promise<unknown> {
    const item = await this.store.mutate(state => { const approval: ApprovalRecord = {id: this.store.id(), kind, payload, status: 'pending', createdAt: this.store.timestamp(), confirmedAt: null}; state.approvals.push(approval); return approval; });
    await this.journal.append('approval.requested', {id: item.id, kind, payload}, wakeId); return {ok: false, needsOwner: true, approval: item};
  }

  async #searchMemory(input: z.infer<typeof search>): Promise<unknown> {
    const state = await this.store.snapshot(); const items = state.memories.map(item => ({item, score: lexicalScore(input.query, `${item.text} ${item.tags.join(' ')}`)}))
      .filter(row => row.score > 0).sort((left, right) => right.score - left.score).slice(0, input.limit).map(({item, score}) => ({...item, score})); return {query: input.query, items};
  }

  async #resolvePublic(url: URL): Promise<string[]> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) > 0 ? [hostname] : await this.resolver(hostname);
    if (addresses.length === 0 || addresses.some(privateAddress)) throw new Error('URL resolves to a private or unavailable address');
    return addresses;
  }

  async #fetchPublic(raw: string, maxBytes: number, headers: Record<string, string> = {}): Promise<{url: string; contentType: string; bytes: Buffer}> {
    let current = safeUrl(raw);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const addresses = await this.#resolvePublic(current); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000); timer.unref?.();
      const init: RequestInit = {redirect: 'manual', signal: controller.signal, headers: {'user-agent': 'MatterResearch/0.1 contact@matter.markets', ...headers}};
      let response: Response; try { response = this.fetcher ? await this.fetcher(current, init) : await pinnedFetch(current, addresses[0]!, init); } finally { clearTimeout(timer); }
      if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); if (!location) throw new Error('redirect omitted location'); current = safeUrl(new URL(location, current).toString()); continue; }
      if (!response.ok) throw new Error(`remote source returned HTTP ${response.status}`); const declared = Number(response.headers.get('content-length') ?? 0); if (declared > maxBytes) throw new Error('remote content exceeds size limit');
      const bytes = await boundedBytes(response, maxBytes); return {url: current.toString(), contentType: response.headers.get('content-type') ?? 'application/octet-stream', bytes};
    }
    throw new Error('too many redirects');
  }

  async #searchWeb(input: {query: string; limit: number}): Promise<unknown> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`; const page = (await this.#fetchPublic(url, 1_048_576)).bytes.toString('utf8'); const items: Array<{title: string; url: string}> = [];
    for (const match of page.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const target = decodeEntities(match[1] ?? ''); const redirect = new URL(target, 'https://duckduckgo.com'); const decoded = redirect.searchParams.get('uddg') ?? redirect.toString();
      items.push({title: readableText(match[2] ?? ''), url: decoded}); if (items.length >= input.limit) break;
    }
    return {query: input.query, items, untrusted: true, source: 'duckduckgo'};
  }

  async #searchNews(input: {query: string; limit: number}): Promise<unknown> {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(input.query)}&hl=en-US&gl=US&ceid=US:en`; const xml = (await this.#fetchPublic(url, 1_048_576)).bytes.toString('utf8'); const items = [];
    for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) { const body = match[1] ?? ''; const value = (tag: string) => decodeEntities(body.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'))?.[1]?.trim() ?? '');
      items.push({title: value('title'), url: value('link'), publishedAt: value('pubDate'), source: readableText(value('source'))}); if (items.length >= input.limit) break; }
    return {query: input.query, items, untrusted: true, source: 'google-news-rss'};
  }

  async #readFiling(argumentsValue: Record<string, unknown>): Promise<unknown> {
    const input = z.object({ticker: z.string().regex(/^[A-Za-z.-]{1,12}$/).transform(value => value.toUpperCase()), form: z.enum(['10-K', '10-Q', '8-K', 'all']).default('all'), limit: z.number().int().min(1).max(20).default(10)}).parse(argumentsValue);
    const tickers = JSON.parse((await this.#fetchPublic('https://www.sec.gov/files/company_tickers.json', 5_000_000)).bytes.toString('utf8')) as Record<string, {ticker: string; cik_str: number; title: string}>;
    const company = Object.values(tickers).find(item => item.ticker.toUpperCase() === input.ticker); if (!company) throw new Error('SEC ticker not found'); const cik = String(company.cik_str).padStart(10, '0');
    const submission = JSON.parse((await this.#fetchPublic(`https://data.sec.gov/submissions/CIK${cik}.json`, 10_000_000)).bytes.toString('utf8')) as any; const recent = submission.filings?.recent ?? {}; const items = [];
    for (let index = 0; index < (recent.form?.length ?? 0) && items.length < input.limit; index++) { const form = String(recent.form[index]); if (input.form !== 'all' && form !== input.form) continue; const accession = String(recent.accessionNumber[index]); const accessionPlain = accession.replace(/-/g, ''); const document = String(recent.primaryDocument[index]);
      items.push({form, filedAt: recent.filingDate[index], reportDate: recent.reportDate[index], accession, url: `https://www.sec.gov/Archives/edgar/data/${company.cik_str}/${accessionPlain}/${document}`}); }
    return {company: {ticker: company.ticker, name: company.title, cik}, items, untrusted: true, source: 'sec-edgar'};
  }

  #workspacePath(relative: string): string {
    if (path.isAbsolute(relative)) throw new Error('path must be relative to the workspace'); const root = path.resolve(this.workspace); const resolved = path.resolve(root, relative); if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('path escapes workspace'); return resolved;
  }

  async #confinedFile(relative: string, maxBytes: number, shareable = false): Promise<string> {
    const lexical = this.#workspacePath(relative); const actual = await realpath(lexical); const root = await realpath(this.workspace);
    if (actual !== root && !actual.startsWith(root + path.sep)) throw new Error('file resolves outside workspace');
    const normalized = path.relative(root, actual).replace(/\\/g, '/');
    if (shareable && /(^|\/)(?:\.matter|journal)(?:\/|$)|(^|\/)(?:matter\.toml|MATTER\.md|\.env)(?:$)/i.test(normalized)) throw new Error('sensitive workspace files cannot be shared');
    const info = await stat(actual); if (!info.isFile() || info.size > maxBytes) throw new Error('workspace file exceeds size limit'); return actual;
  }

  async #workspaceFile(relative: string, maxBytes: number): Promise<Buffer> { return await readFile(await this.#confinedFile(relative, maxBytes, true)); }

  async #renderChart(argumentsValue: Record<string, unknown>): Promise<unknown> {
    const input = z.object({title: z.string().trim().min(1).max(200), values: z.array(z.number().finite()).min(2).max(500), labels: z.array(z.string().max(80)).max(500).default([])}).parse(argumentsValue); if (input.labels.length && input.labels.length !== input.values.length) throw new Error('labels must match values length');
    const width = 900, height = 420, pad = 50; const min = Math.min(...input.values), max = Math.max(...input.values); const span = max - min || 1; const points = input.values.map((value, index) => `${pad + index * (width - pad * 2) / (input.values.length - 1)},${height - pad - (value - min) / span * (height - pad * 2)}`).join(' ');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0a0a0a"/><text x="${pad}" y="30" fill="#f2f2e8" font-family="monospace" font-size="18">${escapedXml(input.title)}</text><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#777"/><polyline fill="none" stroke="#ccff00" stroke-width="3" points="${points}"/><text x="${pad}" y="${height - 15}" fill="#aaa" font-family="monospace" font-size="12">min ${escapedXml(String(min))} · max ${escapedXml(String(max))}</text></svg>`;
    const directory = this.#workspacePath('artifacts/charts'); await mkdir(directory, {recursive: true, mode: 0o700}); const filename = `${safeFilename(input.title)}-${this.now().getTime()}.svg`; const absolute = path.join(directory, filename); await writeFile(absolute, svg, {encoding: 'utf8', mode: 0o600}); return {ok: true, path: path.relative(this.workspace, absolute).replace(/\\/g, '/'), points: input.values.length};
  }

  async #sendMessage(argumentsValue: Record<string, unknown>, wakeId: string): Promise<unknown> {
    const input = z.object({destination: z.string().trim().min(1).max(200), message: z.string().trim().min(1).max(4000)}).strict().parse(argumentsValue);
    return await this.#approval('message', input, wakeId);
  }
}
