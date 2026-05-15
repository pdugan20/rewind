/**
 * Output schema for the system tool (get_health). Issue #105.
 *
 * `.passthrough()` keeps the advertised JSON Schema forward-compatible.
 * See schemas/shared.ts.
 */
import { z } from 'zod';

/** outputSchema for get_health: API status plus per-domain sync health. */
export const healthOutputSchema = z
  .object({
    api_status: z.string(),
    timestamp: z.string(),
    domains: z.record(
      z
        .object({
          status: z.string(),
          last_sync: z.string().nullable(),
          items_synced: z.number().nullable(),
        })
        .passthrough()
    ),
  })
  .passthrough();
