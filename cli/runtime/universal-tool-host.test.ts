import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ResidentJournal} from './journal.js';
import type {ToolCallBlock} from './types.js';
import {MATTER_TOOLS} from './harness-tools.js';
import {UniversalToolHost} from './universal-tool-host.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

async function workspace(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'matter-tools-')); roots.push(root); return root; }

function journal() {
  let sequence = 0;
  const entries: any[] = [];
  return {
    entries,
    value: {
      append: vi.fn(async (type: string, data: unknown, wakeId: string | null = null) => {
        const item = {id: String(++sequence), sequence, timestamp: '2026-07-22T12:00:00.000Z', type, wakeId, data, previousHash: '', hash: ''}; entries.push(item); return item;
      }),
      latest: vi.fn(async (count: number) => entries.slice(-count)),
    } as unknown as ResidentJournal,
  };
}

function api() {
  const get = vi.fn(async (requestPath: string): Promise<any> => {
    if (requestPath === '/assets') return {quoteAsset: {symbol: 'USDG'}, items: [
      {symbol: 'AAPL', name: 'Apple', executable: true}, {symbol: 'SPCX', name: 'SpaceX', executable: false},
    ]};
    if (requestPath === '/assets/AAPL/history?range=1m') return {symbol: 'AAPL', range: '1m', points: [{close: 200}]};
    if (requestPath === '/agents/immutable/trades?limit=2') return {items: [{id: 1, asset: 'AAPL'}], nextCursor: null};
    if (requestPath === '/tape?limit=2') return {items: [{id: 1, type: 'account.trade'}], nextCursor: null};
    if (requestPath === '/agents?limit=2') return {items: [{name: 'alpha', tradeCount: 2}, {name: 'beta', tradeCount: 5}]};
    if (requestPath === '/agents/alpha/portfolio') return {equityUsdg: '200'};
    if (requestPath === '/agents/beta/portfolio') return {equityUsdg: '100'};
    if (requestPath === '/agents/immutable') return {id: 2, name: 'immutable'};
    if (requestPath === '/agents/immutable/performance?window=30d') return {summary: {changeBps: '120'}};
    throw new Error(`unexpected GET ${requestPath}`);
  });
  return {get, post: vi.fn()};
}

function publicFetcher(input: string | URL | Request): Promise<Response> {
  const value = String(input);
  if (value.startsWith('https://html.duckduckgo.com/')) return Promise.resolve(new Response(
    '<a class="result__a" href="https://example.com/report">Market report</a>', {headers: {'content-type': 'text/html'}},
  ));
  if (value.startsWith('https://news.google.com/')) return Promise.resolve(new Response(
    '<rss><channel><item><title>Market News</title><link>https://news.example/item</link><pubDate>Wed, 22 Jul 2026 12:00:00 GMT</pubDate><source>Wire</source></item></channel></rss>',
    {headers: {'content-type': 'application/rss+xml'}},
  ));
  if (value === 'https://example.com/article') return Promise.resolve(new Response('<html><script>bad()</script><body>Hello <b>Matter</b></body></html>', {headers: {'content-type': 'text/html'}}));
  if (value === 'https://www.sec.gov/files/company_tickers.json') return Promise.resolve(new Response(JSON.stringify({'0': {ticker: 'AAPL', cik_str: 320193, title: 'Apple Inc.'}})));
  if (value === 'https://data.sec.gov/submissions/CIK0000320193.json') return Promise.resolve(new Response(JSON.stringify({filings: {recent: {
    form: ['10-K', '8-K'], accessionNumber: ['0000320193-26-000001', '0000320193-26-000002'], primaryDocument: ['aapl-10k.htm', 'aapl-8k.htm'], filingDate: ['2026-01-01', '2026-02-01'], reportDate: ['2025-12-31', '2026-02-01'],
  }}})));
  return Promise.resolve(new Response('not found', {status: 404}));
}

