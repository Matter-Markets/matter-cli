import {openSync, mkdirSync, readFileSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {SocketResidentSession} from '../resident-client.js';
import {loadRuntimeWorkspaceConfig} from './config.js';
import {PlatformCredentialStore} from './credentials.js';

export async function startResident(workspace: string): Promise<{pid: number; snapshot: unknown}> {
  const expected = (await loadRuntimeWorkspaceConfig(workspace)).agentName;
  try {
    const existing = await SocketResidentSession.connect(undefined, 300); const snapshot = await existing.snapshot(); await existing.detach();
    if (snapshot.agent.name !== expected) throw new Error(`matterd is already serving ${snapshot.agent.name}`);
    return {pid: 0, snapshot};
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('matterd is already')) throw error;
  }
  const runtimeDirectory = path.join(workspace, '.matter', 'runtime'); mkdirSync(runtimeDirectory, {recursive: true, mode: 0o700});
  const output = openSync(path.join(runtimeDirectory, 'matterd.log'), 'a', 0o600); const errors = openSync(path.join(runtimeDirectory, 'matterd.error.log'), 'a', 0o600);
  const binary = fileURLToPath(new URL('../matterd.js', import.meta.url));
  const storedPassphrase = process.env.MATTER_KEY_PASSPHRASE ?? await new PlatformCredentialStore().get(`matter/agent/${expected}/keystore-passphrase`);
  const child = spawn(process.execPath, [binary, '--workspace', workspace], {cwd: workspace, detached: true, windowsHide: true, stdio: ['ignore', output, errors],
    env: {...process.env, ...(storedPassphrase ? {MATTER_KEY_PASSPHRASE: storedPassphrase} : {})}});
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 125));
    try { const session = await SocketResidentSession.connect(undefined, 250); const snapshot = await session.snapshot(); await session.detach(); return {pid: child.pid ?? 0, snapshot}; } catch { /* keep waiting */ }
  }
  let detail = ''; try { detail = readFileSync(path.join(runtimeDirectory, 'matterd.error.log'), 'utf8').trim().split('\n').slice(-5).join('\n'); } catch { /* ignore */ }
  throw new Error(`matterd failed to start${detail ? `: ${detail}` : ''}`);
}

async function assertNoPendingTransactions(workspace: string): Promise<void> {
  const directory = path.join(workspace, '.matter', 'runtime', 'pending');
  const files = await readdir(directory).catch(error => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  if (files.length > 0) throw new Error(`refusing to restart: ${files.length} signed transaction${files.length === 1 ? ' is' : 's are'} pending recovery`);
}

async function waitForResidentExit(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const probe = await SocketResidentSession.connect(undefined, 125);
      await probe.detach().catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 125));
    } catch {
      return;
    }
  }
  throw new Error('matterd did not stop within 5 seconds');
}

export async function stopResident(): Promise<void> {
  const session = await SocketResidentSession.connect();
  await session.stopDaemon();
}

export async function restartResident(workspace: string): Promise<{pid: number; snapshot: unknown; restarted: boolean}> {
  const expected = (await loadRuntimeWorkspaceConfig(workspace)).agentName;
  let running = false;
  try {
    const session = await SocketResidentSession.connect(undefined, 500);
    const snapshot = await session.snapshot();
    if (snapshot.agent.name !== expected) {
      await session.detach();
      throw new Error(`matterd is serving ${snapshot.agent.name}, not ${expected}`);
    }
    await assertNoPendingTransactions(workspace);
    running = true;
    await session.stopDaemon();
    await waitForResidentExit();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('matterd is serving')) throw error;
    if (running) throw error;
  }
  const started = await startResident(workspace);
  return {...started, restarted: running};
}

export async function residentStatus(): Promise<unknown> { const session = await SocketResidentSession.connect(); try { return await session.snapshot(); } finally { await session.detach(); } }
export function residentLogs(workspace: string, count = 100): {output: string; errors: string} {
  const tail = (filename: string) => {
    try { return readFileSync(path.join(workspace, '.matter', 'runtime', filename), 'utf8').trimEnd().split(/\r?\n/).slice(-count).join('\n'); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error; }
  };
  return {output: tail('matterd.log'), errors: tail('matterd.error.log')};
}
