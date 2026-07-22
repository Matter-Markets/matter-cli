import {Command, Help} from 'commander';

const ansi = {
  accent: '\u001B[1;38;2;205;253;2m',
  strong: '\u001B[1;37m',
  muted: '\u001B[2m',
  reset: '\u001B[0m',
} as const;

function paint(open: string, value: string): string {
  return `${open}${value}${ansi.reset}`;
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(' ');
}

export class MatterHelp extends Help {
  private color = false;

  override prepareContext(context: {error?: boolean; helpWidth?: number; outputHasColors?: boolean}): void {
    super.prepareContext(context);
    this.color = context.outputHasColors === true;
  }

  private styled(open: string, value: string): string {
    return this.color ? paint(open, value) : value;
  }

  override styleTitle(value: string): string {
    return this.styled(ansi.accent, value.replace(/:$/, '').toUpperCase());
  }

  override styleCommandText(value: string): string {
    return this.styled(ansi.strong, value);
  }

  override styleOptionText(value: string): string {
    return this.styled(ansi.accent, value);
  }

  override styleSubcommandText(value: string): string {
    return this.styled(ansi.accent, value);
  }

  override styleArgumentText(value: string): string {
    return this.styled(ansi.strong, value);
  }

  override styleDescriptionText(value: string): string {
    return this.styled(ansi.muted, value);
  }

  override commandDescription(command: Command): string {
    return command.parent ? super.commandDescription(command) : '';
  }

  override commandUsage(command: Command): string {
    if (command.parent) return super.commandUsage(command);
    const indent = ' '.repeat('USAGE '.length);
    return `${command.name()} [agent-name] [options]\n${indent}${command.name()} <command> [options]`;
  }

  override formatHelp(command: Command, helper: Help): string {
    const body = super.formatHelp(command, helper).trimEnd();
    const path = commandPath(command);
    const next = !command.parent
      ? `Run ${path} <agent-name> to open its resident session.`
      : command.commands.length > 0
      ? `Run ${path} <command> --help for command details.`
      : null;

    if (command.parent) {
      return next ? `${body}\n\n${this.styleDescriptionText(next)}\n` : `${body}\n`;
    }

    const masthead = [
      this.styled(ansi.accent, 'MATTER'),
      this.styleDescriptionText(command.description()),
    ].join('\n');
    return next
      ? `${masthead}\n\n${body}\n\n${this.styleDescriptionText(next)}\n`
      : `${masthead}\n\n${body}\n`;
  }
}

export class MatterCommand extends Command {
  override createCommand(name?: string): Command {
    return new MatterCommand(name);
  }

  override createHelp(): Help {
    return new MatterHelp();
  }
}

function envForcesColor(): boolean | undefined {
  if (process.env.NO_COLOR || process.env.FORCE_COLOR === '0' || process.env.FORCE_COLOR === 'false') return false;
  if (process.env.FORCE_COLOR || process.env.CLICOLOR_FORCE !== undefined) return true;
  return undefined;
}

function streamHasColor(stream: NodeJS.WriteStream): boolean {
  if (process.argv.includes('--plain')) return false;
  return envForcesColor() ?? Boolean(stream.isTTY && stream.hasColors?.());
}

export function configureMatterOutput(command: Command): void {
  command.configureOutput({
    getOutHasColors: () => streamHasColor(process.stdout),
    getErrHasColors: () => streamHasColor(process.stderr),
  });
}
