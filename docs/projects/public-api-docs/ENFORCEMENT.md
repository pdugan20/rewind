# Enforcement: Preventing Doc Drift and Hallucination

Design document for the CI pipeline that programmatically guarantees documentation accuracy.

## Problem

API documentation drifts from reality in two ways:

1. **Drift**: A developer changes a route handler but forgets to update the docs
2. **Hallucination**: An AI agent writes documentation that describes behavior the API doesn't actually have

Both produce the same outcome: docs that lie. The enforcement strategy must catch both.

## Defense Layers

### Layer 1: Compile-Time Type Safety

**What it catches**: Handler returns a shape that doesn't match the declared schema.

`@hono/zod-openapi` infers TypeScript types from the Zod response schemas. If a handler returns `{ status: 'ok' }` but the schema declares `{ health: 'ok' }`, the TypeScript compiler errors. This is the tightest possible feedback loop -- the code won't compile.

**No CI config needed** -- this is enforced by `npm run type-check` which already runs in CI.

### Layer 2: Runtime Response Validation

**What it catches**: Response data that passes type-checking but violates constraints (e.g., a number outside the declared range, a missing nullable field).

In test and dev environments, enable `.output()` validation on zod-openapi routes. This runs the Zod schema against every response body and throws if it doesn't match.

```typescript
// In test/dev only -- too expensive for production
app.openapi(route, handler, {
  // hook that validates response against schema
});
```

**Trade-off**: Adds latency in dev. Worth it for catching edge cases that types alone miss.

### Layer 3: Spec Snapshot Test

**What it catches**: Any change to the API surface that wasn't explicitly acknowledged.

A Vitest test generates the OpenAPI spec from the app and compares it to a committed `openapi.snapshot.json`. If they differ, the test fails.

```text
Workflow:
1. Developer changes a route
2. CI runs tests -- snapshot test fails
3. Developer runs `npm run spec:update` to regenerate snapshot
4. Developer commits the updated snapshot
5. PR diff shows exactly what changed in the API surface
```

This makes every API change visible in code review. A reviewer can look at the snapshot diff and verify the change is intentional and correctly documented.

**Key file**: `openapi.snapshot.json` at project root (committed to git).

### Layer 4: Spectral Linting

**What it catches**: Missing descriptions, inconsistent naming, missing error responses, undocumented parameters.

Spectral is a programmable OpenAPI linter. The `.spectral.yml` ruleset enforces:

- Every operation has a `summary` and `description`
- Every operation has at least a `200` and `401` response
- Every parameter has a `description`
- Path segments use kebab-case
- Schema properties use snake_case
- No operations without tags

```yaml
# .spectral.yml
extends: spectral:oas
rules:
  operation-description: error
  operation-summary: error
  operation-tag-defined: error
  oas3-valid-schema-example: warn
```

**CI integration**: `npm run lint:api` generates the spec, pipes it to Spectral, fails the build on errors.

### Layer 5: Contract Tests

**What it catches**: The spec says one thing, but the live API returns something different.

Contract tests use `openapi-response-validator` to check actual API responses (from Vitest tests running against the Workers dev server) against the OpenAPI spec.

```typescript
import { validateResponse } from '../test-helpers/contract.js';

it('GET /v1/health matches spec', async () => {
  const res = await app.request('/v1/health');
  const body = await res.json();
  const errors = validateResponse('get', '/v1/health', 200, body);
  expect(errors).toEqual([]);
});
```

This is the ultimate safety net: it tests the actual running API against the actual generated spec. If they disagree, the test fails.

## CI Pipeline Summary

```text
npm run type-check     -- Layer 1: compile-time schema enforcement
npm test               -- Layer 2: runtime validation (in test mode)
                       -- Layer 3: snapshot comparison
                       -- Layer 5: contract validation
npm run lint:api       -- Layer 4: Spectral linting
```

All four commands must pass for CI to go green.

## Anti-Hallucination Properties

This system specifically prevents AI hallucination in docs because:

1. **Descriptions come from code**: An AI can't add a fictional endpoint because the route must exist in code with a matching Zod schema
2. **Schemas come from code**: An AI can't describe a response field that doesn't exist because the Zod schema (which the TypeScript compiler checks) must match the handler
3. **Snapshot diffs are reviewable**: If an AI adds or changes an endpoint, the snapshot diff shows exactly what changed, making it trivial for a human to verify
4. **Contract tests are ground truth**: Even if an AI writes a schema that compiles and passes types, the contract test will fail if the actual API response doesn't match

The only thing an AI can hallucinate without getting caught is the prose in `description` fields. Spectral can enforce they exist, but not that they're accurate. This is an acceptable trade-off -- descriptions are easy for humans to verify in PR review.
