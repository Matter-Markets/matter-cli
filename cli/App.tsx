import React, {useEffect, useMemo, useState} from 'react';
import {Box, Text, useApp, useInput, useStdout} from 'ink';
import {parseSlashCommand, helpText} from './commands.js';
import type {ChatItem, ResidentSnapshot, SessionCommand, SessionEvent} from './domain.js';
import type {ResidentSession} from './resident-client.js';
import {ChatPane} from './components/ChatPane.js';
import {Header} from './components/Header.js';
import {Prompt} from './components/Prompt.js';
import {RightRail} from './components/RightRail.js';
import {ShortcutPanel} from './components/ShortcutPanel.js';
import {editPromptExternally} from './external-editor.js';
import {controlKey} from './keyboard.js';
import {glyphs, terminalSupportsUnicode, theme} from './theme.js';
import {mergeChatItems} from './chat-presentation.js';

interface AppProps {
  initialSnapshot: ResidentSnapshot;
  session: ResidentSession | null;
  interactive?: boolean;
  width?: number;
  height?: number;
  unicode?: boolean;
  colorEnabled?: boolean;
  now?: Date;
}

function localItem(kind: ChatItem['kind'], text: string, status?: ChatItem['status']): ChatItem {
  return {
    id: `local-${Date.now()}-${Math.random()}`,
    kind,
    text,
    timestamp: new Date().toISOString(),
    ...(status ? {status} : {}),
  };
}

export function App({
  initialSnapshot,
  session,
  interactive = true,
  width,
  height,
  unicode = terminalSupportsUnicode(),
  colorEnabled = process.env.NO_COLOR === undefined,
  now = new Date(),
}: AppProps) {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const [dimensions, setDimensions] = useState({
    width: width ?? stdout.columns ?? 80,
    height: height ?? stdout.rows ?? 24,
  });
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [localItems, setLocalItems] = useState<ChatItem[]>([]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [rawOutput, setRawOutput] = useState(false);
  const glyph = useMemo(() => glyphs(unicode), [unicode]);

  useEffect(() => {
    if (width && height) return;
    const resize = () => setDimensions({width: width ?? stdout.columns ?? 80, height: height ?? stdout.rows ?? 24});
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [height, stdout, width]);

  useEffect(() => {
    if (!session) return;
    return session.subscribe((event: SessionEvent) => {
      if (event.type === 'snapshot') setSnapshot(event.snapshot);
      else if (event.type === 'chat.append') {
        setSnapshot(current => current.chat.some(item => item.id === event.item.id)
          ? current
          : {...current, chat: [...current.chat, event.item]});
      }
      else setLocalItems(items => [...items, localItem('system', `${event.message}${event.fix ? ` · ${event.fix}` : ''}`, 'error')]);
    });
  }, [session]);

  const appendError = (message: string) => setLocalItems(items => [...items, localItem('system', message, 'error')]);

  const runCommand = async (command: SessionCommand) => {
    if (command.name === 'clear') {
      setLocalItems([]);
      setSnapshot(current => ({...current, chat: []}));
      if (session) await session.command(command);
      return;
    }
    if (command.name === 'help') {
      setLocalItems(items => [...items, localItem('system', helpText)]);
      return;
    }
    if (command.name === 'quit') {
      if (session) await session.detach().catch(error => appendError(String(error)));
      setLocalItems(items => [...items, localItem('system', 'resident still running')]);
      setTimeout(() => exit(), 20);
      return;
    }
    if (!session) {
      appendError('resident unavailable · repair: matter resident start');
      return;
    }
    await session.command(command);
  };

  const submit = (value: string) => {
    if (value.startsWith('/')) {
      try {
        const command = parseSlashCommand(value);
        if (command?.name !== 'clear') setLocalItems(items => [...items, localItem('user', value)]);
        if (command) void runCommand(command).catch(error => appendError(String(error)));
      } catch (error) {
        appendError(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (!session) {
      setLocalItems(items => [...items, localItem('user', value)]);
      appendError('resident unavailable · this session is read-only · repair: matter resident start');
      return;
    }
    void session.sendMessage(value).catch(error => appendError(String(error)));
  };

  const frameWidth = Math.max(40, dimensions.width);
  const frameHeight = Math.max(18, dimensions.height);
  const wide = frameWidth >= 100;
  const bodyHeight = Math.max(7, frameHeight - (wide ? 9 : 14));
  const railWidth = wide ? Math.min(38, Math.max(31, Math.floor(frameWidth * 0.34))) : frameWidth;
  const chatWidth = wide ? frameWidth - railWidth : frameWidth;
  const chat = useMemo(() => mergeChatItems(snapshot.chat, localItems), [localItems, snapshot.chat]);

  useInput((input, key) => {
    const ctrl = controlKey(input, key.ctrl);
    if (ctrl === 't') {
      setShortcutsOpen(false);
      setRawOutput(current => !current);
      return;
    }
    if (key.meta && input === 'r') {
      setRawOutput(current => !current);
      return;
    }
    if (ctrl === 'o') {
      const latest = [...chat].reverse().find(item => item.kind === 'agent' || item.kind === 'result');
      if (!latest) return;
      stdout.write(`\u001B]52;c;${Buffer.from(latest.text).toString('base64')}\u0007`);
      setLocalItems(items => [...items, localItem('system', 'copied latest response')]);
      return;
    }
    if (ctrl === 'l') {
      stdout.write('\u001B[2J\u001B[H');
      return;
    }
    if (key.escape) {
      if (shortcutsOpen) setShortcutsOpen(false);
      else if (rawOutput) setRawOutput(false);
      else if (snapshot.agent.status === 'waking') void runCommand({name: 'interrupt'}).catch(error => appendError(String(error)));
    }
  }, {isActive: interactive});

  return (
    <Box flexDirection="column" width={frameWidth} height={frameHeight}>
      <Header snapshot={snapshot} now={now} width={frameWidth} glyph={glyph} colorEnabled={colorEnabled}/>
      <Box flexDirection={wide ? 'row' : 'column'} flexGrow={1}>
        {shortcutsOpen ? (
          <ShortcutPanel width={chatWidth} height={bodyHeight}/>
        ) : (
          <ChatPane
            items={chat}
            width={chatWidth}
            height={bodyHeight}
            glyph={glyph}
            unicode={unicode}
            colorEnabled={colorEnabled}
            interactive={interactive}
            papernet={snapshot.network.papernet}
            raw={rawOutput}
          />
        )}
        <RightRail snapshot={snapshot} width={railWidth} compact={!wide} glyph={glyph} colorEnabled={colorEnabled}/>
      </Box>
      <Box paddingX={1}>
        <Text dimColor>/portfolio /journal /wake /pause /clear /help /quit</Text>
      </Box>
      <Prompt
        active={interactive}
        width={frameWidth}
        glyph={glyph}
        unicode={unicode}
        colorEnabled={colorEnabled}
        onSubmit={submit}
        onToggleShortcuts={() => setShortcutsOpen(current => !current)}
        onExit={() => void runCommand({name: 'quit'}).catch(error => appendError(String(error)))}
        onError={appendError}
        onOpenEditor={editPromptExternally}
      />
      <Box paddingX={1}>
        <Text {...(colorEnabled ? {color: theme.accent} : {})}>{glyph.mark} MATTER</Text>
        <Text dimColor> · attached session · /quit detaches</Text>
      </Box>
    </Box>
  );
}
