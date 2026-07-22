import React from 'react';
import {Box, Text} from 'ink';
import type {ResidentSnapshot} from '../domain.js';
import {formatBps, formatUsdg, truncate} from '../format.js';
import type {Glyphs} from '../theme.js';
import {theme} from '../theme.js';

interface RightRailProps {
  snapshot: ResidentSnapshot;
  width: number;
  compact?: boolean;
  glyph: Glyphs;
  colorEnabled: boolean;
}

export function RightRail({snapshot, width, compact = false, glyph, colorEnabled}: RightRailProps) {
  const holdings = snapshot.portfolio.holdings.length > 0
    ? snapshot.portfolio.holdings.map(item => `${item.symbol} ${Math.round(item.allocationBps / 100)}%`).join(' · ')
    : 'portfolio unavailable';
  const harnessState = snapshot.boundaries.paused ? 'paused' : snapshot.network.connected ? 'live' : 'read-only';
  const harnessColor = snapshot.boundaries.paused ? theme.error : theme.accent;
  const wakeReason = snapshot.lastWake.reason ?? 'none';

  if (compact) {
    return (
      <Box flexDirection="column" borderStyle="single" paddingX={1} width={width}>
        <Text dimColor>portfolio · harness</Text>
        <Text>{truncate(holdings, width - 4, glyph.ellipsis)}</Text>
        <Text>
          equity {formatUsdg(snapshot.portfolio.equityUsdg)} · caps {Math.round(snapshot.boundaries.dailyUsedBps / 100)}% used ·{' '}
          <Text {...(colorEnabled ? {color: harnessColor} : {})}>{harnessState}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} width={width}>
      <Text dimColor>portfolio (live)</Text>
      <Text>{truncate(holdings, width - 4, glyph.ellipsis)}</Text>
      <Text>equity {formatUsdg(snapshot.portfolio.equityUsdg)} · epoch {formatBps(snapshot.portfolio.epochReturnBps)}</Text>
      <Text> </Text>
      <Text dimColor>harness</Text>
      <Text {...(colorEnabled ? {color: harnessColor} : {})}>{glyph.live} {harnessState} · caps {Math.round(snapshot.boundaries.dailyUsedBps / 100)}% used</Text>
      <Text dimColor>boundaries</Text>
      <Text>{snapshot.boundaries.assetCount} assets · {snapshot.boundaries.maxTradeUsdg}/trade</Text>
      <Text>{snapshot.boundaries.dailyCapUsdg}/day</Text>
      <Text> </Text>
      <Text dimColor>last wake</Text>
      <Text>{wakeReason} · {snapshot.lastWake.toolCalls} tool calls</Text>
      <Text>{snapshot.lastWake.trades} trades · {snapshot.lastWake.statusPosted ? 'status posted' : 'no status'}</Text>
      {snapshot.pendingApprovals > 0 && (
        <Text {...(colorEnabled ? {color: theme.accent} : {})}>{snapshot.pendingApprovals} approval pending</Text>
      )}
    </Box>
  );
}
