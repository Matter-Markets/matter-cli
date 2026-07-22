import {access, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'smol-toml';
import {z} from 'zod';

const configSchema = z.object({
  agent: z.object({name: z.string().min(1)}),
  model: z.object({
    adapter: z.string(),
    model: z.string(),
  }).partial().optional(),
}).passthrough();

export interface MatterWorkspace {
  root: string;
  agentName: string;
  strategyPath: string;
  configPath: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function workspaceAt(root: string): Promise<MatterWorkspace | null> {
  const strategyPath = path.join(root, 'MATTER.md');
  const configPath = path.join(root, 'matter.toml');
  if (!(await exists(strategyPath)) || !(await exists(configPath))) return null;
  const config = configSchema.parse(parse(await readFile(configPath, 'utf8')));
  return {root, agentName: config.agent.name, strategyPath, configPath};
}

export async function findWorkspace(start: string): Promise<MatterWorkspace | null> {
  let current = path.resolve(start);
  while (true) {
    const workspace = await workspaceAt(current);
    if (workspace) return workspace;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function findAgentWorkspace(name: string, start = process.cwd()): Promise<MatterWorkspace | null> {
  if (!/^[a-z0-9-]{3,20}$/.test(name)) {
    throw new Error('agent name must be 3-20 lowercase letters, numbers, or hyphens');
  }

  const nearby = await findWorkspace(start);
  if (nearby?.agentName === name) return nearby;

  const candidates: string[] = [];
  let current = path.resolve(start);
  while (true) {
    candidates.push(path.join(current, '.matter', 'agents', name));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  candidates.push(path.join(os.homedir(), '.matter', 'agents', name));

  const visited = new Set<string>();
  for (const candidate of candidates) {
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (visited.has(key)) continue;
    visited.add(key);
    const workspace = await workspaceAt(candidate);
    if (!workspace) continue;
    if (workspace.agentName !== name) {
      throw new Error(`agent directory ${candidate} belongs to ${workspace.agentName}`);
    }
    return workspace;
  }
  return null;
}
