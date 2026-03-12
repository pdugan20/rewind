# Public API Docs -- Task Tracker

> **Prerequisite**: The reliability-improvements project (Phases 4, 6, 9.2) has been completed.
> Admin paths are normalized, new endpoints (browse, ratings, year-in-review) are in place,
> and response envelopes are consistent. The API surface is stable and ready to document.

## Phase 1: OpenAPI Foundation

Set up `@hono/zod-openapi`, convert `system.ts` as a proof of concept, and expose the spec endpoint.

**1.1 -- Dependencies and Setup**

- [x] **1.1.1** Install `@hono/zod-openapi` package
- [x] **1.1.2** Create `src/lib/openapi.ts` -- shared OpenAPI app factory with base metadata (title, version, servers, security schemes, contact info)
- [x] **1.1.3** Create `src/lib/schemas/common.ts` -- reusable Zod schemas for shared response shapes (error envelope, pagination envelope, image attachment)

**1.2 -- Proof of Concept: system.ts**

- [x] **1.2.1** Convert `GET /v1/health` to zod-openapi route with request/response schemas
- [x] **1.2.2** Convert `GET /v1/health/sync` to zod-openapi route with response schema
- [x] **1.2.3** Verify existing tests still pass after conversion
- [ ] **1.2.4** Verify the route still works identically via `npm run dev` + manual curl _(deferred to next dev session)_

**1.3 -- Spec Endpoint**

- [x] **1.3.1** Add `GET /v1/openapi.json` route that returns the generated spec
- [x] **1.3.2** Set appropriate Cache-Control headers (short TTL, public)
- [ ] **1.3.3** Add CORS header for `docs.rewind.rest` origin _(deferred to Phase 3 when docs site exists)_
- [x] **1.3.4** Write a test that fetches `/v1/openapi.json` and validates it's valid OpenAPI 3.1

## Phase 2: Route Migration

Convert all route files to zod-openapi. Each sub-phase is one route file. Order is simplest-first to build momentum and establish patterns.

**2.1 -- keys.ts** (3 endpoints)

- [x] **2.1.1** Define Zod schemas for API key request/response shapes
- [x] **2.1.2** Convert all 3 endpoints to zod-openapi routes
- [x] **2.1.3** Verify existing tests pass

**2.2 -- search.ts** (1 endpoint)

- [x] **2.2.1** Define Zod schemas for search query params and response
- [x] **2.2.2** Convert endpoint to zod-openapi route
- [x] **2.2.3** Verify existing tests pass

**2.3 -- feed.ts** (2 endpoints)

- [x] **2.3.1** Define Zod schemas for feed response shapes
- [x] **2.3.2** Convert both endpoints to zod-openapi routes
- [x] **2.3.3** Verify existing tests pass

**2.4 -- export.ts** (1 endpoint)

- [x] **2.4.1** Define Zod schemas for export response
- [x] **2.4.2** Convert endpoint to zod-openapi route
- [x] **2.4.3** Verify existing tests pass

**2.5 -- images.ts** (5 endpoints)

- [x] **2.5.1** Define Zod schemas for image proxy, admin override, and reprocess request/response shapes
- [x] **2.5.2** Convert all 5 endpoints to zod-openapi routes
- [x] **2.5.3** Verify existing tests pass

**2.6 -- webhooks.ts** (3 endpoints)

- [x] **2.6.1** Define Zod schemas for webhook payloads
- [x] **2.6.2** Convert all 3 endpoints to zod-openapi routes
- [x] **2.6.3** Verify existing tests pass
- [x] **2.6.4** Decide: mark as `x-internal: true` or exclude from public spec entirely

**2.7 -- admin-sync.ts** (7 endpoints)

- [x] **2.7.1** Define Zod schemas for sync trigger request/response shapes and admin operations (delete activity, recompute stats)
- [x] **2.7.2** Convert all 7 endpoints to zod-openapi routes
- [x] **2.7.3** Verify existing tests pass

**2.8 -- collecting.ts** (19 endpoints)

- [x] **2.8.1** Define Zod schemas for Discogs collection, Trakt media collection, wantlist, stats, and admin shapes
- [x] **2.8.2** Convert all public GET endpoints to zod-openapi routes
- [x] **2.8.3** Convert all admin POST endpoints to zod-openapi routes
- [x] **2.8.4** Verify existing tests pass

**2.9 -- watching.ts** (19 endpoints)

- [x] **2.9.1** Define Zod schemas for movie, show, episode, watch history, ratings, reviews, year-in-review shapes
- [x] **2.9.2** Convert all public GET endpoints to zod-openapi routes
- [x] **2.9.3** Convert all admin POST/PUT/DELETE endpoints to zod-openapi routes
- [x] **2.9.4** Verify existing tests pass

**2.10 -- running.ts** (19 endpoints)

- [x] **2.10.1** Define Zod schemas for activity, stats, year summary, streak, charts, races, eddington shapes
- [x] **2.10.2** Convert all public GET endpoints to zod-openapi routes
- [x] **2.10.3** Verify existing tests pass

**2.11 -- listening.ts** (19 endpoints)

- [x] **2.11.1** Define Zod schemas for scrobble, top list, stats, streak, calendar, browse, year-in-review shapes
- [x] **2.11.2** Convert all public GET endpoints to zod-openapi routes
- [x] **2.11.3** Convert all admin endpoints to zod-openapi routes
- [x] **2.11.4** Verify existing tests pass

