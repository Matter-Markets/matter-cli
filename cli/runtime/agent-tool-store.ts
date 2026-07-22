import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

export interface MemoryRecord {id: string; text: string; tags: string[]; createdAt: string}
export interface ProjectRecord {id: string; title: string; summary: string; status: 'active' | 'blocked' | 'complete'; updatedAt: string}
export interface TodoRecord {id: string; text: string; completed: boolean; createdAt: string; completedAt: string | null}
export interface ReminderRecord {id: string; text: string; dueAt: string; completed: boolean; createdAt: string}
export interface ResearchRecord {id: string; title: string; source: string; content: string; createdAt: string}
export interface ApprovalRecord {id: string; kind: 'owner_question' | 'strategy_patch' | 'profile_update' | 'message'; payload: unknown; status: 'pending' | 'confirmed'; createdAt: string; confirmedAt: string | null}
export interface OutboxRecord {id: string; destination: string; message: string; createdAt: string; approvalId: string}

interface AgentToolState {
  version: 1;
  memories: MemoryRecord[];
  projects: ProjectRecord[];
  todos: TodoRecord[];
  reminders: ReminderRecord[];
  research: ResearchRecord[];
  approvals: ApprovalRecord[];
  outbox: OutboxRecord[];
}

const emptyState = (): AgentToolState => ({version: 1, memories: [], projects: [], todos: [], reminders: [], research: [], approvals: [], outbox: []});

export function lexicalScore(query: string, value: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(term => term.length > 1);
  const haystack = value.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export class AgentToolStore {
  readonly directory: string;
  readonly filename: string;
  #lock = Promise.resolve();

  constructor(readonly workspace: string, readonly now: () => Date = () => new Date()) {
    this.directory = path.join(workspace, '.matter', 'runtime');
    this.filename = path.join(this.directory, 'agent-tools.json');
  }

  async snapshot(): Promise<AgentToolState> { return structuredClone(await this.#read()); }

  async mutate<T>(operation: (state: AgentToolState) => T | Promise<T>): Promise<T> {
    const previous = this.#lock; let release!: () => void;
    this.#lock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const state = await this.#read();
      const result = await operation(state);
      state.memories = state.memories.slice(-1_000);
      state.projects = state.projects.slice(-200);
      state.todos = state.todos.slice(-1_000);
      state.reminders = state.reminders.slice(-1_000);
      state.research = state.research.slice(-200);
      state.approvals = state.approvals.slice(-500);
      state.outbox = state.outbox.slice(-500);
      await this.#write(state);
      return result;
    } finally { release(); }
  }

  id(): string { return randomUUID(); }
  timestamp(): string { return this.now().toISOString(); }

  async pendingApprovals(): Promise<number> {
    return (await this.#read()).approvals.filter(item => item.status === 'pending').length;
  }

  async #read(): Promise<AgentToolState> {
    try {
      const value = JSON.parse(await readFile(this.filename, 'utf8')) as Partial<AgentToolState>;
      return {
        version: 1,
        memories: Array.isArray(value.memories) ? value.memories : [],
        projects: Array.isArray(value.projects) ? value.projects : [],
        todos: Array.isArray(value.todos) ? value.todos : [],
        reminders: Array.isArray(value.reminders) ? value.reminders : [],
        research: Array.isArray(value.research) ? value.research : [],
        approvals: Array.isArray(value.approvals) ? value.approvals : [],
        outbox: Array.isArray(value.outbox) ? value.outbox : [],
      };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  async #write(state: AgentToolState): Promise<void> {
    await mkdir(this.directory, {recursive: true, mode: 0o700});
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), {encoding: 'utf8', mode: 0o600});
    await rename(temporary, this.filename);
  }
}
