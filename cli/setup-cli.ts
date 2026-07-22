import {createInterface} from 'node:readline/promises';
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {stdin, stdout} from 'node:process';
import {
  activateAgent,
  onboardingStatus,
  signupAgent,
  type OnboardingStatus,
  type SignupHandoff,
} from './onboarding.js';
import {findAgentWorkspace, workspaceAt, type MatterWorkspace} from './workspace.js';
import {PlatformCredentialStore} from './runtime/credentials.js';
import {startResident} from './runtime/daemon-control.js';
import {configureModel, modelStatus, probeModel, type ConfigureModelOptions} from './runtime/model-cli.js';
import type {CredentialStore} from './runtime/types.js';
import {
  loadRuntimeWorkspaceConfig,
  writeModelConfiguration,
  writeResidentPolicy,
  type ResidentMode,
} from './runtime/config.js';

const NAME = /^[a-z0-9-]{3,20}$/;
const MANAGED_STRATEGY = '<!-- matter:managed-strategy -->';

export interface SetupOptions {
  workspace: string;
  workspaceExplicit: boolean;
  name?: string | undefined;
  api: string;
  rpc?: string | undefined;
  mode?: ResidentMode | undefined;
  autoUnderUsdg?: number | undefined;
  heartbeatMinutes?: number | undefined;
  reconfigureModel?: boolean | undefined;
  launch: boolean;
}

export interface SetupResult {
  complete: boolean;
  stage: 'owner' | 'complete';
  workspace: string;
  agentName: string;
  launch: boolean;
  residentStarted: boolean;
}

export interface SetupPrompter {
  say(message: string): void;
  ask(question: string): Promise<string>;
  secret(question: string): Promise<string>;
}

export class TerminalSetupPrompter implements SetupPrompter {
  say(message: string): void { stdout.write(`${message}\n`); }

  async ask(question: string): Promise<string> {
    const reader = createInterface({input: stdin, output: stdout});
    try { return (await reader.question(question)).trim(); } finally { reader.close(); }
  }

  async secret(question: string): Promise<string> {
    if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) throw new Error('hidden input requires an interactive terminal');
    stdout.write(question); stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const finish = (error?: Error) => {
        stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n');
        error ? reject(error) : resolve(value);
      };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n') return finish();
          if (char === '\u0003') return finish(new Error('setup cancelled'));
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ') value += char;
        }
      };
      stdin.on('data', onData);
    });
  }
}

export interface SetupActions {
  workspaceAt(root: string): Promise<MatterWorkspace | null>;
  findAgentWorkspace(name: string, start: string): Promise<MatterWorkspace | null>;
  signup(options: {name: string; api: string; rpc?: string | undefined; workspace: string; metadataUri?: string | undefined}): Promise<SignupHandoff>;
  status(workspace: string): Promise<OnboardingStatus>;
  activate(workspace: string): Promise<{expiresAt: string; state: string}>;
  configureModel(workspace: string, options: ConfigureModelOptions): Promise<{probe: boolean; credentialReference: string | null}>;
  modelStatus(workspace: string): Promise<Record<string, unknown>>;
  probeModel(workspace: string): Promise<void>;
  startResident(workspace: string): Promise<{pid: number; snapshot: unknown}>;
  credentials: CredentialStore;
}

function defaultActions(): SetupActions {
  return {
    workspaceAt,
    findAgentWorkspace,
    signup: signupAgent,
    status: onboardingStatus,
    activate: activateAgent,
    configureModel,
    modelStatus,
    probeModel,
    startResident,
    credentials: new PlatformCredentialStore(),
  };
}

export function setupWorkspacePath(base: string, name: string, explicit: boolean): string {
  return path.resolve(explicit ? base : path.join(base, '.matter', 'agents', name));
}

export function heartbeatForMode(mode: ResidentMode): number {
  return mode === 'human' ? 0 : 30;
}

