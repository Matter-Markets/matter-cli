import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useInput, useStdin, useStdout} from 'ink';
import {entryHeight, groupChatItems, visibleChatEntries, type ChatEntry} from '../chat-presentation.js';
import {parseChatMarkdown} from '../chat-markdown.js';
import type {ChatItem} from '../domain.js';
import type {Glyphs} from '../theme.js';
import {theme} from '../theme.js';
import {terminalHyperlink, terminalSupportsHyperlinks, transactionUrl} from '../transaction-link.js';

interface ChatPaneProps {
  items: ChatItem[];
  width: number;
  height: number;
  glyph: Glyphs;
  unicode: boolean;
  colorEnabled: boolean;
  interactive: boolean;
  papernet: boolean;
  raw?: boolean;
}

function label(item: ChatItem, glyph: Glyphs): string {
  if (item.kind === 'user') return `you ${glyph.user}`;
  if (item.kind === 'agent') return `agent ${glyph.agent}`;
  if (item.kind === 'tool') return `${glyph.tool} tool call`;
  if (item.kind === 'result') return item.status === 'error' ? `${glyph.error} failed` : `${glyph.success} result`;
  if (item.kind === 'external') return 'chain activity';
  return 'system';
}

function borderColor(item: ChatItem): string {
  if (item.status === 'error') return theme.error;
  if (item.kind === 'user') return theme.accent;
  return theme.muted;
}

function standaloneResult(item: ChatItem): string {
  try {
    const value = JSON.parse(item.text) as Record<string, unknown>;
    if (typeof value.error === 'string') return value.error;
    if ('equityUsdg' in value || 'quoteBalance' in value) {
      const holdings = Array.isArray(value.holdings) ? value.holdings.length : 0;
      return `Portfolio refreshed${holdings ? ` - ${holdings} assets` : ''}`;
    }
    return 'Command completed';
  } catch {
    return item.text;
  }
}

function rawEntries(items: ChatItem[]): ChatEntry[] {
  return items.map(item => ({type: 'message', id: item.id, item}));
}

function chatText(value: string, colorEnabled: boolean): React.ReactNode {
  return parseChatMarkdown(value).map((segment, index) => segment.neon ? (
    <Text key={index} bold {...(colorEnabled ? {color: theme.highlight} : {})}>{segment.text}</Text>
  ) : segment.text);
}

