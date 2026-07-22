import type {SessionCommand} from './domain.js';

export const helpText = [
  'SESSION COMMANDS',
  '',
  '  /portfolio       inspect live holdings and harness usage',
  '  /journal [n]     show the latest journal entries',
  '  /wake            wake the resident now',
  '  /pause           pause with owner authorization',
  '  /clear           clear the visible chat; journal and runtime state remain',
  '  /help            show this menu',
  '  /quit            detach; the resident keeps running',
  '',
  'KEYBOARD',
  '',
  '  ?                show keyboard shortcuts',
].join('\n');

export function parseSlashCommand(input: string): SessionCommand | null {
  const [rawName, rawArg, ...extra] = input.trim().split(/\s+/);
  if (!rawName?.startsWith('/')) return null;
  if (extra.length > 0) throw new Error(`too many arguments for ${rawName}`);

  switch (rawName) {
    case '/portfolio':
      if (rawArg) throw new Error('/portfolio takes no arguments');
      return {name: 'portfolio'};
    case '/journal': {
      if (!rawArg) return {name: 'journal', count: 10};
      const count = Number(rawArg);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new Error('/journal count must be between 1 and 100');
      }
      return {name: 'journal', count};
    }
    case '/wake':
    case '/pause':
    case '/clear':
    case '/help':
    case '/quit':
      if (rawArg) throw new Error(`${rawName} takes no arguments`);
      return {name: rawName.slice(1) as 'wake' | 'pause' | 'clear' | 'help' | 'quit'};
    default:
      throw new Error(`unknown command ${rawName}`);
  }
}
