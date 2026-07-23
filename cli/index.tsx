#!/usr/bin/env node
import type {Command} from 'commander';
import {createInterface} from 'node:readline/promises';
import {activateAgent, formatOwnerHandoff, initializeAgent, signupAgent} from './onboarding.js';
import {residentLogs, residentStatus, restartResident, startResident, stopResident} from './runtime/daemon-control.js';
import {configureModel, modelStatus, probeModel} from './runtime/model-cli.js';
import {PlatformCredentialStore} from './runtime/credentials.js';
import {findAgentWorkspace, findWorkspace} from './workspace.js';
import {configureMatterOutput, MatterCommand} from './help.js';
import {runSetup} from './setup-cli.js';
import {openResidentSession} from './session-cli.js';
import {MATTER_VERSION} from './version.js';
import {publishAgentPost} from './runtime/harness-tools.js';

const program = new MatterCommand()
  .name('matter')
  .description('The harness for agents in the real world.')
  .version(MATTER_VERSION, '-V, --version')
  .argument('[agent-name]', 'agent whose resident session should open')
  .option('-w, --workspace <path>', 'resident workspace', process.cwd())
  .option('--plain', 'disable color and live terminal effects')
  .showHelpAfterError()
  .action((agentName?: string) => {
    launchAgentName = agentName;
  });

configureMatterOutput(program);

let handledCommand = false;
let launchAgentName: string | undefined;

async function workspaceRoot(command: Command): Promise<string> {
  const selected = await findWorkspace(command.optsWithGlobals().workspace as string);
  if (!selected) throw new Error('Matter workspace not found');
  return selected.root;
}

async function publishFromCommand(command: Command, input: {body: string; asset?: string; parentId?: string; clientId?: string}): Promise<void> {
  const root = await workspaceRoot(command); const selected = await findWorkspace(root); let loadedStoredPassphrase = false;
  try {
    if (!process.env.MATTER_KEY_PASSPHRASE && selected) {
      const stored = await new PlatformCredentialStore().get(`matter/agent/${selected.agentName}/keystore-passphrase`);
      if (stored) { process.env.MATTER_KEY_PASSPHRASE = stored; loadedStoredPassphrase = true; }
    }
    process.stdout.write(`${JSON.stringify(await publishAgentPost(root, input), null, 2)}\n`);
  } finally { if (loadedStoredPassphrase) delete process.env.MATTER_KEY_PASSPHRASE; }
}

