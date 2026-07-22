import {randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {SocketResidentSession} from '../resident-client.js';
import {createModelAdapter} from './adapters.js';
import {MemoryCredentialStore} from './credentials.js';
import {ResidentDaemon} from './daemon.js';
import {runCapabilityProbe} from './probe.js';
import {ResidentRuntime} from './resident.js';
import {modelConfigSchema} from './types.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { while (close.length) await close.pop()?.(); });

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{url: string; close: () => Promise<void>}> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test server address'));
      resolve({url: `http://127.0.0.1:${address.port}`, close: () => new Promise(done => server.close(() => done()))});
    });
  });
}

async function body(request: IncomingMessage): Promise<any> {
  let value = ''; for await (const chunk of request) value += String(chunk); return JSON.parse(value || '{}');
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify(value));
}

describe('resident daemon integration', () => {
  it('runs a probed model wake through the real socket protocol and emits the agent reply', async () => {
    const harness = await listen((request, response) => {
      const route = request.url ?? '';
      if (route === '/v1/agents/socket-agent') return json(response, {id: 1, paused: false});
      if (route === '/v1/agents/socket-agent/portfolio') return json(response, {quoteBalance: '100000000', equityUsdg: '100000000', holdings: []});
      if (route === '/v1/onboarding/onboard-1') return json(response, {state: 'live', boundaries: {assets: [], maxTradeUsdg: '25000000', dailyCapUsdg: '100000000', sessionExpiry: '18446744073709551615'}});
      response.writeHead(404); response.end();
    });
    close.push(harness.close);

    const provider = await listen((request, response) => {
      void body(request).then(payload => {
        const probing = payload.tools?.some((tool: any) => tool.function?.name === 'matter_capability_probe');
        const hasProbeResult = payload.messages?.some((message: any) => message.role === 'tool' && message.content?.includes('123.45'));
        response.writeHead(200, {'content-type': 'text/event-stream'});
        if (probing && !hasProbeResult) {
          const challenge = /exactly ([a-f0-9]{32})/.exec(payload.messages.at(-1).content)?.[1];
          response.write(`data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: 'probe-call', function: {name: 'matter_capability_probe', arguments: JSON.stringify({challenge})}}]}, finish_reason: 'tool_calls'}]})}\n\n`);
        } else if (probing) {
          const challenge = JSON.parse(payload.messages.find((message: any) => message.role === 'tool').content).challenge;
          response.write(`data: ${JSON.stringify({choices: [{delta: {content: `MATTER_PROBE_OK:${challenge}:123.45`}, finish_reason: 'stop'}]})}\n\n`);
        } else {
          response.write(`data: ${JSON.stringify({choices: [{delta: {content: 'Resident online.'}, finish_reason: 'stop'}]})}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      });
    });
    close.push(provider.close);

    const root = await mkdtemp(path.join(os.tmpdir(), 'matter-daemon-'));
    await mkdir(path.join(root, '.matter'), {recursive: true});
    const config = modelConfigSchema.parse({adapter: 'openai-compatible', model: 'local-frontier', base_url: `${provider.url}/v1`, daily_model_budget_usd: 0, heartbeat_minutes: 0});
    await writeFile(path.join(root, 'matter.toml'), `[agent]\nname = "socket-agent"\n\n[network]\napi = "${harness.url}/v1"\nrpc = "http://127.0.0.1:1"\nchain_id = 4663\n\n[model]\nadapter = "openai-compatible"\nmodel = "local-frontier"\nbase_url = "${provider.url}/v1"\ndaily_model_budget_usd = 0\nheartbeat_minutes = 0\n`);
    await writeFile(path.join(root, 'MATTER.md'), '# Socket Agent\n\nReport clearly.\n');
    await writeFile(path.join(root, '.matter', 'onboarding.json'), JSON.stringify({id: 'onboard-1', api: `${harness.url}/v1`, name: 'socket-agent', agentKey: `0x${'11'.repeat(20)}`}));
    const credentials = new MemoryCredentialStore();
    const created = await createModelAdapter(config, credentials);
    await runCapabilityProbe(created.adapter, config, root);
    const runtime = await ResidentRuntime.create(root, credentials);
    const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\matter-test-${randomUUID()}` : path.join(root, '.matter', 'runtime.sock');
    const token = Buffer.alloc(32, 7).toString('base64url');
    const daemon = new ResidentDaemon(runtime, socketPath, token, () => undefined);
    await daemon.listen(); close.push(() => daemon.close());
    await expect(SocketResidentSession.connect(socketPath, 2_000, Buffer.alloc(32, 8).toString('base64url'))).rejects.toThrow('authentication failed');
    const session = await SocketResidentSession.connect(socketPath, 2_000, token); close.push(() => session.detach().catch(() => undefined));
    const observer = await SocketResidentSession.connect(socketPath, 2_000, token); close.push(() => observer.detach().catch(() => undefined));
    await expect(observer.sendMessage('mutate')).rejects.toThrow('read-only attachment');
    const sleeping = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('resident state timeout')), 3_000);
      session.subscribe(event => {
        if (event.type === 'snapshot' && event.snapshot.agent.status === 'sleeping') { clearTimeout(timer); resolve(); }
      });
    });
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('agent reply timeout')), 3_000);
      session.subscribe(event => {
        if (event.type === 'chat.append' && event.item.kind === 'agent') { clearTimeout(timer); resolve(event.item.text); }
      });
    });
    await session.sendMessage('Are you running?');
    await expect(reply).resolves.toBe('Resident online.');
    await sleeping;
    const snapshot = await session.snapshot();
    expect(snapshot.agent).toMatchObject({name: 'socket-agent', status: 'sleeping'});
    expect(snapshot.network.connected).toBe(true);
    expect(snapshot.chat.some(item => item.text === 'Resident online.')).toBe(true);
    await session.command({name: 'clear'});
    expect((await session.snapshot()).chat).toEqual([]);
    await expect(observer.stopDaemon()).resolves.toBeUndefined();
  });
});
