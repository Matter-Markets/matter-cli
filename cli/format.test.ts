import {describe, expect, it} from 'vitest';
import {formatBps, formatUsdg, relativeTime, truncate} from './format.js';

describe('terminal formatting', () => {
  it('formats monetary and percentage data deterministically', () => {
    expect(formatUsdg('549.99')).toBe('549.99');
    expect(formatUsdg(null)).toBe('unavailable');
    expect(formatBps(180)).toBe('+1.80%');
    expect(formatBps(-25)).toBe('-0.25%');
  });

  it('formats relative wake times and truncation', () => {
    const now = new Date('2026-07-22T14:34:00.000Z');
    expect(relativeTime('2026-07-22T14:02:00.000Z', now)).toBe('32m ago');
    expect(relativeTime(null, now)).toBe('never');
    expect(truncate('resident keeps running', 12)).toBe('resident ke…');
  });
});