export function strategyTemplate(name: string, mode: ResidentMode, mandate = ''): string {
  const common = [
    MANAGED_STRATEGY,
    `# ${name}`,
    '',
    'You are a Matter resident trading agent. Inspect fresh Matter tools before every factual portfolio or market claim.',
    'The onchain owner boundaries and local transaction ceiling are absolute. Stand down on ambiguity, stale data, or failed preflight.',
    'Never claim execution without a confirmed transaction receipt. Explain decisions concisely.',
  ];
  if (mode === 'human') common.push('', 'Operate only on explicit instructions from the current authenticated human. Never trade during a scheduled heartbeat.');
  if (mode === 'watchful') common.push('', `Monitor on scheduled heartbeats${mandate ? ` with this focus: ${mandate}` : ''}. Report material changes, but never trade without an explicit current human instruction.`);
  if (mode === 'autonomous') common.push('', 'You may trade during scheduled heartbeats only when the standing mandate below gives a clear, current reason.', '', '## Standing mandate', '', mandate, '', 'If the mandate does not clearly justify a specific trade now, stand down.');
  return `${common.join('\n')}\n`;
}

function ownerReady(status: OnboardingStatus): boolean {
  return status.steps.registered && status.steps.bounded && status.steps.funded;
}

function pendingOwnerSteps(status: OnboardingStatus): string {
  const pending = [
    !status.steps.claimed && 'wallet claim',
    !status.steps.registered && 'registration',
    !status.steps.bounded && 'boundaries',
    !status.steps.funded && 'funding',
  ].filter(Boolean);
  return pending.join(', ');
}

function maxTradeUsdg(status: OnboardingStatus): number | null {
  const raw = status.boundaries?.maxTradeUsdg;
  if (!raw || !/^\d+$/.test(raw)) return null;
  const micros = BigInt(raw);
  const whole = Number(micros / 1_000_000n);
  return Number.isSafeInteger(whole) ? whole : 1_000_000;
}

async function askChoice(prompter: SetupPrompter, question: string, values: readonly string[], fallback: number): Promise<number> {
  while (true) {
    const answer = await prompter.ask(question);
    if (!answer) return fallback;
    const selected = Number(answer) - 1;
    if (Number.isInteger(selected) && selected >= 0 && selected < values.length) return selected;
    prompter.say(`Choose ${values.map((_value, index) => index + 1).join(', ')}.`);
  }
}

async function askNumber(prompter: SetupPrompter, question: string, fallback: number, maximum = Number.POSITIVE_INFINITY): Promise<number> {
  while (true) {
    const answer = await prompter.ask(question);
    if (!answer) return fallback;
    const value = Number(answer);
    if (Number.isFinite(value) && value >= 0 && value <= maximum) return value;
    prompter.say(`Enter a number from 0 to ${Number.isFinite(maximum) ? maximum : 'the desired amount'}.`);
  }
}

async function exactOrNamedWorkspace(options: SetupOptions, actions: SetupActions): Promise<MatterWorkspace | null> {
  if (options.name) {
    const named = await actions.findAgentWorkspace(options.name, options.workspace);
    if (named) return named;
  }
  return await actions.workspaceAt(path.resolve(options.workspace));
}

async function passphraseFor(workspace: string, name: string, prompter: SetupPrompter, actions: SetupActions, fresh?: string): Promise<string> {
  if (fresh) return fresh;
  if (process.env.MATTER_KEY_PASSPHRASE) return process.env.MATTER_KEY_PASSPHRASE;
  const reference = `matter/agent/${name}/keystore-passphrase`;
  const stored = await actions.credentials.get(reference);
  if (stored) return stored;
  const entered = await prompter.secret('Agent recovery credential: ');
  if (entered.length < 12) throw new Error('agent recovery credential must contain at least 12 characters');
  return entered;
}

async function activateWith(workspace: string, name: string, passphrase: string, actions: SetupActions): Promise<void> {
  const previous = process.env.MATTER_KEY_PASSPHRASE;
  process.env.MATTER_KEY_PASSPHRASE = passphrase;
  try {
    await actions.activate(workspace);
    await actions.credentials.put(`matter/agent/${name}/keystore-passphrase`, passphrase).catch(() => undefined);
  } finally {
    if (previous === undefined) delete process.env.MATTER_KEY_PASSPHRASE;
    else process.env.MATTER_KEY_PASSPHRASE = previous;
  }
}

async function policyConfigured(workspace: string): Promise<boolean> {
  const config = await readFile(path.join(workspace, 'matter.toml'), 'utf8');
  return /^\[resident\]\s*$/m.test(config) && /^\[approvals\]\s*$/m.test(config);
}

