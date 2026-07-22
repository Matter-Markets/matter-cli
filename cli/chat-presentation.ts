import {plainChatMarkdown} from './chat-markdown.js';
import type {ChatItem} from './domain.js';
import {ROBINHOOD_BLOCKSCOUT} from './transaction-link.js';

export interface MessageEntry {
  type: 'message';
  id: string;
  item: ChatItem;
}

export interface ToolEntry {
  type: 'tool';
  id: string;
  call: ChatItem;
  result: ChatItem | null;
  title: string;
  summary: string;
  status: 'pending' | 'success' | 'error';
  transactionHash: string | null;
}

export type ChatEntry = MessageEntry | ToolEntry;

export function mergeChatItems(residentItems: ChatItem[], localItems: ChatItem[]): ChatItem[] {
  const seen = new Set<string>();
  return [...residentItems, ...localItems]
    .filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map((item, order) => ({item, order, timestamp: Date.parse(item.timestamp)}))
    .sort((left, right) => {
      const bothValid = Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp);
      if (bothValid && left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return left.order - right.order;
    })
    .map(({item}) => item);
}

interface ParsedCall {
  name: string;
  arguments: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseCall(text: string): ParsedCall {
  const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(text.trim());
  if (!match) return {name: 'tool', arguments: {}};
  try {
    return {name: match[1] ?? 'tool', arguments: record(match[2] ? JSON.parse(match[2]) : {})};
  } catch {
    return {name: match[1] ?? 'tool', arguments: {}};
  }
}

function humanToolName(name: string): string {
  return name.replace(/^matter_/, '').replace(/^get_/, 'read ').replace(/_/g, ' ').replace(/^./, value => value.toUpperCase());
}

function callTitle(call: ParsedCall): string {
  if (call.name === 'matter_get_portfolio') return 'Read portfolio';
  if (call.name === 'matter_get_boundaries') return 'Read boundaries';
  const asset = typeof call.arguments.asset === 'string' ? call.arguments.asset.toUpperCase() : 'asset';
  const side = call.arguments.side === 'sell' ? 'sell' : 'buy';
  const amount = typeof call.arguments.amount === 'string' ? call.arguments.amount : '';
  if (call.name === 'matter_quote') return `Quote ${side} ${amount}${amount ? ' ' : ''}${asset}`;
  if (call.name === 'matter_trade') return `${side === 'buy' ? 'Buy' : 'Sell'} ${amount}${amount ? ' ' : ''}${asset}`;
  return humanToolName(call.name);
}

function parsedResult(item: ChatItem | null): Record<string, unknown> {
  if (!item) return {};
  try { return record(JSON.parse(item.text)); } catch { return {}; }
}

function resultSummary(call: ParsedCall, result: ChatItem | null): string {
  if (!result) return 'Running';
  const value = parsedResult(result);
  if (result.status === 'error') {
    return typeof value.error === 'string' ? value.error : 'Failed';
  }
  if (call.name === 'matter_get_portfolio') return 'Portfolio refreshed';
  if (call.name === 'matter_get_boundaries') return 'Boundaries verified';
  if (call.name === 'matter_quote') return 'Live quote received';
  if (call.name === 'matter_trade') {
    if (value.eligible === false) return 'Blocked by boundaries';
    const broadcast = record(value.broadcast);
    if (broadcast.status === 'success') {
      const transaction = record(value.transaction);
      const hash = typeof transaction.hash === 'string' ? transaction.hash : '';
      return hash ? `Confirmed ${hash.slice(0, 10)}...` : 'Trade confirmed';
    }
    return 'Trade prepared';
  }
  return 'Completed';
}

function transactionHash(result: ChatItem | null): string | null {
  const value = parsedResult(result);
  const broadcast = record(value.broadcast);
  const transaction = record(value.transaction);
  const hash = typeof broadcast.hash === 'string'
    ? broadcast.hash
    : typeof transaction.hash === 'string' ? transaction.hash : null;
  return hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash : null;
}

export function groupChatItems(items: ChatItem[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  for (let index = 0; index < items.length; index++) {
    const current = items[index];
    if (!current) continue;
    if (current.kind !== 'tool') {
      entries.push({type: 'message', id: current.id, item: current});
      continue;
    }
    const next = items[index + 1];
    const result = next?.kind === 'result' ? next : null;
    if (result) index++;
    const call = parseCall(current.text);
    entries.push({
      type: 'tool',
      id: result ? `${current.id}:${result.id}` : current.id,
      call: current,
      result,
      title: callTitle(call),
      summary: resultSummary(call, result),
      status: !result ? 'pending' : result.status === 'error' ? 'error' : 'success',
      transactionHash: transactionHash(result),
    });
  }
  return entries;
}

function wrappedLines(text: string, width: number): number {
  return text.split(/\r?\n/).reduce((total, line) => total + Math.max(1, Math.ceil([...line].length / Math.max(1, width))), 0);
}

export function entryHeight(entry: ChatEntry, width: number): number {
  if (entry.type === 'tool') {
    const trace = wrappedLines(`${entry.title} · ${entry.summary}`, Math.max(1, width - 4));
    const transaction = entry.transactionHash
      ? wrappedLines(`tx ${entry.transactionHash}`, Math.max(1, width - 4))
        + wrappedLines(`${ROBINHOOD_BLOCKSCOUT}/tx/${entry.transactionHash}`, Math.max(1, width - 4))
      : 0;
    return trace + transaction + 1;
  }
  if (entry.item.kind === 'result') return 2;
  const user = entry.item.kind === 'user';
  const bubbleWidth = Math.max(24, width - (user ? 12 : 3));
  return wrappedLines(plainChatMarkdown(entry.item.text), Math.max(1, bubbleWidth - 4)) + 4;
}

export function visibleChatEntries(entries: ChatEntry[], offset: number, height: number, width: number): {visible: ChatEntry[]; start: number; end: number} {
  const end = Math.max(0, entries.length - Math.max(0, offset));
  let start = end;
  let used = 0;
  while (start > 0) {
    const candidate = entries[start - 1];
    if (!candidate) break;
    const cost = Math.min(height, entryHeight(candidate, width));
    if (used > 0 && used + cost > height) break;
    used += cost;
    start--;
  }
  return {visible: entries.slice(start, end), start, end};
}
