import {describe, expect, it} from 'vitest';
import {MatterCommand} from './help.js';

function fixture(): MatterCommand {
  const program = new MatterCommand()
    .name('matter')
    .description('The harness for agents in the real world.')
    .argument('[agent-name]', 'agent whose resident session should open')
    .option('--plain', 'disable color');
  program.command('resident').description('manage the resident');
  return program;
}

describe('MatterHelp', () => {
  it('renders a branded, scannable root menu without ANSI in plain output', () => {
    const program = fixture();
    program.configureOutput({getOutHasColors: () => false});

    const output = program.helpInformation();
    expect(output).toContain('MATTER\nThe harness for agents in the real world.');
    expect(output).toContain('USAGE matter [agent-name] [options]');
    expect(output).toContain('matter <command> [options]');
    expect(output).toContain('ARGUMENTS');
    expect(output).toContain('COMMANDS');
    expect(output).toContain('resident');
    expect(output).toContain('Run matter <agent-name> to open its resident session.');
    expect(output).not.toMatch(/\u001B\[/);
  });

  it('uses the Matter accent only when the output supports color', () => {
    const program = fixture();
    program.configureOutput({getOutHasColors: () => true});

    const output = program.helpInformation();
    expect(output).toContain('\u001B[1;38;2;205;253;2mMATTER\u001B[0m');
    expect(output).toContain('\u001B[2mThe harness for agents in the real world.\u001B[0m');
  });
});
