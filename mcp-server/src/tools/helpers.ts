import { z } from 'zod';
import type { RewindClient } from '../client.js';

/**
 * Wrap a tool handler with standard error handling.
 * Returns { content, isError: true } on failure.
 */
export async function withErrorHandling(
  fn: () => Promise<string>
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const text = await fn();
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}

/** Format a date string as "Jan 15, 2025" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Format a date string as relative time like "2h ago" */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

/** Format a number with commas */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString('en-US');
}

/** Common date filter params reused across tools. */
export const dateFilterParams = {
  date: z
    .string()
    .optional()
    .describe('Optional: filter to a specific date (YYYY-MM-DD)'),
  from: z
    .string()
    .optional()
    .describe('Optional: start of date range (ISO 8601)'),
  to: z.string().optional().describe('Optional: end of date range (ISO 8601)'),
};

/** Standard annotations for all Rewind tools (read-only, open-world). */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true as const,
  destructiveHint: false as const,
  openWorldHint: true as const,
};

export type { RewindClient };
