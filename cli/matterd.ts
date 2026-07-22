#!/usr/bin/env node
import path from 'node:path';
import {findWorkspace} from './workspace.js';
import {ResidentDaemon} from './runtime/daemon.js';
import {daemonToken} from './runtime/daemon-auth.js';
import {ResidentRuntime} from './runtime/resident.js';

const index = process.argv.indexOf('--workspace');
const requested = index >= 0 ? process.argv[index + 1] : process.cwd();
if (!requested) throw new Error('--workspace requires a path');
const workspace = await findWorkspace(path.resolve(requested));
if (!workspace) throw new Error('Matter workspace not found');
const runtime = await ResidentRuntime.create(workspace.root);
const daemon = new ResidentDaemon(runtime, undefined, await daemonToken());
const stop = () => void daemon.close().finally(() => process.exit(0));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
await daemon.listen();
process.stdout.write(`matterd listening · ${workspace.agentName}\n`);
