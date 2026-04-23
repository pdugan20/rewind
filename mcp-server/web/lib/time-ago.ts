/**
 * ISO 8601 date → short relative time ("6d ago", "1w ago", "2mo ago").
 *
 * Matches the Instapaper iOS list style: compact, always relative, no
 * "just now" (sub-minute) granularity needed for saved articles.
 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, (Date.now() - then) / 1000);

  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (seconds < hour) {
    const m = Math.max(1, Math.round(seconds / minute));
    return `${m}m ago`;
  }
  if (seconds < day) return `${Math.round(seconds / hour)}h ago`;
  if (seconds < week) return `${Math.round(seconds / day)}d ago`;
  if (seconds < month) return `${Math.round(seconds / week)}w ago`;
  if (seconds < year) return `${Math.round(seconds / month)}mo ago`;
  return `${Math.round(seconds / year)}y ago`;
}
