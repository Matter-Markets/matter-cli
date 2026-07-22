import {createHash} from 'node:crypto';
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {CredentialStore} from './types.js';

const REFERENCE = /^[a-zA-Z0-9._/-]{3,200}$/;

function validateReference(reference: string): void {
  if (!REFERENCE.test(reference) || reference.includes('..')) throw new Error('invalid credential reference');
}

function run(program: string, args: string[], stdin = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${program} failed${stderr.trim() ? `: ${stderr.trim()}` : ''}`)));
    child.stdin.end(stdin);
  });
}

export class MemoryCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  async get(reference: string): Promise<string | null> { return this.values.get(reference) ?? null; }
  async put(reference: string, secret: string): Promise<void> { this.values.set(reference, secret); }
  async delete(reference: string): Promise<void> { this.values.delete(reference); }
}

export class PlatformCredentialStore implements CredentialStore {
  readonly root: string;

  constructor(root = path.join(os.homedir(), '.matter', 'credentials')) {
    this.root = root;
  }

  async get(reference: string): Promise<string | null> {
    validateReference(reference);
    if (reference.startsWith('env:')) return process.env[reference.slice(4)] ?? null;
    try {
      if (process.platform === 'win32') {
        const encrypted = await readFile(this.#filename(reference), 'utf8');
        const script = 'Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v);$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))';
        return await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], encrypted);
      }
      if (process.platform === 'darwin') {
        return (await run('/usr/bin/security', ['find-generic-password', '-a', reference, '-s', 'com.matter.cli', '-w'])).replace(/\r?\n$/, '');
      }
      return (await run('secret-tool', ['lookup', 'service', 'matter', 'account', reference])).replace(/\r?\n$/, '') || null;
    } catch (error) {
      if (error instanceof Error && /ENOENT|could not be found|not found|failed/i.test(error.message)) return null;
      throw error;
    }
  }

  async put(reference: string, secret: string): Promise<void> {
    validateReference(reference);
    if (reference.startsWith('env:')) throw new Error('environment credential references cannot be written');
    if (!secret) throw new Error('credential cannot be empty');
    if (process.platform === 'win32') {
      const script = 'Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))';
      const encrypted = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], secret);
      await mkdir(this.root, {recursive: true, mode: 0o700});
      await writeFile(this.#filename(reference), encrypted, {encoding: 'utf8', mode: 0o600});
      return;
    }
    if (process.platform === 'darwin') {
      // macOS security has no stdin form for replacement; spawn avoids shell interpolation.
      await run('/usr/bin/security', ['add-generic-password', '-U', '-a', reference, '-s', 'com.matter.cli', '-w', secret]);
      return;
    }
    await run('secret-tool', ['store', '--label=Matter model credential', 'service', 'matter', 'account', reference], secret);
  }

  async delete(reference: string): Promise<void> {
    validateReference(reference);
    if (reference.startsWith('env:')) return;
    if (process.platform === 'win32') {
      await unlink(this.#filename(reference)).catch(error => {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      });
    } else if (process.platform === 'darwin') {
      await run('/usr/bin/security', ['delete-generic-password', '-a', reference, '-s', 'com.matter.cli']).catch(() => undefined);
    } else {
      await run('secret-tool', ['clear', 'service', 'matter', 'account', reference]).catch(() => undefined);
    }
  }

  #filename(reference: string): string {
    return path.join(this.root, `${createHash('sha256').update(reference).digest('hex')}.dpapi`);
  }
}

export function modelCredentialReference(agent: string, adapter: string): string {
  return `matter/model/${agent}/${adapter}`;
}
