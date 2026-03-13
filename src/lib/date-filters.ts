import { and, gte, lte, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { z } from '@hono/zod-openapi';

/**
 * Shared Zod schema for date filtering query params.
 * Merge into route schemas: `request: { query: MySchema.merge(DateFilterQuery) }`
 */
export const DateFilterQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .openapi({
      description: 'Single day (YYYY-MM-DD). Overrides from/to.',
      example: '2025-02-17',
    }),
  from: z.string().optional().openapi({
    description: 'Range start, inclusive (ISO 8601)',
    example: '2025-02-01T00:00:00Z',
  }),
  to: z.string().optional().openapi({
    description: 'Range end, inclusive (ISO 8601)',
    example: '2025-02-28T23:59:59Z',
  }),
});

/**
 * Build a Drizzle SQL condition from date query params.
 * Returns undefined when no date params are present.
 *
 * `date` takes precedence over `from`/`to`.
 */
export function buildDateCondition(
  column: SQLiteColumn,
  params: { date?: string; from?: string; to?: string }
): SQL | undefined {
  if (params.date) {
    const dayStart = `${params.date}T00:00:00.000Z`;
    const nextDay = nextDayISO(params.date);
    const dayEnd = `${nextDay}T00:00:00.000Z`;
    return and(gte(column, dayStart), lte(column, dayEnd));
  }

  const conditions: SQL[] = [];
  if (params.from) conditions.push(gte(column, params.from));
  if (params.to) conditions.push(lte(column, params.to));

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

function nextDayISO(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().split('T')[0];
}
