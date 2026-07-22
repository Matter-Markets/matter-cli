import React from 'react';
import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';
import {App} from './App.js';
import type {ChatItem, ResidentSnapshot, SessionEvent} from './domain.js';
import type {ResidentSession} from './resident-client.js';
import {theme} from './theme.js';

const snapshot: ResidentSnapshot = {
  revision: 19,
  agent: {
    name: 'volt-runner',
    id: '0047',
    status: 'resident',
    lastWakeAt: '2026-07-22T14:02:00.000Z',
  },
  network: {name: 'papernet', papernet: true, connected: true},
  portfolio: {
    equityUsdg: '549.99',
    epochReturnBps: 180,
    holdings: [
      {symbol: 'NVDA', allocationBps: 4100, valueUsdg: '225.50'},
      {symbol: 'AAPL', allocationBps: 2200, valueUsdg: '121.00'},
      {symbol: 'USDG', allocationBps: 3700, valueUsdg: '203.49'},
    ],
  },
  boundaries: {
    assetCount: 4,
    maxTradeUsdg: '50',
    dailyCapUsdg: '200',
    dailyUsedBps: 2100,
    paused: false,
    sessionExpiresAt: null,
  },
  lastWake: {reason: 'heartbeat', toolCalls: 2, trades: 0, statusPosted: true},
  pendingApprovals: 1,
  chat: [
    {id: '1', kind: 'system', text: 'volt-runner is resident on PAPERNET', timestamp: '2026-07-22T13:00:00.000Z'},
    {id: '2', kind: 'user', text: 'why are we heavy NVDA?', timestamp: '2026-07-22T14:01:00.000Z'},
    {id: '3', kind: 'tool', text: 'matter_get_portfolio {}', timestamp: '2026-07-22T14:01:01.000Z', status: 'pending'},
    {id: '4', kind: 'result', text: 'equity 549.99 USDG · NVDA allocation 41%', timestamp: '2026-07-22T14:01:02.000Z', status: 'success'},
    {id: '5', kind: 'agent', text: 'The position is within the current harness caps.', timestamp: '2026-07-22T14:02:00.000Z'},
  ],
};

const now = new Date('2026-07-22T14:34:00.000Z');

