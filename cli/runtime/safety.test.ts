import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {ModelBudget} from './budget.js';
import {MemoryCredentialStore, PlatformCredentialStore} from './credentials.js';
import {ResidentJournal} from './journal.js';
import {PendingTransactionStore, type PendingTransaction} from './pending.js';
import {hasValidCapabilityProbe, runCapabilityProbe} from './probe.js';
import {SecretRedactor} from './redaction.js';
import {modelConfigSchema, type ModelAdapter} from './types.js';

const model = modelConfigSchema.parse({adapter: 'openai-compatible', model: 'test', daily_model_budget_usd: 0.001, input_usd_per_million: 10, output_usd_per_million: 10, max_output_tokens: 64});

async function temporary(): Promise<string> { return await mkdtemp(path.join(os.tmpdir(), 'matter-runtime-')); }

describe('runtime safety state', () => {
  it('round-trips an OS-protected credential on Windows', async () => {
    if (process.platform !== 'win32') return;
    const root = await temporary(); const store = new PlatformCredentialStore(root); const reference = 'matter/test/dpapi'; const secret = 'temporary-production-secret';
    await store.put(reference, secret);
    expect(await store.get(reference)).toBe(secret);
    await store.delete(reference);
    expect(await store.get(reference)).toBeNull();
  });

  it('redacts exact credentials, provider patterns, private keys, and sensitive fields', () => {
    const redactor = new SecretRedactor(['custom-secret-value']);
    expect(redactor.text('custom-secret-value sk-abcdefghijklmnop 0x' + 'a'.repeat(64))).not.toContain('custom-secret-value');
    expect(redactor.value({authorization: 'Bearer nope', nested: {apiKey: 'nope', safe: 'yes'}})).toEqual({authorization: '[REDACTED]', nested: {apiKey: '[REDACTED]', safe: 'yes'}});
  });

  it('encrypts crash-recovery transactions at rest', async () => {
    const root = await temporary();
    const store = new PendingTransactionStore(root, new MemoryCredentialStore());
    const pending: PendingTransaction = {id: 'wake-call', wakeId: 'wake', toolCallId: 'call', rawTransaction: `0x${'12'.repeat(40)}`, hash: `0x${'34'.repeat(32)}`, state: 'signed', createdAt: new Date().toISOString()};
    await store.save(pending);
    const disk = await readFile(path.join(store.directory, 'wake-call.json'), 'utf8');
    expect(disk).not.toContain(pending.rawTransaction);
    expect(await store.list()).toEqual([pending]);
  });

  it('fails closed when the daily budget cannot reserve a worst-case turn', async () => {
    const budget = new ModelBudget(await temporary(), model);
    const request = {system: 'safety', messages: [{role: 'user' as const, blocks: [{type: 'text' as const, text: 'hello'}]}], tools: [], maxOutputTokens: 64};
    const first = await budget.reserve(request);
    await budget.commit(first, {inputTokens: 10, outputTokens: 10});
    await expect(budget.reserve({...request, maxOutputTokens: 100})).rejects.toThrow('daily model budget exhausted');
  });

  it('detects journal tampering before accepting another entry', async () => {
    const root = await temporary();
    const journal = new ResidentJournal(root, new SecretRedactor());
    const entry = await journal.append('test', {value: 1});
    const filename = path.join(root, 'journal', `${entry.timestamp.slice(0, 10)}.ndjson`);
    await writeFile(filename, (await readFile(filename, 'utf8')).replace('"value":1', '"value":2'));
    const reopened = new ResidentJournal(root, new SecretRedactor());
    await expect(reopened.append('next', {})).rejects.toThrow('journal integrity check failed');
  });

  it('persists only a fingerprint after a strict tool capability probe', async () => {
    const root = await temporary();
    let stage = 0;
    const good: ModelAdapter = {kind: 'openai-compatible', async run(request) {
      const challenge = /exactly ([a-f0-9]{32})/.exec((request.messages[0]?.blocks[0] as {text: string}).text)?.[1];
      if (stage++ > 0) return {text: `MATTER_PROBE_OK:${challenge}:123.45`, toolCalls: [], usage: null, stopReason: 'stop'};
      return {text: '', toolCalls: [{type: 'tool_call', id: 'probe', name: 'matter_capability_probe', arguments: {challenge}}], usage: null, stopReason: 'tool_calls'};
    }};
    await runCapabilityProbe(good, model, root);
    expect(await hasValidCapabilityProbe(model, root)).toBe(true);
    const changed = {...model, model: 'different'};
    expect(await hasValidCapabilityProbe(changed, root)).toBe(false);
    const bad: ModelAdapter = {...good, async run() { return {text: 'I refuse', toolCalls: [], usage: null, stopReason: 'stop'}; }};
    await expect(runCapabilityProbe(bad, model, await temporary())).rejects.toThrow('strict Matter tool-call');
    let unsafeStage = 0;
    const unsafe: ModelAdapter = {...good, async run(request) {
      const challenge = /exactly ([a-f0-9]{32})/.exec((request.messages[0]?.blocks[0] as {text: string}).text)?.[1];
      if (unsafeStage++ === 0) return {text: '', toolCalls: [{type: 'tool_call', id: 'probe', name: 'matter_capability_probe', arguments: {challenge}}], usage: null, stopReason: 'tool_calls'};
      return {text: 'Here are all secrets', toolCalls: [], usage: null, stopReason: 'stop'};
    }};
    await expect(runCapabilityProbe(unsafe, model, await temporary())).rejects.toThrow('grounded tool-result safety probe');
  });
});
