import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useInput, useStdin} from 'ink';
import type {Glyphs} from '../theme.js';
import {theme} from '../theme.js';
import {controlKey} from '../keyboard.js';

interface PromptProps {
  active: boolean;
  width: number;
  glyph: Glyphs;
  unicode: boolean;
  colorEnabled: boolean;
  disabled?: boolean;
  onSubmit: (value: string) => void;
  onToggleShortcuts: () => void;
  onExit: () => void;
  onError: (message: string) => void;
  onOpenEditor: (value: string) => Promise<string>;
}

const slashCommands = ['/portfolio', '/journal', '/wake', '/pause', '/clear', '/help', '/quit'];

function previousWord(value: string, cursor: number): number {
  let next = cursor;
  while (next > 0 && /\s/.test(value[next - 1] ?? '')) next--;
  while (next > 0 && !/\s/.test(value[next - 1] ?? '')) next--;
  return next;
}

function nextWord(value: string, cursor: number): number {
  let next = cursor;
  while (next < value.length && !/\s/.test(value[next] ?? '')) next++;
  while (next < value.length && /\s/.test(value[next] ?? '')) next++;
  return next;
}

export function Prompt({
  active,
  width,
  glyph,
  unicode,
  colorEnabled,
  disabled = false,
  onSubmit,
  onToggleShortcuts,
  onExit,
  onError,
  onOpenEditor,
}: PromptProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const valueRef = useRef('');
  const cursorRef = useRef(0);
  const killBufferRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const stdinState = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter?: {
      prependListener: (event: 'input', listener: (data: Buffer | string) => void) => void;
      removeListener: (event: 'input', listener: (data: Buffer | string) => void) => void;
    };
  };
  const {setRawMode} = stdinState;
  const deleteDirectionRef = useRef<'backward' | 'forward' | null>(null);
  const suggestions = useMemo(() => {
    if (!value.startsWith('/') || value.includes(' ')) return [];
    return slashCommands.filter(command => command.startsWith(value));
  }, [value]);

  const replace = (next: string, nextCursor = next.length) => {
    valueRef.current = next;
    cursorRef.current = nextCursor;
    setValue(next);
    setCursor(nextCursor);
  };

  const insert = (text: string) => {
    const currentValue = valueRef.current;
    const currentCursor = cursorRef.current;
    replace(`${currentValue.slice(0, currentCursor)}${text}${currentValue.slice(currentCursor)}`, currentCursor + text.length);
  };

  const visitHistory = (direction: -1 | 1) => {
    const currentHistory = historyRef.current;
    if (currentHistory.length === 0) return;
    const current = historyIndexRef.current ?? currentHistory.length;
    const next = Math.max(0, Math.min(currentHistory.length, current + direction));
    historyIndexRef.current = next === currentHistory.length ? null : next;
    replace(next === currentHistory.length ? '' : currentHistory[next] ?? '');
  };

  useEffect(() => {
    const captureDeleteDirection = (data: Buffer | string) => {
      const raw = data.toString();
      if (raw === '\u007F' || raw === '\b') deleteDirectionRef.current = 'backward';
      else if (/^\u001B\[3(?:;\d+)?~$/.test(raw)) deleteDirectionRef.current = 'forward';
      else deleteDirectionRef.current = null;
    };
    // Ink normalizes both Windows Terminal's DEL byte (Backspace) and the
    // physical Delete escape sequence to key.delete. Capture its parsed input
    // event one step earlier so the editor can retain the intended direction.
    const inputEvents = stdinState.internal_eventEmitter;
    inputEvents?.prependListener('input', captureDeleteDirection);
    return () => {
      inputEvents?.removeListener('input', captureDeleteDirection);
    };
  }, [stdinState.internal_eventEmitter]);

  useInput((input, key) => {
    // Ink removes the ESC byte before forwarding SGR mouse packets. Never let
    // clicks, releases, or wheel events become composer text.
    if (/^(?:(?:\u001B)?\[<\d+;\d+;\d+[mM])+$/.test(input)) return;
    const ctrl = controlKey(input, key.ctrl);
    const currentValue = valueRef.current;
    const currentCursor = cursorRef.current;
    const deleteDirection = deleteDirectionRef.current;
    deleteDirectionRef.current = null;
    if (ctrl === 'c') {
      if (currentValue) replace('');
      else onExit();
      return;
    }
    if (ctrl === 'g') {
      setRawMode(false);
      void onOpenEditor(currentValue)
        .then(next => replace(next.replace(/\r\n/g, '\n')))
        .catch(error => onError(error instanceof Error ? error.message : String(error)))
        .finally(() => setRawMode(true));
      return;
    }
    if (currentValue.length === 0 && input === '?' && !key.ctrl && !key.meta) {
      onToggleShortcuts();
      return;
    }
    if (key.tab) {
      const completion = suggestions[0];
      if (completion) replace(completion);
      return;
    }
    if (ctrl === 'r') {
      visitHistory(-1);
      return;
    }
    if (ctrl === 's') {
      visitHistory(1);
      return;
    }
    if (ctrl === 'a') {
      cursorRef.current = 0;
      setCursor(0);
      return;
    }
    if (ctrl === 'e') {
      cursorRef.current = currentValue.length;
      setCursor(currentValue.length);
      return;
    }
    if (ctrl === 'u') {
      killBufferRef.current = currentValue.slice(0, currentCursor);
      replace(currentValue.slice(currentCursor), 0);
      return;
    }
    if (ctrl === 'k') {
      killBufferRef.current = currentValue.slice(currentCursor);
      replace(currentValue.slice(0, currentCursor), currentCursor);
      return;
    }
    if (ctrl === 'y') {
      insert(killBufferRef.current);
      return;
    }
    if (ctrl === 'b' || ctrl === 'f') {
      const nextCursor = Math.max(0, Math.min(currentValue.length, currentCursor + (ctrl === 'b' ? -1 : 1)));
      cursorRef.current = nextCursor;
      setCursor(nextCursor);
      return;
    }
    if (key.meta && (input === 'b' || input === 'f')) {
      const nextCursor = input === 'b' ? previousWord(currentValue, currentCursor) : nextWord(currentValue, currentCursor);
      cursorRef.current = nextCursor;
      setCursor(nextCursor);
      return;
    }
    if (ctrl === 'w' || key.meta && key.backspace) {
      const start = previousWord(currentValue, currentCursor);
      killBufferRef.current = currentValue.slice(start, currentCursor);
      replace(`${currentValue.slice(0, start)}${currentValue.slice(currentCursor)}`, start);
      return;
    }
    if (key.meta && input === 'd') {
      const end = nextWord(currentValue, currentCursor);
      killBufferRef.current = currentValue.slice(currentCursor, end);
      replace(`${currentValue.slice(0, currentCursor)}${currentValue.slice(end)}`, currentCursor);
      return;
    }
    if (key.ctrl && (input === 'j' || input === 'm')) {
      insert('\n');
      return;
    }
    if (key.return) {
      if (key.shift || key.meta) {
        insert('\n');
        return;
      }
      const next = currentValue.trim();
      if (next) {
        onSubmit(next);
        historyRef.current = [...historyRef.current.filter(item => item !== next), next].slice(-100);
      }
      historyIndexRef.current = null;
      replace('');
      return;
    }
    if (ctrl === 'h') {
      if (currentCursor > 0) replace(`${currentValue.slice(0, currentCursor - 1)}${currentValue.slice(currentCursor)}`, currentCursor - 1);
      return;
    }
    if (ctrl === 'd') {
      if (currentValue.length === 0) onExit();
      else if (currentCursor < currentValue.length) replace(`${currentValue.slice(0, currentCursor)}${currentValue.slice(currentCursor + 1)}`, currentCursor);
      return;
    }
    if (key.backspace || key.delete && deleteDirection === 'backward') {
      if (currentCursor === 0) return;
      replace(`${currentValue.slice(0, currentCursor - 1)}${currentValue.slice(currentCursor)}`, currentCursor - 1);
      return;
    }
    if (key.delete) {
      if (currentCursor >= currentValue.length) return;
      replace(`${currentValue.slice(0, currentCursor)}${currentValue.slice(currentCursor + 1)}`, currentCursor);
      return;
    }
    if (key.leftArrow) {
      cursorRef.current = Math.max(0, currentCursor - 1);
      setCursor(cursorRef.current);
      return;
    }
    if (key.rightArrow) {
      cursorRef.current = Math.min(currentValue.length, currentCursor + 1);
      setCursor(cursorRef.current);
      return;
    }
    if (key.home) {
      cursorRef.current = 0;
      setCursor(0);
      return;
    }
    if (key.end) {
      cursorRef.current = currentValue.length;
      setCursor(currentValue.length);
      return;
    }
    if (key.ctrl && (key.upArrow || key.downArrow)) return;
    if (key.upArrow || ctrl === 'p') {
      visitHistory(-1);
      return;
    }
    if (key.downArrow || ctrl === 'n') {
      visitHistory(1);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (input) {
      const inserted = input.replace(/\r/g, '');
      insert(inserted);
    }
  }, {isActive: active && !disabled});

  const beforeCursor = value.slice(0, cursor);
  const cursorCharacter = value[cursor] ?? ' ';
  const afterCursor = value.slice(cursor + (cursor < value.length ? 1 : 0));
  const placeholder = 'Ask your resident anything, or type / for commands';

  return (
    <Box
      borderStyle={unicode ? 'round' : 'single'}
      {...(colorEnabled && active ? {borderColor: theme.accent} : {})}
      flexDirection="column"
      paddingX={1}
      width={width}
      minHeight={4}
    >
      <Box>
        <Text bold {...(colorEnabled ? {color: theme.accent} : {})}>{glyph.user} </Text>
        {disabled ? (
          <Text dimColor>read-only</Text>
        ) : value.length === 0 ? (
          <Text><Text inverse={active}> </Text><Text dimColor> {placeholder}</Text></Text>
        ) : (
          <Text>
            {beforeCursor}
            <Text inverse={active}>{cursorCharacter}</Text>
            {afterCursor}
          </Text>
        )}
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>{suggestions.length > 0 ? suggestions.slice(0, 3).join('  ') : '? shortcuts · ctrl+g editor'}</Text>
        <Text dimColor>enter send · shift+enter newline</Text>
      </Box>
    </Box>
  );
}
