import {afterEach, describe, expect, it} from 'vitest';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {findAgentWorkspace} from './workspace.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {recursive: true, force: true})));
});

describe('findAgentWorkspace', () => {
  it('finds a named agent in the nearest Matter agents directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'matter-agent-'));
    temporaryRoots.push(root);
    const project = path.join(root, 'project');
    const start = path.join(project, 'packages', 'client');
    const workspace = path.join(project, '.matter', 'agents', 'immutable');
    await mkdir(start, {recursive: true});
    await mkdir(workspace, {recursive: true});
    await writeFile(path.join(workspace, 'MATTER.md'), '# immutable\n');
    await writeFile(path.join(workspace, 'matter.toml'), '[agent]\nname = "immutable"\n');

    const found = await findAgentWorkspace('immutable', start);
    expect(found?.root).toBe(workspace);
    expect(found?.agentName).toBe('immutable');
  });

  it('rejects names that could escape the agents directory', async () => {
    await expect(findAgentWorkspace('../immutable')).rejects.toThrow('agent name must be');
  });
});
