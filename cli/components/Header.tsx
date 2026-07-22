import React from 'react';
import {Box, Text} from 'ink';
import type {ResidentSnapshot} from '../domain.js';
import {relativeTime, truncate} from '../format.js';
import type {Glyphs} from '../theme.js';
import {theme} from '../theme.js';

interface HeaderProps {
  snapshot: ResidentSnapshot;
  now: Date;
  width: number;
  glyph: Glyphs;
  colorEnabled: boolean;
}

export function Header({snapshot, now, width, glyph, colorEnabled}: HeaderProps) {
  const id = snapshot.agent.id ? ` · AGENT #${snapshot.agent.id}` : '';
  const status = `${glyph.live} ${snapshot.agent.status}`;
  const left = `${snapshot.agent.name}${id} · ${status} (last wake ${relativeTime(snapshot.agent.lastWakeAt, now)})`;
  const network = snapshot.network.papernet ? 'PAPERNET' : snapshot.network.name.toUpperCase();
  const available = Math.max(12, width - network.length - 5);

  return (
    <Box borderStyle="single" borderColor={colorEnabled ? theme.accent : undefined} paddingX={1} width={width}>
      <Box flexGrow={1}>
        <Text bold>{truncate(left, available, glyph.ellipsis)}</Text>
      </Box>
      <Text bold {...(colorEnabled ? {color: theme.accent} : {})}>{network}</Text>
    </Box>
  );
}