## Phase 3: Scalar Docs Site

Set up the documentation site on Cloudflare Pages with Scalar.

**3.1 -- Scalar Configuration**

- [x] **3.1.1** Create `docs-site/` directory at project root with a static Scalar HTML page that loads from `/v1/openapi.json`
- [x] **3.1.2** Configure Scalar theme, colors, and branding to match Rewind aesthetic
- [x] **3.1.3** Configure Scalar authentication section (show Bearer token pattern, explain read vs admin keys)
- [x] **3.1.4** Add a custom introduction/overview section via Scalar's description markdown

**3.2 -- Cloudflare Pages Deployment**

- [ ] **3.2.1** Create Cloudflare Pages project linked to the repo (build output: `docs-site/`) _(requires Cloudflare dashboard or CLI with account access)_
- [ ] **3.2.2** Configure custom domain `docs.rewind.rest` with CNAME _(requires Cloudflare dashboard)_
- [ ] **3.2.3** Verify the docs site loads and renders the spec correctly _(after deploy)_
- [x] **3.2.4** Add deploy script to `package.json` (e.g., `npm run docs:deploy`)

## Phase 4: CI Enforcement

Automated checks that prevent doc drift, hallucination, and spec quality regression.

**4.1 -- Spectral Linting**

- [ ] **4.1.1** Install `@stoplight/spectral-cli` as a dev dependency
- [ ] **4.1.2** Create `.spectral.yml` ruleset (enforce descriptions on all operations, enforce examples on common schemas, enforce consistent naming)
- [ ] **4.1.3** Add `npm run lint:api` script that generates the spec and runs Spectral against it
- [ ] **4.1.4** Add Spectral to the GitHub Actions CI workflow

**4.2 -- Spec Snapshot Test**

- [ ] **4.2.1** Write a Vitest test that generates the OpenAPI spec and compares it to a committed `openapi.snapshot.json`
- [ ] **4.2.2** Add a script `npm run spec:update` to regenerate the snapshot intentionally
- [ ] **4.2.3** Document the workflow: if a route changes, the snapshot test fails, developer runs `spec:update` and commits the diff -- this makes spec changes visible in PR reviews

**4.3 -- Contract Tests**

- [ ] **4.3.1** Install `openapi-response-validator` as a dev dependency
- [ ] **4.3.2** Write a test helper that loads the generated spec and validates a response object against a given operation + status code
- [ ] **4.3.3** Add contract test assertions to at least one test per route file (validates the actual response matches the schema in the spec)
- [ ] **4.3.4** Add contract tests to CI

**4.4 -- Type-Level Enforcement**

- [ ] **4.4.1** Enable `.output()` validation on zod-openapi routes in test/dev mode (validates response bodies at runtime against the Zod schema)
- [ ] **4.4.2** Verify TypeScript compile errors if a handler returns a shape that doesn't match the declared response schema

## Phase 5: Spec Quality

Polish the spec with descriptions, examples, and organization so the docs are genuinely useful.

**5.1 -- Descriptions and Examples**

- [ ] **5.1.1** Add summary and description to every operation (1-2 sentences each)
- [ ] **5.1.2** Add example values to all common schemas (pagination, error, image attachment)
- [ ] **5.1.3** Add example request/response pairs for the 5 most-used endpoints (now-playing, recent, top artists, activities, movies)

**5.2 -- Organization**

- [ ] **5.2.1** Group operations by tag: Listening, Running, Watching, Collecting, Feed, Images, System, Admin
- [ ] **5.2.2** Add tag descriptions explaining each domain
- [ ] **5.2.3** Order tags logically in the spec (public domains first, admin last)

**5.3 -- Authentication Documentation**

- [ ] **5.3.1** Document the two key types (read vs admin) and their permission scopes
- [ ] **5.3.2** Add a "Getting Started" section to the Scalar intro explaining how to obtain a key
- [ ] **5.3.3** Mark admin-only endpoints clearly in the spec (separate tag or `x-admin-only` extension)

**5.4 -- Error Catalog**

- [ ] **5.4.1** Document all error response shapes with examples (400, 401, 404, 429, 500)
- [ ] **5.4.2** Add error responses to every operation definition (not just 200)

## Phase 6: Launch

Final steps to go live.

**6.1 -- Pre-Launch Checklist**

- [ ] **6.1.1** Verify all route files are migrated and spec is complete
- [ ] **6.1.2** Verify Spectral lint passes with zero warnings
- [ ] **6.1.3** Verify all contract tests pass
- [ ] **6.1.4** Verify `docs.rewind.rest` loads correctly and all endpoints are documented
- [ ] **6.1.5** Test the Scalar "Try It" feature with a read-only demo key
- [ ] **6.1.6** Review the full rendered docs for accuracy, completeness, and clarity

**6.2 -- Go Live**

- [ ] **6.2.1** Add `docs.rewind.rest` to the CORS allowed origins in the API
- [ ] **6.2.2** Update the project README with a link to the public docs
- [ ] **6.2.3** Update `docs/API.md` to note that the canonical reference is now `docs.rewind.rest`
- [ ] **6.2.4** Update `docs/ROADMAP.md` to reference this project
