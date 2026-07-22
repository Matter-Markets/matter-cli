export const ROBINHOOD_BLOCKSCOUT = 'https://robinhoodchain.blockscout.com';

const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/;

export function transactionUrl(hash: string, explorer = process.env.MATTER_EXPLORER ?? ROBINHOOD_BLOCKSCOUT): string | null {
  if (!transactionHashPattern.test(hash)) return null;
  try {
    const origin = new URL(explorer);
    if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return null;
    return new URL(`/tx/${hash}`, origin).toString();
  } catch {
    return null;
  }
}

export function terminalHyperlink(label: string, url: string, enabled: boolean): string {
  if (!enabled) return label;
  return `\u001B]8;;${url}\u001B\\${label}\u001B]8;;\u001B\\`;
}

export function terminalSupportsHyperlinks(): boolean {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb' || process.env.MATTER_ASCII === '1') return false;
  if (process.env.FORCE_HYPERLINK === '0') return false;
  if (process.env.FORCE_HYPERLINK) return true;
  if (process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.VTE_VERSION || process.env.COLORTERM) return true;
  return /^xterm|^screen|^tmux/.test(process.env.TERM ?? '');
}
