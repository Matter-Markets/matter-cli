import React from 'react';
import {render} from 'ink';
import {App} from '../dist/App.js';

const now = new Date();
const snapshot = {
  revision: 1,
  agent: {name: 'matter-agent', id: '0001', status: 'resident', lastWakeAt: now.toISOString()},
  network: {name: 'robinhood', papernet: false, connected: true},
  portfolio: {equityUsdg: '100.00', epochReturnBps: 0, holdings: [{symbol: 'USDG', allocationBps: 10000, valueUsdg: '100.00'}]},
  boundaries: {assetCount: 1, maxTradeUsdg: '10', dailyCapUsdg: '25', dailyUsedBps: 0, paused: false, sessionExpiresAt: null},
  lastWake: {reason: 'startup', toolCalls: 0, trades: 0, statusPosted: false},
  pendingApprovals: 0,
  chat: [{id: '1', kind: 'system', text: 'matter-agent is resident on Robinhood Chain', timestamp: now.toISOString()}],
};

render(React.createElement(App, {
  initialSnapshot: snapshot,
  session: null,
  interactive: true,
  unicode: true,
  colorEnabled: true,
  now,
}), {exitOnCtrlC: false, patchConsole: false});