export function ChatPane({items, width, height, glyph, unicode, colorEnabled, interactive, papernet, raw = false}: ChatPaneProps) {
  const entries = useMemo(() => raw ? rawEntries(items) : groupChatItems(items), [items, raw]);
  const maxOffset = Math.max(0, entries.length - 1);
  const maxOffsetRef = useRef(maxOffset);
  maxOffsetRef.current = maxOffset;
  const [offset, setOffset] = useState(0);
  const previousCount = useRef(entries.length);
  const {stdin} = useStdin();
  const {stdout} = useStdout();
  const bodyHeight = Math.max(1, height - 1);
  const hyperlinks = interactive && terminalSupportsHyperlinks();

  const scroll = useCallback((delta: number) => {
    setOffset(current => Math.max(0, Math.min(maxOffsetRef.current, current + delta)));
  }, []);

  const window = useMemo(
    () => visibleChatEntries(entries, offset, bodyHeight, width - 2),
    [bodyHeight, entries, offset, width],
  );
  useInput((_input, key) => {
    if (key.pageUp) {
      setOffset(Math.min(maxOffset, entries.length - window.start));
    } else if (key.pageDown) {
      let end = window.end;
      let used = 0;
      while (end < entries.length) {
        const candidate = entries[end];
        if (!candidate) break;
        const cost = Math.min(bodyHeight, entryHeight(candidate, width - 2));
        if (used > 0 && used + cost > bodyHeight) break;
        used += cost;
        end++;
      }
      setOffset(Math.max(0, entries.length - end));
    }
    else if (key.ctrl && key.upArrow) scroll(1);
    else if (key.ctrl && key.downArrow) scroll(-1);
    else if (key.end) setOffset(0);
  }, {isActive: interactive});

  useEffect(() => {
    const delta = entries.length - previousCount.current;
    previousCount.current = entries.length;
    setOffset(current => {
      const anchored = current === 0 ? 0 : current + Math.max(0, delta);
      return Math.max(0, Math.min(maxOffset, anchored));
    });
  }, [entries.length, maxOffset]);

  useEffect(() => {
    if (!interactive || !stdin.isTTY || !stdout.isTTY) return;
    const mouseModeOn = '\u001B[?1000h\u001B[?1006h';
    const mouseModeOff = '\u001B[?1006l\u001B[?1000l';
    stdout.write(mouseModeOn);
    const onMouse = (data: Buffer | string) => {
      const value = data.toString();
      for (const match of value.matchAll(/\u001B\[<(64|65);(\d+);(\d+)[mM]/g)) {
        const x = Number(match[2]);
        const y = Number(match[3]);
        if (x <= width && y >= 4 && y <= height + 4) scroll(match[1] === '64' ? 1 : -1);
      }
    };
    stdin.on('data', onMouse);
    return () => {
      stdin.off('data', onMouse);
      stdout.write(mouseModeOff);
    };
  }, [height, interactive, scroll, stdin, stdout, width]);

  const position = entries.length === 0 ? '0 of 0' : `${window.start + 1}–${window.end} of ${entries.length}`;

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1} overflow="hidden">
      <Box justifyContent="space-between" flexShrink={0}>
        <Text dimColor>{raw ? 'transcript · raw' : `chat · ${offset === 0 ? 'latest activity' : 'scrollback'}`}</Text>
        <Text dimColor>{position} · PgUp/PgDn</Text>
      </Box>
      <Box flexDirection="column" height={bodyHeight} overflowY="hidden">
        {window.visible.length === 0 ? (
          <Text dimColor>no session activity yet</Text>
        ) : raw ? window.visible.map(entry => {
          if (entry.type !== 'message') return null;
          return (
            <Text key={entry.id} dimColor={entry.item.kind === 'system' || entry.item.kind === 'external'} wrap="truncate-end">
              <Text bold>{label(entry.item, glyph)} </Text>{entry.item.text.replace(/\s+/g, ' ')}
            </Text>
          );
        }) : window.visible.map(entry => {
          if (entry.type === 'tool') {
            const icon = entry.status === 'pending' ? glyph.ellipsis : entry.status === 'error' ? glyph.error : glyph.success;
            const color = entry.status === 'error' ? theme.error : theme.accent;
            const explorerUrl = entry.transactionHash && !papernet ? transactionUrl(entry.transactionHash) : null;
            return (
              <Box key={entry.id} flexDirection="column" marginBottom={1} flexShrink={0}>
                <Box>
                  <Text {...(colorEnabled ? {color} : {})}>{icon} </Text>
                  <Text bold>{entry.title}</Text>
                  <Text dimColor> · {entry.summary}</Text>
                </Box>
                {entry.transactionHash ? (
                  <Box flexDirection="column" paddingLeft={2}>
                    <Text>
                      <Text dimColor>tx </Text>
                      <Text underline {...(colorEnabled ? {color: theme.accent} : {})}>
                        {explorerUrl ? terminalHyperlink(entry.transactionHash, explorerUrl, hyperlinks) : entry.transactionHash}
                      </Text>
                      <Text dimColor>{explorerUrl && hyperlinks ? ' ↗' : papernet ? ' · local papernet' : ''}</Text>
                    </Text>
                    {explorerUrl && !hyperlinks ? <Text dimColor>{explorerUrl}</Text> : null}
                  </Box>
                ) : null}
              </Box>
            );
          }
          const item = entry.item;
          const user = item.kind === 'user';
          const bubbleWidth = Math.max(24, width - (user ? 12 : 3));
          return (
            <Box key={entry.id} width={Math.max(1, width - 2)} justifyContent={user ? 'flex-end' : 'flex-start'} flexShrink={0}>
              <Box
                borderStyle={unicode ? 'round' : 'single'}
                {...(colorEnabled ? {borderColor: borderColor(item)} : {})}
                flexDirection="column"
                marginBottom={1}
                paddingX={1}
                width={bubbleWidth}
                flexShrink={0}
              >
                <Text bold={item.kind === 'user' || item.kind === 'agent'} dimColor={item.kind === 'external' || item.kind === 'system'}>
                  {label(item, glyph)}
                </Text>
                <Text
                  {...(item.status === 'error' && colorEnabled ? {color: theme.error} : {})}
                  {...(item.kind === 'result' ? {wrap: 'truncate-end' as const} : {})}
                >
                  {item.kind === 'result' ? standaloneResult(item) : chatText(item.text, colorEnabled)}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