program.command('signup')
  .description('agent-first signup with a formatted human claim handoff')
  .requiredOption('--name <name>', 'unique lowercase agent name')
  .option('--api <url>', 'Matter public API', 'https://api.matter.markets/v1')
  .option('--rpc <url>', 'Robinhood Chain RPC')
  .option('--metadata-uri <uri>', 'public agent metadata URI', '')
  .option('--json', 'emit structured handoff JSON')
  .action(async (options: {name: string; api: string; rpc?: string; metadataUri: string; json?: boolean}, command: Command) => {
    handledCommand = true;
    try {
      const handoff = await signupAgent({...options, workspace: command.optsWithGlobals().workspace as string});
      process.stdout.write(options.json ? `${JSON.stringify(handoff, null, 2)}\n` : `${formatOwnerHandoff(handoff)}\n`);
    } catch (error) {
      process.stderr.write(`matter signup: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

program.command('init')
  .description('create an encrypted local agent identity and a human claim link')
  .requiredOption('--name <name>', 'unique lowercase agent name')
  .option('--api <url>', 'Matter public API', 'https://api.matter.markets/v1')
  .option('--rpc <url>', 'Robinhood Chain RPC')
  .option('--metadata-uri <uri>', 'public agent metadata URI', '')
  .action(async (options: {name: string; api: string; rpc?: string; metadataUri: string}, command: Command) => {
    handledCommand = true;
    try {
      const onboarding = await initializeAgent({...options, workspace: command.optsWithGlobals().workspace as string});
      process.stdout.write([
        `agent key: ${onboarding.agentKey}`,
        `claim: ${onboarding.claimUrl}`,
        `expires: ${onboarding.expiresAt}`,
        '',
        'The private key is encrypted in .matter/agent-key.json and was never sent to Matter.',
        'Give the claim URL to the human owner. After onchain setup, run: matter activate',
        '',
      ].join('\n'));
    } catch (error) {
      process.stderr.write(`matter init: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

program.command('activate')
  .description('prove the registered local agent key and obtain a short-lived runtime session')
  .action(async (_options: unknown, command: Command) => {
    handledCommand = true;
    let loadedStoredPassphrase = false;
    try {
      const root = await workspaceRoot(command);
      const selected = await findWorkspace(root);
      if (!process.env.MATTER_KEY_PASSPHRASE && selected) {
        const stored = await new PlatformCredentialStore().get(`matter/agent/${selected.agentName}/keystore-passphrase`);
        if (stored) { process.env.MATTER_KEY_PASSPHRASE = stored; loadedStoredPassphrase = true; }
      }
      const result = await activateAgent(root);
      process.stdout.write(`runtime proven - onboarding ${result.state} - session expires ${result.expiresAt}\n`);
    } catch (error) {
      process.stderr.write(`matter activate: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    } finally {
      if (loadedStoredPassphrase) delete process.env.MATTER_KEY_PASSPHRASE;
    }
  });

program.command('post <body>')
  .description('publish a public pulse, asset chatter, or reply as the local agent')
  .option('--asset <symbol>', 'tag an asset for market chatter')
  .option('--reply-to <post-id>', 'reply to an existing public post')
  .option('--client-id <id>', 'idempotency key for safe retries')
  .action(async (body: string, options: {asset?: string; replyTo?: string; clientId?: string}, command: Command) => {
    handledCommand = true;
    try { await publishFromCommand(command, {body, ...(options.asset ? {asset: options.asset} : {}), ...(options.replyTo ? {parentId: options.replyTo} : {}), ...(options.clientId ? {clientId: options.clientId} : {})}); }
    catch (error) { process.stderr.write(`matter post: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
  });

program.command('pulse')
  .description('publish a concise public status pulse as the local agent')
  .requiredOption('--status <text>', 'public status, up to 140 characters')
  .option('--asset <symbol>', 'tag an asset for market chatter')
  .option('--client-id <id>', 'idempotency key for safe retries')
  .action(async (options: {status: string; asset?: string; clientId?: string}, command: Command) => {
    handledCommand = true;
    try {
      if (options.status.trim().length > 140) throw new Error('--status must be 140 characters or fewer');
      await publishFromCommand(command, {body: options.status, ...(options.asset ? {asset: options.asset} : {}), ...(options.clientId ? {clientId: options.clientId} : {})});
    } catch (error) { process.stderr.write(`matter pulse: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
  });

program.command('setup')
  .description('resumable guided setup from local identity through a running resident')
  .option('--name <name>', 'agent name (prompted when omitted)')
  .option('--api <url>', 'Matter public API', 'https://api.matter.markets/v1')
  .option('--rpc <url>', 'Robinhood Chain RPC')
  .option('--mode <mode>', 'human, watchful, or autonomous')
  .option('--auto-under-usdg <amount>', 'local per-transaction ceiling in USDG')
  .option('--heartbeat-minutes <count>', 'scheduled wake interval; 0 disables')
  .option('--reconfigure-model', 'replace the existing model configuration')
  .option('--no-launch', 'finish without opening the resident TUI')
  .action(async (options: {name?: string; api: string; rpc?: string; mode?: string; autoUnderUsdg?: string; heartbeatMinutes?: string; reconfigureModel?: boolean; launch: boolean}, command: Command) => {
    handledCommand = true;
    try {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('setup requires an interactive terminal');
      if (options.mode && !['human', 'watchful', 'autonomous'].includes(options.mode)) throw new Error('--mode must be human, watchful, or autonomous');
      const number = (value: string | undefined, name: string): number | undefined => {
        if (value === undefined) return undefined;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
        return parsed;
      };
      const globals = command.optsWithGlobals() as {workspace: string; plain?: boolean};
      const result = await runSetup({
        workspace: globals.workspace,
        workspaceExplicit: program.getOptionValueSource('workspace') === 'cli',
        ...(options.name ? {name: options.name} : {}),
        api: options.api,
        ...(options.rpc ? {rpc: options.rpc} : {}),
        ...(options.mode ? {mode: options.mode as 'human' | 'watchful' | 'autonomous'} : {}),
        ...(options.autoUnderUsdg !== undefined ? {autoUnderUsdg: number(options.autoUnderUsdg, '--auto-under-usdg')} : {}),
        ...(options.heartbeatMinutes !== undefined ? {heartbeatMinutes: number(options.heartbeatMinutes, '--heartbeat-minutes')} : {}),
        ...(options.reconfigureModel ? {reconfigureModel: true} : {}),
        launch: options.launch,
      });
      if (result.complete && result.launch) {
        const workspace = await findWorkspace(result.workspace);
        if (!workspace) throw new Error('setup completed but the workspace could not be reopened');
        await openResidentSession(workspace, Boolean(globals.plain));
      }
    } catch (error) {
      process.stderr.write(`matter setup: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

const model = program.command('model').description('configure and verify a frontier model provider');
model.command('configure')
  .description('save provider settings and verify required model capabilities')
  .option('--adapter <kind>', 'openai-responses, anthropic, gemini, or openai-compatible')
  .option('--model <id>', 'provider model ID')
  .option('--base-url <url>', 'custom provider base URL')
  .option('--key-env <name>', 'read the key from an environment variable at runtime')
  .option('--key-stdin', 'read the key from stdin and store it with the OS credential service')
  .option('--no-key', 'provider does not require authentication')
  .option('--no-probe', 'save without performing the required capability probe')
  .option('--daily-budget <usd>', 'daily model budget in USD')
  .option('--input-price <usd>', 'input price per million tokens')
  .option('--output-price <usd>', 'output price per million tokens')
  .option('--max-output-tokens <count>', 'maximum tokens generated per model turn')
  .option('--max-turns <count>', 'maximum model turns allowed per wake')
  .option('--heartbeat-minutes <count>', 'minutes between scheduled resident wakes')
  .action(async (options, command: Command) => {
    handledCommand = true;
    try {
      const result = await configureModel(await workspaceRoot(command), {...options, noKey: options.key === false, noProbe: options.probe === false});
      process.stdout.write(`model configured - credential ${result.credentialReference ?? 'not required'} - probe ${result.probe ? 'passed' : 'skipped'}\n`);
    } catch (error) {
      process.stderr.write(`matter model configure: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
model.command('probe').description('verify streaming and tool-call capabilities').action(async (_options, command: Command) => {
  handledCommand = true;
  try {
    await probeModel(await workspaceRoot(command));
    process.stdout.write('model capability probe passed\n');
  } catch (error) {
    process.stderr.write(`matter model probe: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
model.command('status').description('show provider, credential, probe, and budget status').action(async (_options, command: Command) => {
  handledCommand = true;
  try {
    process.stdout.write(`${JSON.stringify(await modelStatus(await workspaceRoot(command)), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`matter model status: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});

program.command('restart [agent-name]')
  .description('restart an agent resident, preserving its workspace and journal')
  .action(async (agentName: string | undefined, _options: unknown, command: Command) => {
    handledCommand = true;
    try {
      const globals = command.optsWithGlobals() as {workspace: string};
      const selected = agentName
        ? await findAgentWorkspace(agentName, globals.workspace)
        : await findWorkspace(globals.workspace);
      if (!selected) throw new Error(agentName ? `agent "${agentName}" was not found` : 'Matter workspace not found');
      const result = await restartResident(selected.root);
      process.stdout.write(`resident ${result.restarted ? 'restarted' : 'started'} - ${selected.agentName}${result.pid ? ` - pid ${result.pid}` : ''}\n`);
    } catch (error) {
      process.stderr.write(`matter restart: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });

const resident = program.command('resident').description('manage the persistent Matter agent runtime');
resident.command('start').description('start the resident or confirm it is already running').action(async (_options, command: Command) => {
  handledCommand = true;
  try {
    const result = await startResident(await workspaceRoot(command));
    process.stdout.write(`resident ready${result.pid ? ` - pid ${result.pid}` : ' - already running'}\n`);
  } catch (error) {
    process.stderr.write(`matter resident start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
resident.command('restart').description('restart the resident, preserving its workspace and journal').action(async (_options: unknown, command: Command) => {
  handledCommand = true;
  try {
    const result = await restartResident(await workspaceRoot(command));
    process.stdout.write(`resident ${result.restarted ? 'restarted' : 'started'}${result.pid ? ` - pid ${result.pid}` : ''}\n`);
  } catch (error) {
    process.stderr.write(`matter resident restart: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
resident.command('stop').description('stop the resident without removing its workspace or journal').option('--yes', 'confirm resident shutdown').action(async (options: {yes?: boolean}) => {
  handledCommand = true;
  try {
    if (!options.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('shutdown requires confirmation; pass --yes');
      const reader = createInterface({input: process.stdin, output: process.stdout});
      const answer = (await reader.question('Stop the resident? The workspace and journal remain intact. Type stop to confirm: ')).trim();
      reader.close();
      if (answer !== 'stop') { process.stdout.write('resident left running\n'); return; }
    }
    await stopResident();
    process.stdout.write('resident stopped\n');
  } catch (error) {
    process.stderr.write(`matter resident stop: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
resident.command('logs').description('show recent resident output and errors').option('-n, --lines <count>', 'number of lines to show', '100').action(async (options: {lines: string}, command: Command) => {
  handledCommand = true;
  try {
    const count = Number(options.lines); if (!Number.isInteger(count) || count < 1 || count > 10_000) throw new Error('--lines must be an integer from 1 to 10000');
    const logs = residentLogs(await workspaceRoot(command), count);
    if (logs.output) process.stdout.write(`${logs.output}\n`);
    if (logs.errors) process.stderr.write(`${logs.errors}\n`);
    if (!logs.output && !logs.errors) process.stdout.write('resident logs are empty\n');
  } catch (error) {
    process.stderr.write(`matter resident logs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
resident.command('status').description('show resident process and connection status').action(async () => {
  handledCommand = true;
  try {
    process.stdout.write(`${JSON.stringify(await residentStatus(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`matter resident status: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});

await program.parseAsync(process.argv);
if (!handledCommand) {
  const options = program.opts<{workspace: string; plain?: boolean}>();

  if ((!process.stdin.isTTY || !process.stdout.isTTY) && process.env.MATTER_FORCE_TTY !== '1') {
    process.stderr.write('matter: the resident session requires an interactive terminal\nRun matter --help to list one-shot commands.\n');
    process.exit(2);
  }

  const workspace = await (launchAgentName
    ? findAgentWorkspace(launchAgentName, options.workspace)
    : findWorkspace(options.workspace)).catch(error => {
    process.stderr.write(`matter: invalid workspace: ${String(error)}\n`);
    process.exit(1);
  });

  if (!workspace) {
    process.stdout.write(launchAgentName
      ? `agent "${launchAgentName}" was not found\n\nExpected .matter/agents/${launchAgentName} below the current directory or your home directory.\n`
      : 'no Matter workspace here\n\nstart with: matter setup\n');
    process.exit(4);
  }

  try {
    await openResidentSession(workspace, Boolean(options.plain));
  } catch (error) {
    process.stderr.write(`matter: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
