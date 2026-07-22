import {createHash, randomUUID} from 'node:crypto';
import {appendFile, mkdir, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import type {SecretRedactor} from './redaction.js';

export interface JournalEntry {
  id: string; sequence: number; timestamp: string; type: string; wakeId: string | null;
  data: unknown; previousHash: string; hash: string;
}

function digest(value: Omit<JournalEntry, 'hash'>): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export class ResidentJournal {
  readonly directory: string;
  #sequence = 0;
  #previousHash = '0'.repeat(64);
  #ready: Promise<void>;
  #lock = Promise.resolve();

  constructor(readonly workspace: string, readonly redactor: SecretRedactor) {
    this.directory = path.join(workspace, 'journal');
    this.#ready = this.#loadAndVerify();
  }

  async append(type: string, data: unknown, wakeId: string | null = null): Promise<JournalEntry> {
    await this.#ready;
    return await this.#serial(async () => {
      const withoutHash = {
        id: randomUUID(), sequence: ++this.#sequence, timestamp: new Date().toISOString(), type, wakeId,
        data: this.redactor.value(data), previousHash: this.#previousHash,
      };
      const entry: JournalEntry = {...withoutHash, hash: digest(withoutHash)};
      await mkdir(this.directory, {recursive: true, mode: 0o700});
      const filename = path.join(this.directory, `${entry.timestamp.slice(0, 10)}.ndjson`);
      await appendFile(filename, JSON.stringify(entry) + '\n', {encoding: 'utf8', mode: 0o600});
      this.#previousHash = entry.hash;
      return entry;
    });
  }

  async latest(count: number): Promise<JournalEntry[]> {
    await this.#ready;
    let files: string[] = [];
    try { files = (await readdir(this.directory)).filter(file => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(file)).sort(); } catch { return []; }
    const entries: JournalEntry[] = [];
    for (const file of files) {
      const lines = (await readFile(path.join(this.directory, file), 'utf8')).trim().split('\n').filter(Boolean);
      for (const line of lines) entries.push(JSON.parse(line) as JournalEntry);
    }
    return entries.slice(-count);
  }

  async #loadAndVerify(): Promise<void> {
    const entries = await this.latestUnverified();
    let previous = '0'.repeat(64);
    let sequence = 0;
    for (const entry of entries) {
      const {hash, ...withoutHash} = entry;
      if (entry.previousHash !== previous || digest(withoutHash) !== hash || entry.sequence !== sequence + 1) throw new Error('resident journal integrity check failed');
      previous = hash; sequence = entry.sequence;
    }
    this.#previousHash = previous; this.#sequence = sequence;
  }

  async latestUnverified(): Promise<JournalEntry[]> {
    let files: string[] = [];
    try { files = (await readdir(this.directory)).filter(file => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(file)).sort(); } catch { return []; }
    const output: JournalEntry[] = [];
    for (const file of files) for (const line of (await readFile(path.join(this.directory, file), 'utf8')).split('\n').filter(Boolean)) output.push(JSON.parse(line) as JournalEntry);
    return output;
  }

  async #serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lock; let release!: () => void;
    this.#lock = new Promise<void>(resolve => { release = resolve; });
    await previous; try { return await operation(); } finally { release(); }
  }
}
