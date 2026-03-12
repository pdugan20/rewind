import { z } from '@hono/zod-openapi';

// ─── Error Envelope ─────────────────────────────────────────────────

export const ErrorResponse = z
  .object({
    error: z.string().openapi({ example: 'Not found' }),
    status: z.number().int().openapi({ example: 404 }),
  })
  .openapi('ErrorResponse');

// ─── Pagination ─────────────────────────────────────────────────────

export const PaginationQuery = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .optional()
    .default(1)
    .openapi({ example: 1 }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(20)
    .openapi({ example: 20 }),
});

export const PaginationMeta = z
  .object({
    page: z.number().int().openapi({ example: 1 }),
    limit: z.number().int().openapi({ example: 20 }),
    total: z.number().int().openapi({ example: 150 }),
    total_pages: z.number().int().openapi({ example: 8 }),
  })
  .openapi('PaginationMeta');

// ─── Image Attachment ───────────────────────────────────────────────

export const ImageAttachment = z
  .object({
    url: z.string().url().openapi({ example: 'https://cdn.rewind.rest/...' }),
    thumbhash: z.string().nullable().openapi({ example: 'YJqGPQw7d4...' }),
    dominant_color: z.string().nullable().openapi({ example: '#1a1a2e' }),
    accent_color: z.string().nullable().openapi({ example: '#e94560' }),
  })
  .nullable()
  .openapi('ImageAttachment');

// ─── Common Error Responses ─────────────────────────────────────────

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  500: 'Internal server error',
};

/**
 * Generate error response definitions for specific status codes.
 * Usage: `...errorResponses(400, 401, 404)` in a route's responses object.
 */
export function errorResponses(
  ...codes: Array<400 | 401 | 403 | 404 | 500>
): Record<string, object> {
  const responses: Record<string, object> = {};
  for (const code of codes) {
    responses[code] = {
      content: { 'application/json': { schema: ErrorResponse } },
      description: ERROR_DESCRIPTIONS[code],
    };
  }
  return responses;
}
