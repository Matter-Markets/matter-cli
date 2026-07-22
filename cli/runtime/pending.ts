import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {mkdir, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {CredentialStore} from './types.js';

export interface PendingTransaction {
  id: string; wakeId: string; toolCallId: string; rawTransaction: `0x${string}`; hash: `0x${string}`;
  state: 'signed' | 'broadcast'; createdAt: string; broadcastAt?: string;
}

interface Envelope {version: 1; iv: string; tag: string; ciphertext: string}

export class PendingTransactionStore {
  readonly directory: string;
  readonly keyReference: string;
  #key: Promise<Buffer>;

  constructor(readonly workspace: string, credentials: CredentialStore) {
    this.directory = path.join(workspace, '.matter', 'runtime', 'pending');
    this.keyReference = `matter/system/pending/${Buffer.from(workspace).toString('base64url').slice(0, 64)}`;
    this.#key = this.#loadKey(credentials);
  }

  async save(value: PendingTransaction): Promise<void> {
    const key = await this.#key; const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const envelope: Envelope = {version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64')};
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const filename = this.#filename(value.id); const temporary = `${filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), {encoding: 'utf8', mode: 0o600}); await rename(temporary, filename);
  }

  async remove(id: string): Promise<void> { await unlink(this.#filename(id)).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }); }

  async list(): Promise<PendingTransaction[]> {
    let files: string[] = []; try { files = (await readdir(this.directory)).filter(file => file.endsWith('.json')); } catch { return []; }
    const key = await this.#key; const output: PendingTransaction[] = [];
    for (const file of files) {
      const envelope = JSON.parse(await readFile(path.join(this.directory, file), 'utf8')) as Envelope;
      if (envelope.version !== 1) throw new Error('unsupported pending transaction envelope');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      output.push(JSON.parse(plain.toString('utf8')) as PendingTransaction);
    }
    return output;
  }

  async #loadKey(credentials: CredentialStore): Promise<Buffer> {
    let value = await credentials.get(this.keyReference);
    if (!value) { value = randomBytes(32).toString('base64'); await credentials.put(this.keyReference, value); }
    const key = Buffer.from(value, 'base64'); if (key.length !== 32) throw new Error('invalid pending transaction encryption key'); return key;
  }

  #filename(id: string): string { return path.join(this.directory, `${id.replace(/[^a-zA-Z0-9-]/g, '')}.json`); }
}
