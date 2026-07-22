import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {loadRuntimeWorkspaceConfig, writeModelConfiguration, writeResidentPolicy} from './config.js';
import {modelConfigSchema} from './types.js';

describe('resident policy configuration', () => {
  it('defaults incomplete workspaces to Robinhood mainnet production services', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'matter-production-defaults-'));
    await writeFile(path.join(root, 'matter.toml'), '[agent]\nname = "mainnet-agent"\n');

    expect(await loadRuntimeWorkspaceConfig(root)).toMatchObject({
      api: 'https://api.matter.markets/v1',
      chainId: 4663,
      rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
    });
  });

  it('updates policy idempotently without damaging network or model sections', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'matter-policy-'));
    await writeFile(path.join(root, 'matter.toml'), [
      '[agent]',
      'name = \u0022policy-agent\u0022',
      '',
      '[network]',
      'chain_id = 4663',
      'api = \u0022https://api.matter.test/v1\u0022',
      '',
      '[model]',
      'adapter = \u0022openai-compatible\u0022',
      'model = \u0022frontier\u0022',
      'base_url = \u0022http://127.0.0.1:11434/v1\u0022',
      'daily_model_budget_usd = 0',
      'heartbeat_minutes = 30',
      '',
    ].join('\n'));

    await writeResidentPolicy(root, 'watchful', 50);
    await writeResidentPolicy(root, 'autonomous', 250);

    const raw = await readFile(path.join(root, 'matter.toml'), 'utf8');
    expect(raw.match(/^\[resident\]$/gm)).toHaveLength(1);
    expect(raw.match(/^\[approvals\]$/gm)).toHaveLength(1);
    expect(raw).toContain('api = \u0022https://api.matter.test/v1\u0022');
    expect(raw).toContain('model = \u0022frontier\u0022');
    expect(await loadRuntimeWorkspaceConfig(root)).toMatchObject({residentMode: 'autonomous', autoTradeMaxUsdg: 250});
  });

  it('replaces a model section without duplicating adjacent setup policy', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'matter-model-config-'));
    await writeFile(path.join(root, 'matter.toml'), '[agent]\nname = \u0022policy-agent\u0022\n\n[resident]\nmode = \u0022watchful\u0022\n\n[approvals]\nauto_under_usdg = 25\n');
    const first = modelConfigSchema.parse({adapter: 'openai-compatible', model: 'first', base_url: 'http://127.0.0.1:11434/v1', daily_model_budget_usd: 0, heartbeat_minutes: 30});
    const second = modelConfigSchema.parse({...first, model: 'second', heartbeat_minutes: 10});

    await writeModelConfiguration(root, first);
    await writeModelConfiguration(root, second);

    const raw = await readFile(path.join(root, 'matter.toml'), 'utf8');
    expect(raw.match(/^\[model\]$/gm)).toHaveLength(1);
    expect(raw.match(/^\[resident\]$/gm)).toHaveLength(1);
    expect(await loadRuntimeWorkspaceConfig(root)).toMatchObject({residentMode: 'watchful', model: {model: 'second', heartbeat_minutes: 10}});
  });
});
