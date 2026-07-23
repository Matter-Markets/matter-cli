import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createPublicClient, createWalletClient, defineChain, http, keccak256, parseUnits, type Address, type Hex} from 'viem';
import {privateKeyToAccount, type PrivateKeyAccount} from 'viem/accounts';
import {z} from 'zod';
import {decryptAgentKey} from '../onboarding.js';
import type {RuntimeWorkspaceConfig} from './config.js';
import type {ResidentJournal} from './journal.js';
import {PendingTransactionStore, type PendingTransaction} from './pending.js';
import type {ToolCallBlock, ToolDefinition} from './types.js';
import {CORE_TOOLS, UNIVERSAL_TOOLS} from './universal-tool-definitions.js';
import {UniversalToolHost} from './universal-tool-host.js';

const quoteInput = z.object({asset: z.string().min(1).max(42), side: z.enum(['buy', 'sell']), amount: z.string().regex(/^\d+(?:\.\d+)?$/)});
const tradeInput = quoteInput.extend({slippage_bps: z.number().int().min(0).max(5000).default(50)});

interface OnboardingLocal {id: Hex; api: string; name: string; agentKey: Address}
interface AssetCatalog {quoteAsset: {symbol: string; address: Address; decimals: number}; items: Array<{symbol: string; address: Address; decimals: number; executable?: boolean}>}

async function json(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const value = payload as Record<string, unknown>;
    throw new MatterApiError(response.status, typeof value.message === 'string' ? value.message : `Matter API returned HTTP ${response.status}`);
  }
  return payload;
}

class MatterApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'MatterApiError'; }
}

function serialized(value: unknown): string { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item); }

export class HarnessClient {
  #authorization: string | null = null;
  constructor(readonly api: string, readonly timeoutMs = 30_000) {}
  async get(route: string): Promise<any> { return await this.#request(route, {method: 'GET'}); }
  async post(route: string, body: unknown): Promise<any> { return await this.#request(route, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}); }
  async postAuthenticated(route: string, body: unknown): Promise<any> {
    if (!this.#authorization) throw new Error('Matter runtime session is not active');
    return await this.#request(route, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${this.#authorization}`}, body: JSON.stringify(body)});
  }
  authorize(token: string | null): void { this.#authorization = token; }
  async #request(route: string, init: RequestInit): Promise<any> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); timer.unref?.();
    try { return await json(await fetch(`${this.api}${route}`, {...init, signal: controller.signal})); }
    finally { clearTimeout(timer); }
  }
}

export const MATTER_TOOLS: ToolDefinition[] = [...CORE_TOOLS, ...UNIVERSAL_TOOLS];

export async function publishAgentPost(workspace: string, value: {body: string; asset?: string; parentId?: string; clientId?: string}): Promise<unknown> {
  const input = z.object({body: z.string().trim().min(1).max(500), asset: z.string().trim().max(16).optional(),
    parentId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), clientId: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,64}$/).optional()}).parse(value);
  const {onboarding, account} = await MatterToolHost.loadIdentity(workspace);
  if (!account) throw new Error('agent key is locked; set MATTER_KEY_PASSPHRASE or configure the platform credential store');
  const client = new HarnessClient(onboarding.api.replace(/\/$/, ''));
  const challenge = await client.post(`/onboarding/${onboarding.id}/runtime/challenge`, {}) as {challengeId: Hex; message: string};
  const signature = await account.signMessage({message: challenge.message});
  const proof = await client.post(`/onboarding/${onboarding.id}/runtime/prove`, {challengeId: challenge.challengeId, signature}) as {token: string};
  client.authorize(proof.token);
  return await client.postAuthenticated('/posts', input);
}

export class MatterToolHost {
  readonly client: HarnessClient;
  readonly pending: PendingTransactionStore;
  readonly universal: UniversalToolHost;
  #catalog: AssetCatalog | null = null;
  #runtimeToken: string | null = null;

