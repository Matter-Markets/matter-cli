import {describe, expect, it} from 'vitest';
import {parseSlashCommand} from './commands.js';

describe('parseSlashCommand', () => {
  it('parses every launch command', () => {
    expect(parseSlashCommand('/portfolio')).toEqual({name: 'portfolio'});
    expect(parseSlashCommand('/journal')).toEqual({name: 'journal', count: 10});
    expect(parseSlashCommand('/journal 25')).toEqual({name: 'journal', count: 25});
    expect(parseSlashCommand('/wake')).toEqual({name: 'wake'});
    expect(parseSlashCommand('/pause')).toEqual({name: 'pause'});
    expect(parseSlashCommand('/clear')).toEqual({name: 'clear'});
    expect(parseSlashCommand('/help')).toEqual({name: 'help'});
    expect(parseSlashCommand('/quit')).toEqual({name: 'quit'});
  });

  it('rejects unknown commands and unsafe journal bounds', () => {
    expect(() => parseSlashCommand('/trade')).toThrow('unknown command');
    expect(() => parseSlashCommand('/journal 0')).toThrow('between 1 and 100');
    expect(() => parseSlashCommand('/journal 101')).toThrow('between 1 and 100');
    expect(() => parseSlashCommand('/pause now')).toThrow('takes no arguments');
  });

  it('does not mistake ordinary conversation for a command', () => {
    expect(parseSlashCommand('why are we heavy NVDA?')).toBeNull();
  });
});
