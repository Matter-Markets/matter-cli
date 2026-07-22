export function formatUsdg(value: string | null): string {
  if (value === null) return 'unavailable';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return parsed.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

export function formatBps(value: number | null): string {
  if (value === null) return 'unavailable';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value / 100).toFixed(2)}%`;
}

export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return 'never';
  const deltaSeconds = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (deltaSeconds < 60) return 'just now';
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function truncate(value: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (value.length <= width) return value;
  if (width <= ellipsis.length) return ellipsis.slice(0, width);
  return `${value.slice(0, width - ellipsis.length)}${ellipsis}`;
}