async function configurePolicy(workspace: string, name: string, status: OnboardingStatus, options: SetupOptions, prompter: SetupPrompter): Promise<{mode: ResidentMode; heartbeat: number}> {
  const current = await loadRuntimeWorkspaceConfig(workspace);
  if (await policyConfigured(workspace) && !options.mode && options.autoUnderUsdg === undefined && options.heartbeatMinutes === undefined) {
    prompter.say(`✓ operating policy already configured (${current.residentMode}, ${current.autoTradeMaxUsdg} USDG local ceiling)`);
    return {mode: current.residentMode, heartbeat: current.model?.heartbeat_minutes ?? heartbeatForMode(current.residentMode)};
  }

  const modes: readonly ResidentMode[] = ['human', 'watchful', 'autonomous'];
  let mode = options.mode;
  if (!mode) {
    prompter.say('\nOperating mode');
    prompter.say('  1 Human-directed — wakes and trades only when you ask');
    prompter.say('  2 Watchful — scheduled monitoring, human-directed trades');
    prompter.say('  3 Autonomous — scheduled monitoring and bounded trades');
    mode = modes[await askChoice(prompter, 'Choose mode [1]: ', modes, 0)];
  }
  if (!mode) throw new Error('operating mode is required');

  let mandate = '';
  if (mode === 'autonomous') {
    while (!mandate) {
      mandate = await prompter.ask('Standing trading mandate (required): ');
      if (!mandate) prompter.say('Autonomous mode requires an explicit mandate.');
    }
  } else if (mode === 'watchful') {
    mandate = await prompter.ask('Monitoring focus (optional): ');
  }

  const onchainMaximum = Math.min(maxTradeUsdg(status) ?? 25, 1_000_000);
  const defaultCeiling = Math.min(25, onchainMaximum);
  const ceiling = options.autoUnderUsdg ?? await askNumber(prompter, `Local transaction ceiling in USDG [${defaultCeiling}]: `, defaultCeiling, onchainMaximum);
  if (ceiling > onchainMaximum) throw new Error(`local transaction ceiling cannot exceed the onchain per-trade cap of ${onchainMaximum} USDG`);
  await writeResidentPolicy(workspace, mode, ceiling);

  const strategyPath = path.join(workspace, 'MATTER.md');
  const existing = await readFile(strategyPath, 'utf8');
  const placeholder = existing.includes('Describe the agent strategy, thesis, sources, and explicit conditions for standing down.');
  if (placeholder || existing.includes(MANAGED_STRATEGY)) await writeFile(strategyPath, strategyTemplate(name, mode, mandate), {encoding: 'utf8', mode: 0o600});
  else prompter.say('✓ existing custom MATTER.md preserved');

  const heartbeat = options.heartbeatMinutes ?? heartbeatForMode(mode);
  prompter.say(`✓ ${mode} policy saved · ${ceiling} USDG local ceiling · ${heartbeat ? `wake every ${heartbeat} minutes` : 'scheduled wakes off'}`);
  return {mode, heartbeat};
}

