import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {createModelAdapter} from './adapters.js';
import {loadRuntimeWorkspaceConfig, writeModelConfiguration} from './config.js';
import {modelCredentialReference, PlatformCredentialStore} from './credentials.js';
import {hasValidCapabilityProbe, runCapabilityProbe} from './probe.js';
import {adapterKindSchema, modelConfigSchema, type AdapterKind} from './types.js';

export interface ConfigureModelOptions {
  adapter?: string; model?: string; baseUrl?: string; keyEnv?: string; keyStdin?: boolean; noKey?: boolean; noProbe?: boolean;
  dailyBudget?: string; inputPrice?: string; outputPrice?: string; maxOutputTokens?: string; maxTurns?: string; heartbeatMinutes?: string;
}

async function promptValue(question: string): Promise<string> {
  const reader = createInterface({input: stdin, output: stdout});
  try { return (await reader.question(question)).trim(); } finally { reader.close(); }
}

async function promptSecret(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) throw new Error('interactive secret input requires a TTY; use --key-stdin or --key-env');
  stdout.write(label); stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); error ? reject(error) : resolve(value); };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') return finish(new Error('cancelled'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function stdinSecret(): Promise<string> {
  let value = ''; for await (const chunk of stdin) value += String(chunk); return value.replace(/\r?\n$/, '');
}

async function selectAdapter(): Promise<{adapter: AdapterKind; baseUrl?: string; noKey?: boolean}> {
  const choice = await promptValue(['Choose model provider:', '  1 Anthropic', '  2 OpenAI', '  3 Google Gemini', '  4 OpenRouter / xAI / compatible', '  5 Local OpenAI-compatible', '> '].join('\n'));
  const values: Record<string, AdapterKind> = {'1': 'anthropic', '2': 'openai-responses', '3': 'gemini', '4': 'openai-compatible', '5': 'openai-compatible'};
  const adapter = values[choice]; if (!adapter) throw new Error('invalid provider selection');
  if (choice === '4') {
    const entered = await promptValue('Compatible API base URL [https://openrouter.ai/api/v1]: ');
    return {adapter, baseUrl: entered || 'https://openrouter.ai/api/v1'};
  }
  if (choice === '5') {
    const entered = await promptValue('Local API base URL [http://127.0.0.1:11434/v1]: ');
    return {adapter, baseUrl: entered || 'http://127.0.0.1:11434/v1', noKey: true};
  }
  return {adapter};
}

function number(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback; const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`); return parsed;
}

export async function configureModel(workspace: string, options: ConfigureModelOptions): Promise<{probe: boolean; credentialReference: string | null}> {
  const current = await loadRuntimeWorkspaceConfig(workspace);
  const selected = options.adapter ? {adapter: adapterKindSchema.parse(options.adapter)} : await selectAdapter();
  const adapter = selected.adapter;
  const baseUrl = options.baseUrl ?? selected.baseUrl;
  const noKey = options.noKey ?? selected.noKey ?? false;
  const model = options.model ?? await promptValue('Model ID: '); if (!model) throw new Error('model ID is required');
  const credentials = new PlatformCredentialStore(); let keyRef: string | undefined;
  if (options.keyEnv) {
    keyRef = `env:${options.keyEnv}`; if (!process.env[options.keyEnv]) throw new Error(`environment variable ${options.keyEnv} is empty`);
  } else if (!noKey) {
    const secret = options.keyStdin ? await stdinSecret() : await promptSecret('API key (stored by OS; input hidden): ');
    if (secret.length < 8) throw new Error('API key is too short'); keyRef = modelCredentialReference(current.agentName, adapter); await credentials.put(keyRef, secret);
  }
  const inputPrice = options.inputPrice === undefined ? undefined : number(options.inputPrice, 0, 'input price');
  const outputPrice = options.outputPrice === undefined ? undefined : number(options.outputPrice, 0, 'output price');
  const dailyBudget = number(options.dailyBudget, inputPrice !== undefined && outputPrice !== undefined ? 5 : 0, 'daily budget');
  const config = modelConfigSchema.parse({adapter, model, ...(baseUrl ? {base_url: baseUrl} : {}), ...(keyRef ? {key_ref: keyRef} : {}),
    max_output_tokens: number(options.maxOutputTokens, 4096, 'max output tokens'), max_turns_per_wake: number(options.maxTurns, 8, 'max turns'), max_tool_calls_per_wake: 16,
    request_timeout_ms: 120_000, heartbeat_minutes: number(options.heartbeatMinutes, 30, 'heartbeat minutes'), daily_model_budget_usd: dailyBudget,
    ...(inputPrice !== undefined ? {input_usd_per_million: inputPrice} : {}), ...(outputPrice !== undefined ? {output_usd_per_million: outputPrice} : {})});
  await writeModelConfiguration(workspace, config);
  let passed = false;
  if (!options.noProbe) { const created = await createModelAdapter(config, credentials); await runCapabilityProbe(created.adapter, config, workspace); passed = true; }
  return {probe: passed, credentialReference: keyRef ?? null};
}

export async function probeModel(workspace: string): Promise<void> {
  const config = await loadRuntimeWorkspaceConfig(workspace); if (!config.model) throw new Error('no model configured');
  const created = await createModelAdapter(config.model, new PlatformCredentialStore()); await runCapabilityProbe(created.adapter, config.model, workspace);
}

export async function modelStatus(workspace: string): Promise<Record<string, unknown>> {
  const config = await loadRuntimeWorkspaceConfig(workspace); if (!config.model) return {configured: false, capable: false};
  const credentials = new PlatformCredentialStore(); const credentialAvailable = config.model.key_ref ? Boolean(await credentials.get(config.model.key_ref)) : true;
  return {configured: true, adapter: config.model.adapter, model: config.model.model, baseUrl: config.model.base_url ?? 'provider default', credentialReference: config.model.key_ref ?? null,
    credentialAvailable, capable: await hasValidCapabilityProbe(config.model, workspace), heartbeatMinutes: config.model.heartbeat_minutes,
    dailyBudgetUsd: config.model.daily_model_budget_usd};
}
