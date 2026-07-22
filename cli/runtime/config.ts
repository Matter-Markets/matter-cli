import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'smol-toml';
import {z} from 'zod';
import {modelConfigSchema, type ModelConfig} from './types.js';

const workspaceConfigSchema = z.object({
  agent: z.object({name: z.string().regex(/^[a-z0-9-]{3,20}$/)}),
  network: z.object({api: z.string().url().optional(), rpc: z.string().url().optional(), chain_id: z.number().int().positive().optional()}).optional(),
  model: modelConfigSchema.optional(),
  approvals: z.object({auto_under_usdg: z.number().min(0).max(1_000_000).default(25)}).optional(),
  resident: z.object({mode: z.enum(['human', 'watchful', 'autonomous'])}).optional(),
}).passthrough();

export type ResidentMode = 'human' | 'watchful' | 'autonomous';

export interface RuntimeWorkspaceConfig {
  agentName: string;
  api: string;
  chainId: number;
  rpcUrl: string;
  autoTradeMaxUsdg: number;
  residentMode: ResidentMode;
  model: ModelConfig | null;
}

export async function loadRuntimeWorkspaceConfig(root: string): Promise<RuntimeWorkspaceConfig> {
  const raw = workspaceConfigSchema.parse(parse(await readFile(path.join(root, 'matter.toml'), 'utf8')));
  return {
    agentName: raw.agent.name,
    api: (raw.network?.api ?? 'https://api.matter.markets/v1').replace(/\/$/, ''),
    chainId: raw.network?.chain_id ?? 4663,
    rpcUrl: raw.network?.rpc ?? (raw.network?.api?.startsWith('http://127.0.0.1:4646') ? 'http://127.0.0.1:8545' : 'https://rpc.mainnet.chain.robinhood.com'),
    autoTradeMaxUsdg: raw.approvals?.auto_under_usdg ?? 25,
    residentMode: raw.resident?.mode ?? 'human',
    model: raw.model ?? null,
  };
}

function tomlString(value: string): string { return JSON.stringify(value); }

function replaceSection(current: string, name: string, body: string): string {
  const expression = new RegExp(`(?:^|\\n)\\[${name}\\]\\r?\\n[\\s\\S]*?(?=\\r?\\n\\[[^\\]]+\\]|$)`);
  const without = current.replace(expression, '').trimEnd();
  return `${without}\n\n[${name}]\n${body.trim()}\n`;
}

export async function writeModelConfiguration(root: string, config: ModelConfig): Promise<void> {
  const filename = path.join(root, 'matter.toml');
  const current = await readFile(filename, 'utf8');
  const lines = [
    `adapter = ${tomlString(config.adapter)}`,
    `model = ${tomlString(config.model)}`,
    ...(config.base_url ? [`base_url = ${tomlString(config.base_url)}`] : []),
    ...(config.key_ref ? [`key_ref = ${tomlString(config.key_ref)}`] : []),
    `max_output_tokens = ${config.max_output_tokens}`,
    `max_turns_per_wake = ${config.max_turns_per_wake}`,
    `max_tool_calls_per_wake = ${config.max_tool_calls_per_wake}`,
    `request_timeout_ms = ${config.request_timeout_ms}`,
    `heartbeat_minutes = ${config.heartbeat_minutes}`,
    `daily_model_budget_usd = ${config.daily_model_budget_usd}`,
    ...(config.input_usd_per_million !== undefined ? [`input_usd_per_million = ${config.input_usd_per_million}`] : []),
    ...(config.output_usd_per_million !== undefined ? [`output_usd_per_million = ${config.output_usd_per_million}`] : []),
  ].join('\n');
  await writeFile(filename, replaceSection(current, 'model', lines), {encoding: 'utf8', mode: 0o600});
}

export async function writeResidentPolicy(root: string, mode: ResidentMode, autoUnderUsdg: number): Promise<void> {
  if (!Number.isFinite(autoUnderUsdg) || autoUnderUsdg < 0 || autoUnderUsdg > 1_000_000) throw new Error('local trade ceiling must be between 0 and 1000000 USDG');
  const filename = path.join(root, 'matter.toml');
  let current = await readFile(filename, 'utf8');
  current = replaceSection(current, 'resident', `mode = ${tomlString(mode)}`);
  current = replaceSection(current, 'approvals', `auto_under_usdg = ${autoUnderUsdg}`);
  await writeFile(filename, current, {encoding: 'utf8', mode: 0o600});
}
