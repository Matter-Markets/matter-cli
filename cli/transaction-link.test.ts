import {describe, expect, it} from 'vitest';
import type {ChatItem} from './domain.js';
import {groupChatItems} from './chat-presentation.js';
import {ROBINHOOD_BLOCKSCOUT, terminalHyperlink, transactionUrl} from './transaction-link.js';

const hash = `0x${'a'.repeat(64)}`;

describe('transaction links', () => {
  it('extracts a confirmed transaction hash from a trade trace', () => {
    const items: ChatItem[] = [
      {id: 'call', kind: 'tool', text: 'matter_trade {"asset":"NVDA","side":"buy","amount":"10","slippage_bps":50}', timestamp: '2026-07-22T00:00:00.000Z', status: 'pending'},
      {id: 'result', kind: 'result', text: JSON.stringify({transaction: {hash}, broadcast: {hash, status: 'success'}}), timestamp: '2026-07-22T00:00:01.000Z', status: 'success'},
    ];

    expect(groupChatItems(items)).toMatchObject([{type: 'tool', status: 'success', transactionHash: hash}]);
  });

  it('builds the official Blockscout URL and a terminal-safe hyperlink', () => {
    const url = transactionUrl(hash);
    expect(url).toBe(`${ROBINHOOD_BLOCKSCOUT}/tx/${hash}`);
    expect(terminalHyperlink(hash, url!, true)).toBe(`\u001B]8;;${url}\u001B\\${hash}\u001B]8;;\u001B\\`);
    expect(terminalHyperlink(hash, url!, false)).toBe(hash);
    expect(transactionUrl('0x1234')).toBeNull();
  });
});
