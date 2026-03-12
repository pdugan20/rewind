# Route Migration Guide: Hono to Zod-OpenAPI

Step-by-step guide for converting existing Hono route files to `@hono/zod-openapi` with full schema coverage.

## Overview

Each route file migration follows this pattern:

1. Define Zod schemas for request params, query, body, and response
2. Replace `app.get(path, handler)` with `app.openapi(route, handler)`
3. Run existing tests to verify nothing broke
4. Run `npm run lint:api` to verify spec quality

The handler logic stays the same. The migration is about wrapping routes with schema metadata.

## Before and After

### Before (plain Hono)

```typescript
import { Hono } from 'hono';
import type { Env } from '../types/env.js';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});
```

### After (zod-openapi)

```typescript
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Env } from '../types/env.js';

const app = new OpenAPIHono<{ Bindings: Env }>();

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['System'],
  summary: 'Health check',
  description: 'Returns API health status and current timestamp.',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            status: z.literal('ok'),
            timestamp: z.string().datetime(),
          }),
        },
      },
      description: 'API is healthy',
    },
  },
});

app.openapi(healthRoute, (c) => {
  return c.json({
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
  });
});
```

## Key Changes

| Aspect               | Before                          | After                                  |
| -------------------- | ------------------------------- | -------------------------------------- |
| Import               | `Hono`                          | `OpenAPIHono`, `createRoute`, `z`      |
| App creation         | `new Hono<{ Bindings: Env }>()` | `new OpenAPIHono<{ Bindings: Env }>()` |
| Route definition     | Inline in `.get()`              | Separate `createRoute()` object        |
| Handler registration | `app.get(path, handler)`        | `app.openapi(route, handler)`          |
| Response typing      | Implicit                        | Explicit Zod schema                    |

## Patterns for Common Shapes

### Pagination Query Params

```typescript
const PaginationQuery = z.object({
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
```

### Pagination Response Envelope

```typescript
const PaginationMeta = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  total_pages: z.number().int(),
});

// Usage in a route response:
z.object({
  data: z.array(ItemSchema),
  pagination: PaginationMeta,
});
```

### Error Response

```typescript
const ErrorResponse = z.object({
  error: z.string(),
  status: z.number().int(),
});

// Add to every route's responses:
responses: {
  200: { /* success */ },
  400: {
    content: { 'application/json': { schema: ErrorResponse } },
    description: 'Bad request',
  },
  401: {
    content: { 'application/json': { schema: ErrorResponse } },
    description: 'Unauthorized',
  },
},
```

### Image Attachment

```typescript
const ImageAttachment = z
  .object({
    url: z.string().url(),
    thumbhash: z.string().nullable(),
    dominant_color: z.string().nullable(),
    accent_color: z.string().nullable(),
  })
  .nullable();
```

### Path Parameters

```typescript
const route = createRoute({
  method: 'get',
  path: '/artists/{id}', // Note: OpenAPI uses {id}, not :id
  request: {
    params: z.object({
      id: z.coerce.number().int().positive().openapi({ example: 42 }),
    }),
  },
  // ...
});
```

### Period Query Param (Listening)

```typescript
const PeriodQuery = z.object({
  period: z
    .enum(['7day', '1month', '3month', '6month', '12month', 'overall'])
    .optional()
    .default('7day')
    .openapi({ example: '7day' }),
});
```

## Migration Checklist Per File

For each route file:

- [ ] Change `Hono` import to `OpenAPIHono`
- [ ] Add `createRoute` and `z` imports from `@hono/zod-openapi`
- [ ] Define Zod schemas for all request params, query params, and request bodies
- [ ] Define Zod schemas for all response shapes
- [ ] Convert each `app.get/post/delete(path, handler)` to `app.openapi(route, handler)`
- [ ] Add `tags`, `summary`, and `description` to each route
- [ ] Add error responses (400, 401, 404 as applicable) to each route
- [ ] Change path params from `:id` syntax to `{id}` syntax
- [ ] Run `npm test` to verify no regressions
- [ ] Run `npm run lint:api` to verify spec quality (once Phase 4 is in place)

## Tips

- **Extract schemas to separate files** when they're shared across routes. Put domain schemas in `src/lib/schemas/<domain>.ts` and common schemas in `src/lib/schemas/common.ts`.
- **Use `.openapi()` on Zod types** to add examples and descriptions that appear in the rendered docs.
- **Literal types help**: Use `z.literal('ok')` instead of `z.string()` when the value is always the same. This makes the docs more precise.
- **Don't change handler logic**: The goal is to wrap existing behavior in schemas, not refactor the handlers. Keep the migration mechanical.
- **Admin endpoints**: Tag these with both the domain tag and an `Admin` tag so they can be filtered in the docs.
- **OpenAPI path syntax**: Hono's `:param` becomes `{param}` in `createRoute`. The framework handles the translation.
