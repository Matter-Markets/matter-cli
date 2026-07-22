import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {ModelConfig, ModelRequest} from './types.js';

interface Ledger {date: string; inputTokens: number; outputTokens: number; costUsd: number; reservations: Record<string, number>}

function utcDate(): string { return new Date().toISOString().slice(0, 10); }
function cost(config: ModelConfig, input: number, output: number): number {
  return input / 1_000_000 * (config.input_usd_per_million ?? 0) + output / 1_000_000 * (config.output_usd_per_million ?? 0);
}

export class ModelBudget {
  readonly filename: string;
  #lock = Promise.resolve();

  constructor(readonly root: string, readonly config: ModelConfig) {
    this.filename = path.join(root, '.matter', 'runtime', 'model-usage.json');
  }

  estimateInput(request: Omit<ModelRequest, 'signal'>): number {
    return Math.max(1, Math.ceil((request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length) / 4));
  }

  async reserve(request: Omit<ModelRequest, 'signal'>): Promise<{id: string; estimatedInput: number; reservedCost: number}> {
    const estimatedInput = this.estimateInput(request);
    const reservedCost = cost(this.config, estimatedInput, request.maxOutputTokens);
    const id = randomUUID();
    await this.#serial(async () => {
      const ledger = await this.#read();
      const committed = ledger.costUsd + Object.values(ledger.reservations).reduce((sum, value) => sum + value, 0);
      if (this.config.daily_model_budget_usd > 0 && committed + reservedCost > this.config.daily_model_budget_usd + 1e-9) {
        throw new Error(`daily model budget exhausted (${committed.toFixed(4)} / ${this.config.daily_model_budget_usd.toFixed(2)} USD reserved or spent)`);
      }
      ledger.reservations[id] = reservedCost;
      await this.#write(ledger);
    });
    return {id, estimatedInput, reservedCost};
  }

  async commit(reservation: {id: string; estimatedInput: number}, usage: {inputTokens: number; outputTokens: number} | null): Promise<void> {
    await this.#serial(async () => {
      const ledger = await this.#read();
      const reserved = ledger.reservations[reservation.id];
      if (reserved === undefined) return;
      delete ledger.reservations[reservation.id];
      if (usage) {
        ledger.inputTokens += usage.inputTokens;
        ledger.outputTokens += usage.outputTokens;
        ledger.costUsd += cost(this.config, usage.inputTokens, usage.outputTokens);
      } else {
        ledger.inputTokens += reservation.estimatedInput;
        ledger.outputTokens += this.config.max_output_tokens;
        ledger.costUsd += reserved;
      }
      await this.#write(ledger);
    });
  }

  async snapshot(): Promise<Ledger> { return await this.#read(); }

  async #read(): Promise<Ledger> {
    try {
      const value = JSON.parse(await readFile(this.filename, 'utf8')) as Ledger;
      if (value.date === utcDate()) return value;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    return {date: utcDate(), inputTokens: 0, outputTokens: 0, costUsd: 0, reservations: {}};
  }

  async #write(value: Ledger): Promise<void> {
    await mkdir(path.dirname(this.filename), {recursive: true, mode: 0o700});
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {encoding: 'utf8', mode: 0o600});
    await rename(temporary, this.filename);
  }

  async #serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}