  constructor(readonly workspace: string, readonly config: RuntimeWorkspaceConfig, readonly onboarding: OnboardingLocal, readonly account: PrivateKeyAccount | null,
    readonly journal: ResidentJournal, pending: PendingTransactionStore) {
    this.client = new HarnessClient(config.api); this.pending = pending;
    const publicClient = createPublicClient({transport: http(config.rpcUrl)});
    this.universal = new UniversalToolHost(workspace, config.agentName, this.client, journal, {
      receiptLookup: async hash => await publicClient.getTransactionReceipt({hash}),
      catalog: () => MATTER_TOOLS,
      publishPost: async input => await this.#publishPost(input),
    });
  }

  static async loadIdentity(workspace: string): Promise<{onboarding: OnboardingLocal; account: PrivateKeyAccount | null}> {
    const onboarding = JSON.parse(await readFile(path.join(workspace, '.matter', 'onboarding.json'), 'utf8')) as OnboardingLocal;
    const passphrase = process.env.MATTER_KEY_PASSPHRASE;
    if (!passphrase) return {onboarding, account: null};
    const keystore = JSON.parse(await readFile(path.join(workspace, '.matter', 'agent-key.json'), 'utf8'));
    const account = privateKeyToAccount(decryptAgentKey(keystore, passphrase));
    delete process.env.MATTER_KEY_PASSPHRASE;
    return {onboarding, account};
  }

  async execute(call: ToolCallBlock, wakeId: string): Promise<{content: string; isError: boolean; trade: boolean}> {
    try {
      let value: unknown;
      if (call.name === 'matter_get_portfolio') value = await this.client.get(`/agents/${encodeURIComponent(this.config.agentName)}/portfolio`);
      else if (call.name === 'matter_get_boundaries') value = await this.client.get(`/onboarding/${this.onboarding.id}`);
      else if (call.name === 'matter_quote') value = await this.#quote(quoteInput.parse(call.arguments));
      else if (call.name === 'matter_simulate_trade') value = await this.#simulate(tradeInput.parse(call.arguments));
      else if (call.name === 'matter_trade') value = await this.#trade(tradeInput.parse(call.arguments), wakeId, call.id);
      else value = await this.universal.execute(call, wakeId);
      return {content: serialized(value), isError: false, trade: call.name === 'matter_trade' && (value as any)?.broadcast?.status === 'success'};
    } catch (error) {
      return {content: JSON.stringify({error: error instanceof Error ? error.message : String(error)}), isError: true, trade: false};
    }
  }

  async recoverPending(): Promise<Array<{hash: string; status: string}>> {
    const recovered: Array<{hash: string; status: string}> = [];
    const publicClient = createPublicClient({transport: http(this.config.rpcUrl)});
    for (const item of await this.pending.list()) {
      try {
        const existing = await publicClient.getTransactionReceipt({hash: item.hash as Hex}).catch(() => null);
        if (existing) {
          await this.pending.remove(item.id); await this.journal.append('transaction.recovered', {hash: item.hash, receipt: existing, source: 'chain'}, item.wakeId);
          recovered.push({hash: item.hash, status: existing.status}); continue;
        }
        const receipt = await this.client.post('/transactions/broadcast', {rawTransaction: item.rawTransaction, confirmations: 1});
        await this.pending.remove(item.id); await this.journal.append('transaction.recovered', {hash: item.hash, receipt}, item.wakeId);
        recovered.push({hash: item.hash, status: String(receipt.status)});
      } catch (error) {
        await this.journal.append('transaction.recovery_pending', {hash: item.hash, error: error instanceof Error ? error.message : String(error)}, item.wakeId);
      }
    }
    return recovered;
  }

  async pendingApprovalCount(): Promise<number> { return await this.universal.pendingApprovals(); }

