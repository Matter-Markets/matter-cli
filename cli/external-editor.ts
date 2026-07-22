import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function splitCommand(value: string): string[] {
  return (value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
    .map(part => part.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'));
}

export async function editPromptExternally(initialValue: string): Promise<string> {
  const configured = process.env.VISUAL || process.env.EDITOR;
  if (!configured) throw new Error('external editor unavailable · set VISUAL or EDITOR');
  const [command, ...args] = splitCommand(configured);
  if (!command) throw new Error('external editor unavailable · VISUAL or EDITOR is empty');

  const file = path.join(os.tmpdir(), `matter-prompt-${randomUUID()}.md`);
  await writeFile(file, initialValue, {encoding: 'utf8', mode: 0o600});
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args, file], {stdio: 'inherit', windowsHide: false});
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`external editor exited ${code ?? 'without status'}`)));
    });
    return await readFile(file, 'utf8');
  } finally {
    await rm(file, {force: true});
  }
}
