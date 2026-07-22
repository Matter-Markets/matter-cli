import {createConnection, type Socket} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {daemonToken} from './runtime/daemon-auth.js';
import {
  residentSnapshotSchema,
  type ResidentSnapshot,
  type SessionCommand,
  type SessionEvent,
} from './domain.js';

const responseSchema = z.object({
  id: z.string(),
  result: z.unknown().optional(),
  error: z.object({message: z.string()}).optional(),
});

const eventSchema = z.object({
  event: z.union([
    z.object({type: z.literal('snapshot'), snapshot: residentSnapshotSchema}),
    z.object({
      type: z.literal('chat.append'),
      item: z.object({
        id: z.string(),
        kind: z.enum(['user', 'agent', 'system', 'tool', 'result', 'external']),
        text: z.string(),
        timestamp: z.string(),
        status: z.enum(['pending', 'success', 'error']).optional(),
      }),
    }),
    z.object({type: z.literal('error'), message: z.string(), fix: z.string().optional()}),
  ]),
});

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export interface ResidentSession {
  snapshot(): Promise<ResidentSnapshot>;
  sendMessage(message: string): Promise<void>;
  command(command: SessionCommand): Promise<void>;
  detach(): Promise<void>;
  stopDaemon(): Promise<void>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

export function defaultSocketPath(): string {
  const configured = process.env.MATTER_DAEMON_SOCKET;
  if (configured) return configured;
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\matterd'
    : path.join(os.homedir(), '.matter', 'daemon.sock');
}

export class SocketResidentSession implements ResidentSession {
  readonly #socket: Socket;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  #buffer = '';

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#read(chunk));
    socket.on('error', error => this.#failPending(error));
    socket.on('close', () => this.#failPending(new Error('resident connection closed')));
  }

  static async connect(socketPath = defaultSocketPath(), timeoutMs = 350, token?: string): Promise<SocketResidentSession> {
    const connected = await new Promise<SocketResidentSession>((resolve, reject) => {
      const socket = createConnection(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`resident unavailable at ${socketPath}`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new SocketResidentSession(socket));
      });
      socket.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    try {
      await connected.#request('daemon.authenticate', {token: token ?? await daemonToken()});
      return connected;
    } catch (error) {
      connected.#socket.destroy();
      throw error;
    }
  }

  async snapshot(): Promise<ResidentSnapshot> {
    return residentSnapshotSchema.parse(await this.#request('session.snapshot', {}));
  }

  async sendMessage(message: string): Promise<void> {
    await this.#request('session.message', {message});
  }

  async command(command: SessionCommand): Promise<void> {
    await this.#request('session.command', {command});
  }

  async detach(): Promise<void> {
    try {
      await this.#request('session.detach', {});
    } finally {
      this.#socket.end();
    }
  }

  async stopDaemon(): Promise<void> {
    try { await this.#request('daemon.stop', {}); } finally { this.#socket.end(); }
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {resolve, reject});
      this.#socket.write(`${JSON.stringify({id, method, params})}\n`, error => {
        if (error) {
          this.#pending.delete(id);
          reject(error);
        }
      });
    });
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        const eventResult = eventSchema.safeParse(value);
        if (eventResult.success) {
          for (const listener of this.#listeners) listener(eventResult.data.event);
          continue;
        }
        const response = responseSchema.parse(value);
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        this.#pending.delete(response.id);
        if (response.error) pending.reject(new Error(response.error.message));
        else pending.resolve(response.result);
      } catch (error) {
        for (const listener of this.#listeners) {
          listener({type: 'error', message: `invalid resident message: ${String(error)}`});
        }
      }
    }
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