async function configureResidentModel(workspace: string, heartbeat: number, options: SetupOptions, prompter: SetupPrompter, actions: SetupActions): Promise<void> {
  const current = await loadRuntimeWorkspaceConfig(workspace);
  if (current.model && !options.reconfigureModel) {
    const status = await actions.modelStatus(workspace);
    if (status.credentialAvailable === true && status.capable === true) {
      if (current.model.heartbeat_minutes !== heartbeat) await writeModelConfiguration(workspace, {...current.model, heartbeat_minutes: heartbeat});
      prompter.say(`✓ model ready (${current.model.adapter} · ${current.model.model})`);
      return;
    }
    if (status.credentialAvailable === true) {
      try {
        await actions.probeModel(workspace);
        if (current.model.heartbeat_minutes !== heartbeat) await writeModelConfiguration(workspace, {...current.model, heartbeat_minutes: heartbeat});
        prompter.say(`✓ model capability probe passed (${current.model.model})`);
        return;
      } catch (error) {
        prompter.say(`Model probe needs repair: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      prompter.say('The configured model credential is unavailable; configure a provider now.');
    }
  }

  prompter.say('\nModel provider');
  const dailyBudget = await askNumber(prompter, 'Daily model budget in USD (0 disables the ceiling) [5]: ', 5, 10_000);
  let inputPrice: number | undefined;
  let outputPrice: number | undefined;
  if (dailyBudget > 0) {
    inputPrice = await askNumber(prompter, 'Provider input price per million tokens: ', 0, 10_000);
    outputPrice = await askNumber(prompter, 'Provider output price per million tokens: ', 0, 10_000);
  }
  const modelOptions: ConfigureModelOptions = {
    heartbeatMinutes: String(heartbeat),
    dailyBudget: String(dailyBudget),
    ...(inputPrice !== undefined ? {inputPrice: String(inputPrice)} : {}),
    ...(outputPrice !== undefined ? {outputPrice: String(outputPrice)} : {}),
  };
  await actions.configureModel(workspace, modelOptions);
  prompter.say('✓ model configured and capability probe passed');
}

export async function runSetup(options: SetupOptions, prompter: SetupPrompter = new TerminalSetupPrompter(), suppliedActions?: SetupActions): Promise<SetupResult> {
  const actions = suppliedActions ?? defaultActions();
  prompter.say('MATTER SETUP');
  prompter.say('Resumable onboarding · local key custody · owner-enforced boundaries\n');

  let workspace = await exactOrNamedWorkspace(options, actions);
  let name = options.name ?? workspace?.agentName;
  if (!name) name = await prompter.ask('Agent name: ');
  if (!NAME.test(name)) throw new Error('agent name must be 3-20 lowercase letters, numbers, or hyphens');
  if (workspace && workspace.agentName !== name) throw new Error(`workspace belongs to ${workspace.agentName}, not ${name}`);

  let recoveryPassphrase: string | undefined;
  if (!workspace) {
    const root = setupWorkspacePath(options.workspace, name, options.workspaceExplicit);
    const existing = await actions.workspaceAt(root);
    if (existing && existing.agentName !== name) throw new Error(`workspace belongs to ${existing.agentName}, not ${name}`);
    if (existing) workspace = existing;
    else {
      const handoff = await actions.signup({name, api: options.api, ...(options.rpc ? {rpc: options.rpc} : {}), workspace: root});
      recoveryPassphrase = handoff.recoveryPassphrase;
      workspace = {root, agentName: name, strategyPath: path.join(root, 'MATTER.md'), configPath: path.join(root, 'matter.toml')};
      prompter.say(`✓ local encrypted identity created at ${root}`);
      prompter.say('\nRECOVERY CREDENTIAL · SHOWN ONCE · KEEP PRIVATE');
      prompter.say(handoff.recoveryPassphrase);
    }
  } else {
    prompter.say(`✓ resumed ${workspace.agentName} at ${workspace.root}`);
  }

  let status = await actions.status(workspace.root);
  if (status.state === 'conflict' || status.state === 'expired') throw new Error(`onboarding is ${status.state}; create a new identity with a different name`);
  while (!ownerReady(status)) {
    prompter.say(`\nOWNER WALLET · ${status.claimUrl}`);
    prompter.say(`Waiting for: ${pendingOwnerSteps(status)}`);
    const answer = await prompter.ask('Complete the wallet flow, then press Enter to check again (q to resume later): ');
    if (answer.toLowerCase() === 'q') {
      prompter.say(`Setup paused safely. Resume with: matter setup --name ${name}`);
      return {complete: false, stage: 'owner', workspace: workspace.root, agentName: name, launch: false, residentStarted: false};
    }
    status = await actions.status(workspace.root);
  }
  prompter.say('✓ owner registration, boundaries, and funding confirmed onchain');

  if (!status.steps.runtimeProven) {
    const passphrase = await passphraseFor(workspace.root, name, prompter, actions, recoveryPassphrase);
    await activateWith(workspace.root, name, passphrase, actions);
    status = await actions.status(workspace.root);
    if (!status.steps.runtimeProven) throw new Error('agent-key activation did not become live');
    prompter.say('✓ local agent key activated');
  } else {
    prompter.say('✓ agent-key activation is live');
  }

  const policy = await configurePolicy(workspace.root, name, status, options, prompter);
  await configureResidentModel(workspace.root, policy.heartbeat, options, prompter, actions);
  const started = await actions.startResident(workspace.root);
  prompter.say(`✓ matterd ${started.pid ? `started (pid ${started.pid})` : 'already running'}`);
  prompter.say(`\n${name} is ready. ${options.launch ? 'Opening the resident session…' : `Open it with: matter ${name}`}`);
  return {complete: true, stage: 'complete', workspace: workspace.root, agentName: name, launch: options.launch, residentStarted: true};
}