function sessionHarness(messageTimestamp = () => now.toISOString()) {
  const listeners = new Set<(event: SessionEvent) => void>();
  let sequence = 0;
  let latestItem: ChatItem | null = null;
  const emit = (event: SessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  const sendMessage = vi.fn(async (message: string) => {
    latestItem = {id: `remote-${++sequence}`, kind: 'user', text: message, timestamp: messageTimestamp()};
    emit({type: 'chat.append', item: latestItem});
  });
  const session: ResidentSession = {
    snapshot: async () => snapshot,
    sendMessage,
    command: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    stopDaemon: vi.fn(async () => {}),
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {session, emit, sendMessage, latestItem: () => latestItem};
}

describe('Matter session frame', () => {
  it('accepts editable composer input', async () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    view.stdin.write('trim above 35%');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('trim above 35%');
  });

  it('renders a submitted resident message exactly once across append and snapshot events', async () => {
    const harness = sessionHarness();
    const view = render(
      <App initialSnapshot={snapshot} session={harness.session} interactive width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    view.stdin.write('hello immutable');
    view.stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(view.lastFrame()!.match(/hello immutable/g)).toHaveLength(1);

    const item = harness.latestItem();
    if (!item) throw new Error('resident message was not emitted');
    harness.emit({type: 'snapshot', snapshot: {...snapshot, revision: snapshot.revision + 1, chat: [...snapshot.chat, item]}});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(view.lastFrame()!.match(/hello immutable/g)).toHaveLength(1);
  });

  it('does not keep a slash command below messages sent afterward', async () => {
    const harness = sessionHarness(() => new Date().toISOString());
    const view = render(
      <App initialSnapshot={{...snapshot, chat: []}} session={harness.session} interactive width={120} height={40} unicode colorEnabled={false} now={now}/>,
    );
    view.stdin.write('/portfolio');
    view.stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 10));
    view.stdin.write('hello after slash');
    view.stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 20));

    const frame = view.lastFrame()!;
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    expect(frame).toContain('/portfolio');
    expect(frame).toContain('hello after slash');
    expect(frame.indexOf('hello after slash')).toBeGreaterThan(frame.indexOf('/portfolio'));
  });

  it('clears the visible resident chat without detaching the session', async () => {
    const harness = sessionHarness();
    const view = render(
      <App initialSnapshot={snapshot} session={harness.session} interactive width={120} height={40} unicode colorEnabled={false} now={now}/>,
    );
    expect(view.lastFrame()).toContain('The position is within the current harness caps.');
    view.stdin.write('/clear');
    view.stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(harness.session.command).toHaveBeenCalledWith({name: 'clear'});
    expect(harness.session.detach).not.toHaveBeenCalled();
    expect(view.lastFrame()).not.toContain('The position is within the current harness caps.');
  });

  it('scrolls chat history independently with PageUp and PageDown', async () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('The position is within the current harness caps.');
    view.stdin.write('\u001B[5~');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('why are we heavy NVDA?');
    expect(view.lastFrame()).toContain('scrollback');
    view.stdin.write('\u001B[6~');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('The position is within the current harness caps.');
  });

  it('keeps the scrollback anchor when live events arrive', async () => {
    const harness = sessionHarness();
    const view = render(
      <App initialSnapshot={snapshot} session={harness.session} interactive width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    view.stdin.write('\u001B[5~');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('why are we heavy NVDA?');

    harness.emit({type: 'chat.append', item: {id: 'new-agent', kind: 'agent', text: 'new activity at the bottom', timestamp: now.toISOString()}});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain('why are we heavy NVDA?');
    expect(view.lastFrame()).not.toContain('new activity at the bottom');
    expect(view.lastFrame()).toContain('scrollback');
  });

  it('keeps the frame bounded while paging through long messages', async () => {
    const busySnapshot: ResidentSnapshot = {
      ...snapshot,
      chat: Array.from({length: 24}, (_, index) => ({
        id: `long-${index}`,
        kind: index % 2 === 0 ? 'user' as const : 'agent' as const,
        text: `message ${index} ${'portfolio risk context '.repeat(12)}`,
        timestamp: now.toISOString(),
      })),
    };
    const view = render(
      <App initialSnapshot={busySnapshot} session={null} interactive width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    for (let index = 0; index < 5; index++) view.stdin.write('\u001B[5~');
    for (let index = 0; index < 5; index++) view.stdin.write('\u001B[6~');
    await new Promise(resolve => setTimeout(resolve, 30));
    const frame = view.lastFrame()!;
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    expect(frame).toContain('Ask your resident anything');
    expect(frame).toContain('MATTER');
  });

  it('renders double-asterisk emphasis as exact Matter neon without showing Markdown delimiters', () => {
    const emphasized: ResidentSnapshot = {
      ...snapshot,
      chat: [{id: 'emphasis', kind: 'agent', text: 'Watch **AAPL momentum** now.', timestamp: now.toISOString()}],
    };
    const view = render(
      <App initialSnapshot={emphasized} session={null} interactive={false} width={120} height={40} unicode colorEnabled now={now}/>,
    );
    const frame = view.lastFrame();
    expect(frame).toContain('AAPL momentum');
    expect(frame).not.toContain('**');
    expect(theme.highlight).toBe('#CCFF00');
  });

  it('renders tool activity as a compact trace while keeping raw data out of chat', () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive={false} width={120} height={40} unicode colorEnabled={false} now={now}/>,
    );
    const frame = view.lastFrame();
    expect(frame).toContain('Read portfolio');
    expect(frame).toContain('Portfolio refreshed');
    expect(frame).not.toContain('matter_get_portfolio {}');
    expect(frame).not.toContain('equity 549.99 USDG');
  });

  it('shows confirmed transactions with a Blockscout fallback URL', () => {
    const hash = `0x${'a'.repeat(64)}`;
    const tradeSnapshot: ResidentSnapshot = {
      ...snapshot,
      network: {...snapshot.network, name: 'robinhood', papernet: false},
      chat: [
        {id: 'trade-call', kind: 'tool', text: 'matter_trade {"asset":"NVDA","side":"buy","amount":"10","slippage_bps":50}', timestamp: now.toISOString(), status: 'pending'},
        {id: 'trade-result', kind: 'result', text: JSON.stringify({transaction: {hash}, broadcast: {hash, status: 'success'}}), timestamp: now.toISOString(), status: 'success'},
      ],
    };
    const view = render(
      <App initialSnapshot={tradeSnapshot} session={null} interactive={false} width={120} height={40} unicode colorEnabled={false} now={now}/>,
    );
    const frame = view.lastFrame();
    expect(frame).toContain(hash);
    expect(frame).toContain('https://robinhoodchain.blockscout.com/tx/');
  });

  it('never types mouse-wheel packets into the composer', async () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    view.stdin.write('\u001B[<64;20;8M');
    view.stdin.write('\u001B[<65;20;8M');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('Ask your resident anything, or type / for commands');
    expect(view.lastFrame()).not.toContain('[<64;20;8M');
    expect(view.lastFrame()).not.toContain('[<65;20;8M');
  });

  it('distinguishes Windows Backspace from the physical Delete key', async () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    view.stdin.write('abc');
    view.stdin.write('\u007F');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('ab');
    expect(view.lastFrame()).not.toContain('abc');
    view.stdin.write('\u0003');
    view.stdin.write('abc');
    view.stdin.write('\u001B[H');
    view.stdin.write('\u001B[3~');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('bc');
    expect(view.lastFrame()).not.toContain('abc');
  });

  it('supports Codex-style composer movement, deletion, yank, and history', async () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    view.stdin.write('world');
    await new Promise(resolve => setTimeout(resolve, 10));
    view.stdin.write('\u0001'); // Ctrl+A
    await new Promise(resolve => setTimeout(resolve, 10));
    view.stdin.write('hello ');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('hello world');
    view.stdin.write('\u0017'); // Ctrl+W
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('world');
    expect(view.lastFrame()).not.toContain('hello world');
    view.stdin.write('\u0019'); // Ctrl+Y
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('hello world');
    view.stdin.write('\u0003'); // Ctrl+C clears a non-empty draft
    await new Promise(resolve => setTimeout(resolve, 10));
    view.stdin.write('hello world');
    view.stdin.write('\u0015'); // Ctrl+U
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).not.toContain('hello world');
    view.stdin.write('\u0019'); // Ctrl+Y
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('hello world');
    view.stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 10));
    view.stdin.write('\u001B[A');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('hello world');
  });

  it('opens shortcut and raw transcript views and completes slash commands', async () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive width={120} height={40} unicode colorEnabled={false} now={now}/>,
    );
    view.stdin.write('?');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('keyboard shortcuts');
    view.stdin.write('\u001B');
    view.stdin.write('\u0014'); // Ctrl+T
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('transcript · raw');
    view.stdin.write('\u0014');
    view.stdin.write('/po');
    view.stdin.write('\t');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(view.lastFrame()).toContain('/portfolio');
  });

  it('renders the compact Unicode 80x24 golden frame without color', () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive={false} width={80} height={24} unicode colorEnabled={false} now={now}/>,
    );
    expect(view.lastFrame()).toMatchSnapshot();
  });

  it('renders the wide Unicode 120x40 golden frame', () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive={false} width={120} height={40} unicode colorEnabled={false} now={now}/>,
    );
    expect(view.lastFrame()).toMatchSnapshot();
  });

  it('renders an ASCII fallback with a persistent PAPERNET watermark', () => {
    const view = render(
      <App initialSnapshot={snapshot} session={null} interactive={false} width={80} height={24} unicode={false} colorEnabled={false} now={now}/>,
    );
    const frame = view.lastFrame();
    expect(frame).toMatchSnapshot();
    expect(frame).toContain('PAPERNET');
    expect(frame).toContain('/\\/\\ MATTER');
    expect(frame).not.toMatch(/\u001B\[/);
  });
});
