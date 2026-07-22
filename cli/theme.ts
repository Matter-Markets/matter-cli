export const theme = {
  accent: '#CDFD02',
  highlight: '#CCFF00',
  error: 'red',
  muted: 'gray',
  data: 'white',
} as const;

export interface Glyphs {
  mark: string;
  live: string;
  user: string;
  agent: string;
  tool: string;
  success: string;
  error: string;
  ellipsis: string;
}

export function glyphs(unicode: boolean): Glyphs {
  return unicode
    ? {mark: '▲▲', live: '●', user: '›', agent: '›', tool: '⛭', success: '✓', error: '×', ellipsis: '…'}
    : {mark: '/\\/\\', live: '*', user: '>', agent: '>', tool: '#', success: '+', error: 'x', ellipsis: '...'};
}

export function terminalSupportsUnicode(): boolean {
  if (process.env.MATTER_ASCII === '1' || process.env.TERM === 'dumb') return false;
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI === 'ON');
}
