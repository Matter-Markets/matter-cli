import {timingSafeEqual} from 'node:crypto';
import {createServer, type Server, type Socket} from 'node:net';
import {chmod, unlink} from 'node:fs/promises';
import {z} from 'zod';
import {defaultSocketPath} from '../resident-client.js';
import {ResidentRuntime} from './resident.js';

const requestSchema = z.object({id: z.string(), method: z.string(), params: z.unknown()});

export class ResidentDaemon {
  readonly server: Server;
  readonly clients = new Set<Socket>();
  readonly #authenticated = new Set<Socket>();
  #controller: Socket | null = null;
  #stopping = false;

  constructor(readonly runtime: ResidentRuntime, readonly socketPath = defaultSocketPath(), readonly authToken: string, readonly onStop: () => void = () => process.exit(0)) {
    this.server = createServer(socket => this.#connect(socket));
    runtime.subscribe(event => this.#broadcast({event}));
  }

  async listen(): Promise<void> {
    if (process.platform !== 'win32') await unlink(this.socketPath).catch(error => { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; });
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      const options = process.platform === 'win32' ? {path: this.socketPath, readableAll: false, writableAll: false} : {path: this.socketPath};
      this.server.listen(options, () => { this.server.off('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    if (this.#stopping) return; this.#stopping = true; await this.runtime.close();
    for (const client of this.clients) client.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    if (process.platform !== 'win32') await unlink(this.socketPath).catch(() => undefined);
  }

  #connect(socket: Socket): void {
    this.clients.add(socket); socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', (chunk: string) => { buffer += chunk; while (true) { const newline = buffer.indexOf('\n'); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line.trim()) void this.#handle(socket, line); } });
    socket.on('close', () => { this.clients.delete(socket); this.#authenticated.delete(socket); if (this.#controller === socket) this.#controller = null; }); socket.on('error', () => undefined);
  }

  async #handle(socket: Socket, line: string): Promise<void> {
    let id = 'invalid';
    try {
      const request = requestSchema.parse(JSON.parse(line)); id = request.id;
      if (request.method === 'daemon.authenticate') {
        const params = z.object({token: z.string()}).parse(request.params);
        const supplied = Buffer.from(params.token); const expected = Buffer.from(this.authToken);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('resident authentication failed');
        this.#authenticated.add(socket); if (!this.#controller) this.#controller = socket;
        return this.#reply(socket, id, {controller: socket === this.#controller});
      }
      if (!this.#authenticated.has(socket)) throw new Error('resident authentication required');
      if (request.method === 'session.snapshot') return this.#reply(socket, id, this.runtime.snapshot());
      if (request.method === 'session.detach') { this.#reply(socket, id, null); socket.end(); return; }
      // Process lifecycle is an authenticated local control operation, not a TUI-controller mutation.
      if (request.method === 'daemon.stop') { this.#reply(socket, id, null); setImmediate(() => void this.close().finally(this.onStop)); return; }
      if (socket !== this.#controller) throw new Error('this is a read-only attachment; detach the controlling session first');
      if (request.method === 'session.message') { const params = z.object({message: z.string()}).parse(request.params); await this.runtime.sendMessage(params.message); return this.#reply(socket, id, null); }
      if (request.method === 'session.command') { const params = z.object({command: z.any()}).parse(request.params); await this.runtime.command(params.command); return this.#reply(socket, id, null); }
      throw new Error(`unknown daemon method ${request.method}`);
    } catch (error) { this.#reply(socket, id, undefined, error instanceof Error ? error.message : String(error)); }
  }

  #reply(socket: Socket, id: string, result?: unknown, error?: string): void { socket.write(JSON.stringify(error ? {id, error: {message: error}} : {id, result}) + '\n'); }
  #broadcast(value: unknown): void { const line = JSON.stringify(value) + '\n'; for (const client of this.#authenticated) client.write(line); }
}
