import {describe, expect, it} from 'vitest';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import type {Address, Hex} from 'viem';
import {MatterToolHost} from './harness-tools.js';
import type {RuntimeWorkspaceConfig} from './config.js';
import type {ResidentJournal} from './journal.js';
import type {PendingTransactionStore} from './pending.js';

describe('MatterToolHost trade authorization', () => {
  it('proves its local agent key and publishes a public pulse with a bearer session', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const config: RuntimeWorkspaceConfig = {agentName: 'limematter', api: 'http://127.0.0.1:4646/v1', chainId: 4663, rpcUrl: 'http://127.0.0.1:8545', autoTradeMaxUsdg: 25, residentMode: 'human', model: null};
    const onboarding = {id: `0x${'11'.repeat(32)}` as Hex, api: config.api, name: 'limematter', agentKey: account.address};
    const journal = {append: async () => ({sequence: 1})} as unknown as ResidentJournal;
    const host = new MatterToolHost('.', config, onboarding, account, journal, {} as PendingTransactionStore);
    const routes: string[] = [];
    host.client.post = async (route, value) => {
      routes.push(route);
      if (route.endsWith('/runtime/challenge')) return {challengeId: `0x${'22'.repeat(32)}`, message: 'Matter test challenge'};
      if (route.endsWith('/runtime/prove')) { expect(value).toMatchObject({challengeId: `0x${'22'.repeat(32)}`, signature: expect.stringMatching(/^0x/)}); return {token: 'runtime-token'}; }
      throw new Error(`unexpected POST ${route}`);
    };
    host.client.postAuthenticated = async (route, value) => { routes.push(route); return {id: `0x${'33'.repeat(32)}`, ...(value as Record<string, unknown>)}; };
    const result = await host.execute({type: 'tool_call', id: 'pulse-1', name: 'matter_pulse', arguments: {status: 'Watching markets'}}, 'wake-1');
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({published: true, post: {body: 'Watching markets'}});
    expect(routes).toEqual([`/onboarding/${onboarding.id}/runtime/challenge`, `/onboarding/${onboarding.id}/runtime/prove`, '/posts']);
  });

  it('executes portfolio, boundaries, quote, and unsigned simulation through their authoritative routes', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const config: RuntimeWorkspaceConfig = {
      agentName: 'immutable', api: 'http://127.0.0.1:4646/v1', chainId: 4663, rpcUrl: 'http://127.0.0.1:8545',
      autoTradeMaxUsdg: 25, residentMode: 'human', model: null,
    };
    const host = new MatterToolHost('.', config, {id: `0x${'11'.repeat(32)}` as Hex, api: config.api, name: 'immutable', agentKey: account.address}, account,
      {append: async () => undefined} as unknown as ResidentJournal, {} as PendingTransactionStore);
    const routes: string[] = [];
    host.client.get = async route => {
      routes.push(route);
      if (route === '/agents/immutable/portfolio') return {equityUsdg: '100000000', blockNumber: 42n};
      if (route.startsWith('/onboarding/')) return {state: 'live', boundaries: {paused: false}};
      if (route === '/assets') return {quoteAsset: {symbol: 'USDG', address: `0x${'22'.repeat(20)}` as Address, decimals: 6}, items: [{symbol: 'AAPL', address: `0x${'33'.repeat(20)}` as Address, decimals: 18}]};
      throw new Error(`unexpected GET ${route}`);
    };
    host.client.post = async (route, body) => { routes.push(route); return {route, body}; };

    const execute = async (name: string, argumentsValue: Record<string, unknown>) => JSON.parse((await host.execute({type: 'tool_call', id: name, name, arguments: argumentsValue}, 'wake')).content);
    expect(await execute('matter_get_portfolio', {})).toEqual({equityUsdg: '100000000', blockNumber: '42'});
    expect(await execute('matter_get_boundaries', {})).toMatchObject({state: 'live'});
    expect(await execute('matter_quote', {asset: 'AAPL', side: 'buy', amount: '10'})).toMatchObject({route: '/quotes', body: {amountIn: '10000000'}});
    expect(await execute('matter_simulate_trade', {asset: 'AAPL', side: 'buy', amount: '10', slippage_bps: 50})).toMatchObject({route: '/trades/prepare', body: {caller: account.address, amountIn: '10000000'}});
    expect(routes).toContain('/agents/immutable/portfolio');
  });

  it('does not treat an expired runtime presence proof as transaction authority', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const config: RuntimeWorkspaceConfig = {
      agentName: 'immutable',
      api: 'http://127.0.0.1:4646/v1',
      chainId: 4663,
      rpcUrl: 'http://127.0.0.1:8545',
      autoTradeMaxUsdg: 25,
      residentMode: 'human',
      model: null,
    };
    const host = new MatterToolHost(
      '.',
      config,
      {id: `0x${'11'.repeat(32)}` as Hex, api: config.api, name: 'immutable', agentKey: account.address},
      account,
      {append: async () => undefined} as unknown as ResidentJournal,
      {} as PendingTransactionStore,
    );
    const routes: string[] = [];
    host.client.get = async route => {
      routes.push(route);
      if (route === '/assets') {
        return {
          quoteAsset: {symbol: 'USDG', address: `0x${'22'.repeat(20)}` as Address, decimals: 6},
          items: [{symbol: 'AAPL', address: `0x${'33'.repeat(20)}` as Address, decimals: 18}],
        };
      }
      throw new Error(`unexpected GET ${route}`);
    };
    host.client.post = async (route, body) => {
      routes.push(route);
      expect(body).toMatchObject({agent: 'immutable', asset: 'AAPL', amountIn: '25000000'});
      return {
        eligible: false,
        violations: [{code: 'paused', message: 'the harness is paused'}],
        boundaries: {notionalUsdg: '25000000'},
      };
    };

    const result = await host.execute({
      type: 'tool_call',
      id: 'trade-1',
      name: 'matter_trade',
      arguments: {asset: 'AAPL', side: 'buy', amount: '25', slippage_bps: 100},
    }, 'wake-1');

    expect(result.isError).toBe(false);
    expect(result.trade).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({eligible: false, violations: [{code: 'paused'}]});
    expect(routes).toEqual(['/assets', '/trades/prepare']);
    expect(routes.some(route => route.startsWith('/onboarding/'))).toBe(false);
  });
});
