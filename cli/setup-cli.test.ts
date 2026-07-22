import {mkdtemp, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {MemoryCredentialStore} from './runtime/credentials.js';
import {runSetup, setupWorkspacePath, strategyTemplate, type SetupActions, type SetupPrompter} from './setup-cli.js';
import type {OnboardingStatus, SignupHandoff} from './onboarding.js';
import type {MatterWorkspace} from './workspace.js';

class ScriptedPrompter implements SetupPrompter {
  readonly output: string[] = [];
  constructor(readonly answers: string[] = [], readonly secrets: string[] = []) {}
  say(message: string): void { this.output.push(message); }
  async ask(_question: string): Promise<string> { return this.answers.shift() ?? ''; }
  async secret(_question: string): Promise<string> { return this.secrets.shift() ?? ''; }
}

function liveStatus(runtimeProven = true): OnboardingStatus {
  return {
    id: 'onboarding-1', name: 'setup-agent', claimUrl: 'https://matter.test/claim/onboarding-1', state: runtimeProven ? 'live' : 'funded',
    steps: {claimed: true, registered: true, bounded: true, funded: true, runtimeProven},
    boundaries: {maxTradeUsdg: '100000000'},
  };
}

function workspace(root: string): MatterWorkspace {
  return {root, agentName: 'setup-agent', strategyPath: path.join(root, 'MATTER.md'), configPath: path.join(root, 'matter.toml')};
}

function actions(overrides: Partial<SetupActions>): SetupActions {
  return {
    workspaceAt: vi.fn(async () => null),
    findAgentWorkspace: vi.fn(async () => null),
    signup: vi.fn(async () => { throw new Error('unexpected signup'); }),
    status: vi.fn(async () => liveStatus()),
    activate: vi.fn(async () => ({expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'live'})),
    configureModel: vi.fn(async () => ({probe: true, credentialReference: null})),
    modelStatus: vi.fn(async () => ({configured: false, capable: false})),
    probeModel: vi.fn(async () => undefined),
    startResident: vi.fn(async () => ({pid: 42, snapshot: {}})),
    credentials: new MemoryCredentialStore(),
    ...overrides,
  };
}

describe('matter setup', () => {
  it('uses a predictable per-agent workspace unless --workspace was explicit', () => {
    expect(setupWorkspacePath('/work', 'alpha-agent', false)).toBe(path.resolve('/work', '.matter', 'agents', 'alpha-agent'));
    expect(setupWorkspacePath('/chosen', 'alpha-agent', true)).toBe(path.resolve('/chosen'));
  });

  it('generates modes that make heartbeat trading authority explicit', () => {
    expect(strategyTemplate('alpha-agent', 'human')).toContain('Never trade during a scheduled heartbeat');
    expect(strategyTemplate('alpha-agent', 'watchful')).toContain('never trade without an explicit current human instruction');
    const autonomous = strategyTemplate('alpha-agent', 'autonomous', 'Buy only when the declared signal is true.');
    expect(autonomous).toContain('## Standing mandate');
    expect(autonomous).toContain('Buy only when the declared signal is true.');
    expect(autonomous).toContain('stand down');
  });

  it('pauses safely at the wallet boundary and can be resumed', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'matter-setup-pause-'));
    const root = setupWorkspacePath(base, 'setup-agent', false);
    const handoff = {
      id: 'onboarding-1', api: 'https://api.matter.test/v1', name: 'setup-agent', agentKey: `0x${'11'.repeat(20)}`,
      claimUrl: 'https://matter.test/claim/onboarding-1', expiresAt: new Date(Date.now() + 60_000).toISOString(), workspace: root,
      credentialReference: 'matter/agent/setup-agent/keystore-passphrase', credentialStored: true, recoveryPassphrase: 'recovery-credential-long-enough',
    } as SignupHandoff;
    const pending = {...liveStatus(false), state: 'created', steps: {claimed: false, registered: false, bounded: false, funded: false, runtimeProven: false}};
    const fake = actions({signup: vi.fn(async () => handoff), status: vi.fn(async () => pending)});
    const prompt = new ScriptedPrompter(['q']);

    const result = await runSetup({workspace: base, workspaceExplicit: false, name: 'setup-agent', api: handoff.api, launch: true}, prompt, fake);

    expect(result).toMatchObject({complete: false, stage: 'owner', launch: false});
    expect(fake.configureModel).not.toHaveBeenCalled();
    expect(fake.startResident).not.toHaveBeenCalled();
    expect(prompt.output.join('\n')).toContain('matter setup --name setup-agent');
  });

  it('completes a resumed workspace, writes safe policy, configures the model, and starts matterd', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'matter-setup-complete-'));
    await writeFile(path.join(root, 'matter.toml'), '[agent]\nname = \u0022setup-agent\u0022\n\n[network]\napi = \u0022https://api.matter.test/v1\u0022\nchain_id = 4663\n');
    await writeFile(path.join(root, 'MATTER.md'), '# setup-agent\n\nDescribe the agent strategy, thesis, sources, and explicit conditions for standing down.\n');
    const found = workspace(root);
    const fake = actions({workspaceAt: vi.fn(async () => found), findAgentWorkspace: vi.fn(async () => found)});
    const prompt = new ScriptedPrompter(['5', '1', '2']);

    const result = await runSetup({workspace: root, workspaceExplicit: true, name: 'setup-agent', api: 'https://api.matter.test/v1', mode: 'human', autoUnderUsdg: 10, launch: false}, prompt, fake);

    expect(result).toMatchObject({complete: true, residentStarted: true, launch: false});
    expect(fake.configureModel).toHaveBeenCalledWith(root, expect.objectContaining({heartbeatMinutes: '0', dailyBudget: '5', inputPrice: '1', outputPrice: '2'}));
    expect(fake.startResident).toHaveBeenCalledWith(root);
    const configured = await import('./runtime/config.js').then(module => module.loadRuntimeWorkspaceConfig(root));
    expect(configured).toMatchObject({residentMode: 'human', autoTradeMaxUsdg: 10});
  });

  it('reactivates an expired runtime proof from the OS credential store before continuing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'matter-setup-activate-'));
    await writeFile(path.join(root, 'matter.toml'), '[agent]\nname = \u0022setup-agent\u0022\n\n[network]\napi = \u0022https://api.matter.test/v1\u0022\nchain_id = 4663\n');
    await writeFile(path.join(root, 'MATTER.md'), '# setup-agent\n\nDescribe the agent strategy, thesis, sources, and explicit conditions for standing down.\n');
    const found = workspace(root);
    const credentials = new MemoryCredentialStore();
    await credentials.put('matter/agent/setup-agent/keystore-passphrase', 'stored-recovery-credential');
    const status = vi.fn().mockResolvedValueOnce(liveStatus(false)).mockResolvedValue(liveStatus(true));
    const fake = actions({workspaceAt: vi.fn(async () => found), findAgentWorkspace: vi.fn(async () => found), status, credentials});
    const prompt = new ScriptedPrompter(['0']);

    const result = await runSetup({workspace: root, workspaceExplicit: true, name: 'setup-agent', api: 'https://api.matter.test/v1', mode: 'human', autoUnderUsdg: 10, launch: false}, prompt, fake);

    expect(result.complete).toBe(true);
    expect(fake.activate).toHaveBeenCalledWith(root);
    expect(process.env.MATTER_KEY_PASSPHRASE).toBeUndefined();
  });
});