  async #activateRuntime(): Promise<void> {
    if (!this.account) throw new Error('agent key is locked; restart matterd with MATTER_KEY_PASSPHRASE loaded');
    const challenge = await this.client.post(`/onboarding/${this.onboarding.id}/runtime/challenge`, {}) as {challengeId: Hex; message: string};
    const signature = await this.account.signMessage({message: challenge.message});
    const proof = await this.client.post(`/onboarding/${this.onboarding.id}/runtime/prove`, {challengeId: challenge.challengeId, signature}) as {token: string};
    this.#runtimeToken = proof.token; this.client.authorize(proof.token);
  }

  async #publishPost(input: {body: string; asset?: string; parentId?: string; clientId?: string}): Promise<unknown> {
    if (!this.#runtimeToken) await this.#activateRuntime();
    try { return await this.client.postAuthenticated('/posts', input); }
    catch (error) {
      if (!(error instanceof MatterApiError) || error.status !== 401) throw error;
      this.#runtimeToken = null; this.client.authorize(null); await this.#activateRuntime();
      return await this.client.postAuthenticated('/posts', input);
    }
  }

  async #catalogValue(): Promise<AssetCatalog> { return this.#catalog ??= await this.client.get('/assets') as AssetCatalog; }
  async #rawAmount(input: z.infer<typeof quoteInput>): Promise<string> {
    const catalog = await this.#catalogValue(); const asset = catalog.items.find(item => item.executable !== false && (item.symbol.toLowerCase() === input.asset.toLowerCase() || item.address.toLowerCase() === input.asset.toLowerCase()));
    if (!asset) throw new Error(`asset ${input.asset} is not executable`);
    return parseUnits(input.amount, input.side === 'buy' ? catalog.quoteAsset.decimals : asset.decimals).toString();
  }
  async #quote(input: z.infer<typeof quoteInput>): Promise<unknown> { return await this.client.post('/quotes', {asset: input.asset, side: input.side, amountIn: await this.#rawAmount(input)}); }

  async #simulate(input: z.infer<typeof tradeInput>): Promise<unknown> {
    return await this.client.post('/trades/prepare', {agent: this.config.agentName, caller: this.account?.address ?? this.onboarding.agentKey,
      asset: input.asset, side: input.side, amountIn: await this.#rawAmount(input), slippageBps: input.slippage_bps});
  }

  async #trade(input: z.infer<typeof tradeInput>, wakeId: string, toolCallId: string): Promise<unknown> {
    if (!this.account) throw new Error('agent key is locked; restart matterd with MATTER_KEY_PASSPHRASE loaded');
    // Runtime proofs are presence metadata, not transaction authority. The local
    // agent-key signature plus MatterAccount preflight and contract checks are authoritative.
    const amountIn = await this.#rawAmount(input);
    const prepared = await this.client.post('/trades/prepare', {agent: this.config.agentName, caller: this.account.address, asset: input.asset, side: input.side, amountIn, slippageBps: input.slippage_bps});
    if (!prepared.eligible) return prepared;
    const notional = BigInt(String(prepared.boundaries.notionalUsdg));
    if (notional > BigInt(Math.floor(this.config.autoTradeMaxUsdg * 1_000_000))) return {...prepared, eligible: false, violations: [...prepared.violations, {code: 'local_approval_required', message: `local policy permits autonomous trades only under ${this.config.autoTradeMaxUsdg} USDG`}]} ;
    const chain = defineChain({id: this.config.chainId, name: 'Robinhood Chain', nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18}, rpcUrls: {default: {http: [this.config.rpcUrl]}}});
    const wallet = createWalletClient({account: this.account, chain, transport: http(this.config.rpcUrl)});
    const tx = prepared.transaction as {to: Address; data: Hex; value: string; gas: string | null};
    const request = await wallet.prepareTransactionRequest({account: this.account, to: tx.to, data: tx.data, value: BigInt(tx.value), ...(tx.gas ? {gas: BigInt(tx.gas)} : {})});
    const rawTransaction = await wallet.signTransaction(request); const hash = keccak256(rawTransaction); const id = `${wakeId}-${toolCallId}`;
    const pending: PendingTransaction = {id, wakeId, toolCallId, rawTransaction, hash, state: 'signed', createdAt: new Date().toISOString()};
    await this.pending.save(pending); await this.journal.append('transaction.signed', {hash, toolCallId}, wakeId);
    pending.state = 'broadcast'; pending.broadcastAt = new Date().toISOString(); await this.pending.save(pending);
    const broadcast = await this.client.post('/transactions/broadcast', {rawTransaction, confirmations: 1});
    await this.pending.remove(id); await this.journal.append('transaction.confirmed', {hash, receipt: broadcast}, wakeId);
    return {...prepared, transaction: {to: tx.to, hash}, broadcast};
  }
}