async function fixture(options: {now?: Date; fetcher?: typeof fetch; publishPost?: (input: {body: string; asset?: string; parentId?: string; clientId?: string}) => Promise<unknown>} = {}) {
  const root = await workspace(); const log = journal(); const client = api();
  const host = new UniversalToolHost(root, 'immutable', client, log.value, {
    fetcher: options.fetcher ?? publicFetcher,
    resolver: async () => ['93.184.216.34'],
    receiptLookup: async hash => ({transactionHash: hash, status: 'success', blockNumber: 42n}),
    now: () => options.now ?? new Date('2026-07-22T12:00:00.000Z'),
    catalog: () => MATTER_TOOLS,
    ...(options.publishPost ? {publishPost: options.publishPost} : {}),
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => await host.execute({type: 'tool_call', id: `call-${name}`, name, arguments: args} as ToolCallBlock, 'wake-1');
  return {root, log, client, host, call};
}

function pdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length + 37} >>\nstream\nBT /F1 24 Tf 100 700 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((value, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${value}\nendobj\n`; });
  const start = Buffer.byteLength(body); body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  body += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`; return Buffer.from(body);
}

describe('universal Matter tool catalog', () => {
  it('registers the complete, unique 41-tool surface with closed object schemas', () => {
    const expected = [
      'matter_get_portfolio', 'matter_get_boundaries', 'matter_quote', 'matter_trade', 'matter_list_assets', 'matter_get_market_data',
      'matter_get_history', 'matter_get_tape', 'matter_get_leaderboard', 'matter_get_agent', 'matter_pulse', 'matter_post', 'matter_update_profile',
      'matter_simulate_trade', 'matter_get_transaction', 'matter_get_performance', 'matter_search_memory', 'matter_remember', 'matter_list_projects',
      'matter_update_project', 'matter_get_journal', 'matter_ask_owner', 'matter_propose_strategy_patch', 'matter_search_news', 'matter_search_web',
      'matter_fetch_url', 'matter_read_pdf', 'matter_read_filing', 'matter_index_research', 'matter_search_research', 'matter_search_tools',
      'matter_describe_tool', 'matter_todo_add', 'matter_todo_list', 'matter_todo_complete', 'matter_delegate_research', 'matter_render_chart',
      'matter_send_file', 'matter_set_reminder', 'matter_list_reminders', 'matter_send_message',
    ];
    expect(MATTER_TOOLS.map(tool => tool.name)).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
    for (const tool of MATTER_TOOLS) expect(tool.inputSchema).toMatchObject({type: 'object', additionalProperties: false});
  });
});

describe('market and chain tools', () => {
  it('lists and filters executable assets', async () => { const {call} = await fixture(); expect(await call('matter_list_assets', {query: 'app', executable_only: true, limit: 10})).toMatchObject({count: 1, items: [{symbol: 'AAPL'}]}); });
  it('reads market history', async () => { const {call} = await fixture(); expect(await call('matter_get_market_data', {asset: 'AAPL', range: '1m'})).toMatchObject({symbol: 'AAPL'}); });
  it('reads paginated own history', async () => { const {call} = await fixture(); expect(await call('matter_get_history', {limit: 2})).toMatchObject({items: [{asset: 'AAPL'}]}); });
  it('reads paginated public tape', async () => { const {call} = await fixture(); expect(await call('matter_get_tape', {limit: 2})).toMatchObject({items: [{type: 'account.trade'}]}); });
  it('ranks agents by indexed trades and live equity without claiming unavailable returns', async () => {
    const {call} = await fixture();
    const trades: any = await call('matter_get_leaderboard', {limit: 2, basis: 'trades'});
    const equity: any = await call('matter_get_leaderboard', {limit: 2, basis: 'equity'});
    expect(trades).toMatchObject({basis: 'indexed_trade_count'}); expect(trades.items[0]).toMatchObject({name: 'beta', rank: 1});
    expect(equity).toMatchObject({basis: 'live_equity_usdg'}); expect(equity.items[0]).toMatchObject({name: 'alpha', rank: 1});
  });
  it('reads a public agent', async () => { const {call} = await fixture(); expect(await call('matter_get_agent', {agent: 'immutable'})).toEqual({id: 2, name: 'immutable'}); });
  it('journals but does not falsely claim publication when no publisher is configured', async () => { const {call, log} = await fixture(); expect(await call('matter_pulse', {status: 'watching liquidity'})).toMatchObject({ok: true, published: false}); expect(log.value.append).toHaveBeenCalledWith('agent.pulse', expect.objectContaining({status: 'watching liquidity', published: false}), 'wake-1'); });
  it('publishes pulses, asset chatter, and replies through the configured agent publisher', async () => {
    const publishPost = vi.fn(async input => ({id: `post-${input.body}`})); const {call} = await fixture({publishPost});
    expect(await call('matter_pulse', {status: 'network healthy'})).toMatchObject({published: true, post: {id: 'post-network healthy'}});
    expect(await call('matter_post', {body: 'Spreads tightened', asset: 'AAPL', parent_id: '0xparent', client_id: 'wake-2'})).toMatchObject({published: true});
    expect(publishPost).toHaveBeenLastCalledWith({body: 'Spreads tightened', asset: 'AAPL', parentId: '0xparent', clientId: 'wake-2'});
  });
  it('queues owner-authorized profile updates', async () => { const {call, host} = await fixture(); expect(await call('matter_update_profile', {metadata_uri: 'https://example.com/profile.json'})).toMatchObject({needsOwner: true, approval: {kind: 'profile_update'}}); expect(await host.pendingApprovals()).toBe(1); });
  it('reads a receipt with its explorer URL', async () => { const {call} = await fixture(); const hash = `0x${'ab'.repeat(32)}`; expect(await call('matter_get_transaction', {hash})).toMatchObject({hash, receipt: {status: 'success'}, explorerUrl: expect.stringContaining(hash)}); });
  it('reads sampled performance', async () => { const {call} = await fixture(); expect(await call('matter_get_performance', {window: '30d'})).toEqual({summary: {changeBps: '120'}}); });
});

describe('memory, projects, journal, and approvals', () => {
  it('persists and searches memories across host instances', async () => {
    const first = await fixture(); await first.call('matter_remember', {text: 'Apple liquidity improved', tags: ['AAPL', 'liquidity']});
    expect(await first.call('matter_search_memory', {query: 'apple liquidity', limit: 5})).toMatchObject({items: [{text: 'Apple liquidity improved', score: 2}]});
    const second = new UniversalToolHost(first.root, 'immutable', first.client, first.log.value, {resolver: async () => ['93.184.216.34']});
    expect(await second.execute({type: 'tool_call', id: 'search', name: 'matter_search_memory', arguments: {query: 'AAPL'}}, 'wake')).toMatchObject({items: [{tags: ['AAPL', 'liquidity']}]});
  });
  it('creates, updates, and filters projects', async () => { const {call} = await fixture(); const created: any = await call('matter_update_project', {title: 'Research AAPL', summary: 'Start', status: 'active'}); await call('matter_update_project', {id: created.id, title: 'Research AAPL', summary: 'Done', status: 'complete'}); expect(await call('matter_list_projects', {status: 'complete'})).toMatchObject({items: [{id: created.id, summary: 'Done'}]}); });
  it('reads and filters verified journal entries', async () => { const {call, log} = await fixture(); await log.value.append('wake.completed', {ok: true}, 'wake'); await log.value.append('agent.pulse', {status: 'ok'}, 'wake'); expect(await call('matter_get_journal', {count: 5, type: 'agent.pulse'})).toMatchObject({items: [{type: 'agent.pulse'}]}); });
  it('queues owner questions', async () => { const {call} = await fixture(); expect(await call('matter_ask_owner', {question: 'May I publish this?', context: 'profile'})).toMatchObject({needsOwner: true, approval: {kind: 'owner_question'}}); });
  it('accepts only MATTER.md strategy diffs and never applies them', async () => { const {call, root} = await fixture(); const proposal = await call('matter_propose_strategy_patch', {patch: '--- a/MATTER.md\n+++ b/MATTER.md\n@@ -1 +1 @@\n-old\n+new', reason: 'clearer'}); expect(proposal).toMatchObject({needsOwner: true, approval: {kind: 'strategy_patch'}}); await expect(readFile(path.join(root, 'MATTER.md'), 'utf8')).rejects.toMatchObject({code: 'ENOENT'}); await expect(call('matter_propose_strategy_patch', {patch: '--- a/matter.toml\n+++ b/matter.toml', reason: 'bad'})).rejects.toThrow('only target MATTER.md'); });
});

describe('bounded external research', () => {
  it('searches the web and marks results untrusted', async () => { const {call} = await fixture(); expect(await call('matter_search_web', {query: 'AAPL', limit: 3})).toMatchObject({untrusted: true, items: [{title: 'Market report', url: 'https://example.com/report'}]}); });
  it('searches current news and marks results untrusted', async () => { const {call} = await fixture(); expect(await call('matter_search_news', {query: 'AAPL', limit: 3})).toMatchObject({untrusted: true, items: [{title: 'Market News'}]}); });
  it('fetches readable public text and strips active HTML', async () => { const {call} = await fixture(); expect(await call('matter_fetch_url', {url: 'https://example.com/article', max_chars: 5000})).toMatchObject({text: 'Hello Matter', untrusted: true}); });
  it('blocks local-network URLs before fetch', async () => { const {call} = await fixture(); await expect(call('matter_fetch_url', {url: 'http://127.0.0.1/secret'})).rejects.toThrow('private or local'); });
  it('blocks IPv4-mapped local URLs before fetch', async () => { const {call} = await fixture(); await expect(call('matter_fetch_url', {url: 'http://[::ffff:127.0.0.1]/secret'})).rejects.toThrow('private or local'); });
  it('stops reading a chunked response as soon as it exceeds the byte cap', async () => {
    const chunk = new Uint8Array(600_000); const fetcher = vi.fn(async () => new Response(new ReadableStream({start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.close(); }})));
    const {call} = await fixture({fetcher: fetcher as typeof fetch});
    await expect(call('matter_fetch_url', {url: 'https://example.com/oversized', max_chars: 1000})).rejects.toThrow('size limit');
  });
  it('extracts text from an offline workspace PDF', async () => { const {call, root} = await fixture(); await writeFile(path.join(root, 'report.pdf'), pdf('Hello Matter')); expect(await call('matter_read_pdf', {source: 'report.pdf', max_chars: 5000})).toMatchObject({text: expect.stringContaining('Hello Matter')}); });
  it('finds and filters SEC filings', async () => { const {call} = await fixture(); expect(await call('matter_read_filing', {ticker: 'aapl', form: '10-K', limit: 5})).toMatchObject({company: {ticker: 'AAPL'}, items: [{form: '10-K', url: expect.stringContaining('aapl-10k.htm')}], untrusted: true}); });
  it('indexes and searches local research', async () => { const {call} = await fixture(); await call('matter_index_research', {title: 'Apple note', source: 'analyst', content: 'Services revenue accelerated'}); expect(await call('matter_search_research', {query: 'services revenue', limit: 5})).toMatchObject({items: [{title: 'Apple note', score: 2}]}); });
  it('delegates only bounded web and news fan-out', async () => { const {call} = await fixture(); expect(await call('matter_delegate_research', {objective: 'AAPL outlook', queries: ['AAPL outlook']})).toMatchObject({bounded: true, delegatedTools: ['matter_search_web', 'matter_search_news'], results: [{query: 'AAPL outlook'}]}); });
});

describe('planning, artifacts, reminders, and messaging', () => {
  it('searches and describes the live tool catalog', async () => { const {call} = await fixture(); expect(await call('matter_search_tools', {query: 'transaction', limit: 10})).toMatchObject({items: [{name: 'matter_get_transaction'}]}); expect(await call('matter_describe_tool', {name: 'MATTER_TRADE'})).toMatchObject({name: 'matter_trade', mutating: true}); await expect(call('matter_describe_tool', {name: 'missing'})).rejects.toThrow('tool not found'); });
  it('adds, lists, and completes todos', async () => { const {call} = await fixture(); const todo: any = await call('matter_todo_add', {text: 'Review allocation'}); expect(await call('matter_todo_list', {completed: 'false'})).toMatchObject({items: [{id: todo.id}]}); await call('matter_todo_complete', {id: todo.id}); expect(await call('matter_todo_list', {completed: 'true'})).toMatchObject({items: [{completed: true}]}); });
  it('renders escaped SVG charts into the artifact directory', async () => { const {call, root} = await fixture(); const result: any = await call('matter_render_chart', {title: '<AAPL & risk>', values: [1, 3, 2], labels: ['a', 'b', 'c']}); expect(result).toMatchObject({ok: true, points: 3}); const svg = await readFile(path.join(root, result.path), 'utf8'); expect(svg).toContain('&lt;AAPL &amp; risk&gt;'); expect(svg).not.toContain('<AAPL'); });
  it('exposes only regular files confined to the workspace', async () => { const {call, root} = await fixture(); await writeFile(path.join(root, 'report.txt'), 'safe'); expect(await call('matter_send_file', {path: 'report.txt'})).toMatchObject({ok: true, bytes: 4, delivery: 'attached_cli'}); await expect(call('matter_send_file', {path: '../outside.txt'})).rejects.toThrow('escapes workspace'); });
  it('refuses to share resident configuration and journal material', async () => { const {call, root} = await fixture(); await writeFile(path.join(root, 'matter.toml'), '[agent]'); await expect(call('matter_send_file', {path: 'matter.toml'})).rejects.toThrow('sensitive workspace files'); });
  it('sets and lists future reminders while rejecting past times', async () => { const {call} = await fixture(); await call('matter_set_reminder', {text: 'Review close', due_at: '2026-07-22T13:00:00.000Z'}); expect(await call('matter_list_reminders', {})).toMatchObject({items: [{text: 'Review close', due: false}]}); await expect(call('matter_set_reminder', {text: 'late', due_at: '2026-07-22T11:00:00.000Z'})).rejects.toThrow('future'); });
  it('queues messages for an owner and never exposes an agent-side confirmation path', async () => { const {call, host} = await fixture(); const proposed: any = await call('matter_send_message', {destination: 'discord:risk', message: 'Daily close'}); expect(proposed).toMatchObject({needsOwner: true, approval: {kind: 'message', status: 'pending'}}); expect(await host.pendingApprovals()).toBe(1); await expect(call('matter_send_message', {destination: 'discord:risk', message: 'Daily close', confirmation_id: proposed.approval.id})).rejects.toThrow('Unrecognized key'); expect(await host.pendingApprovals()).toBe(1); });
});
