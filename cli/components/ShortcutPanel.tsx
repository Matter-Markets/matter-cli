import React from 'react';
import {Box, Text} from 'ink';

interface ShortcutPanelProps {
  width: number;
  height: number;
}

const groups = [
  ['session', 'Ctrl+T transcript · Ctrl+O copy latest · Ctrl+L redraw · Alt+R raw view · Esc interrupt'],
  ['composer', 'Enter send · Shift/Alt+Enter newline · Ctrl+G editor · Tab complete · ? shortcuts'],
  ['movement', '←/→ or Ctrl+B/F · Home/End or Ctrl+A/E · Alt+B/F word · ↑/↓ history'],
  ['editing', 'Ctrl+H backspace · Ctrl+D delete · Ctrl+W word back · Alt+D word forward'],
  ['kill/yank', 'Ctrl+U kill to start · Ctrl+K kill to end · Ctrl+Y yank · Ctrl+C clear/quit'],
  ['history', 'Ctrl+R previous · Ctrl+S next · PgUp/PgDn transcript · End latest'],
];

export function ShortcutPanel({width, height}: ShortcutPanelProps) {
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text bold>keyboard shortcuts</Text>
      <Text dimColor>Codex-style terminal controls, mapped to Matter semantics · ? or Esc closes</Text>
      <Text> </Text>
      {groups.map(([name, bindings]) => (
        <Box key={name} marginBottom={1}>
          <Box width={12}><Text bold>{name}</Text></Box>
          <Text>{bindings}</Text>
        </Box>
      ))}
    </Box>
  );
}
