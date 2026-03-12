# Project: Public API Documentation

Ship production-ready, publicly accessible API documentation at `docs.rewind.rest` that is programmatically guaranteed to match the actual API behavior.

## Motivation

Rewind is currently a personal API, but the goal is to open it up publicly. Public-facing docs are a prerequisite -- and they must be trustworthy. Hand-written docs drift. AI-generated docs hallucinate. The solution is to make the OpenAPI spec a build artifact of the route code itself, then render docs from that spec automatically.

## Architecture

```text
Route code (Hono + Zod schemas)
        |
        v
  @hono/zod-openapi
        |
        v
  GET /v1/openapi.json  (live spec served by the API)
        |
        v
  Scalar (static docs site on Cloudflare Pages)
        |
        v
  docs.rewind.rest
```

**Key principle**: The OpenAPI spec is generated from the same Zod schemas that validate requests and type-check responses at compile time. There is no separate spec file to maintain. Drift is structurally impossible.

## Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Schema layer | `@hono/zod-openapi` | First-party Hono integration, generates OpenAPI 3.1 from route definitions |
| Validation | `zod` (already installed) | Shared schemas for runtime validation + spec generation |
| Doc renderer | Scalar | Free, open source, excellent UX, single HTML page or React component |
| Hosting | Cloudflare Pages | Already on Cloudflare, free, CNAME to `docs.rewind.rest` |
| Spec linting | `@stoplight/spectral` | Industry-standard OpenAPI linter, catches missing descriptions and inconsistencies |
| Contract testing | `openapi-response-validator` | Validates actual API responses against the generated spec |

## Documents

| File | Purpose |
|------|---------|
| [TRACKER.md](TRACKER.md) | Master task tracker with 6 phases and all discrete tasks |
| [MIGRATION-GUIDE.md](MIGRATION-GUIDE.md) | How to convert a Hono route file to zod-openapi (patterns and examples) |
| [ENFORCEMENT.md](ENFORCEMENT.md) | CI pipeline design for preventing doc drift and hallucination |
| [SCALAR-SETUP.md](SCALAR-SETUP.md) | Scalar configuration and Cloudflare Pages deployment |

## Phase Summary

| Phase | Focus | Scope |
|-------|-------|-------|
| 1 | OpenAPI foundation | Install deps, convert `system.ts` as proof of concept, expose `/v1/openapi.json` |
| 2 | Route migration | Convert all 10 route files to zod-openapi, domain by domain |
| 3 | Scalar docs site | Set up Cloudflare Pages project with Scalar, configure `docs.rewind.rest` |
| 4 | CI enforcement | Spectral linting, spec snapshot tests, contract tests |
| 5 | Spec quality | Descriptions, examples, authentication docs, error catalog |
| 6 | Launch | DNS, CORS, final review, announce |

## Sequencing Notes

- Phase 1 is the proof of concept -- validates the approach before committing to a full migration
- Phase 2 is the bulk of the work and can be done incrementally (one route file per session)
- Phase 3 can start as soon as Phase 1 is done (Scalar can render a partial spec)
- Phase 4 should be in place before Phase 2 is complete, so CI catches issues during migration
- Phase 5 is polish that happens throughout but has a dedicated pass at the end
- Phase 6 is the final gate before going public

## Route File Inventory

Files to migrate in Phase 2, ordered by complexity (simplest first):

| File | Endpoints | Complexity | Notes |
|------|-----------|------------|-------|
| `system.ts` | 2 | Low | Phase 1 proof of concept |
| `keys.ts` | 3 | Low | CRUD for API keys |
| `search.ts` | 1 | Low | Single cross-domain search |
| `feed.ts` | 2 | Low | Activity feed |
| `export.ts` | 1 | Low | Data export |
| `images.ts` | 4 | Medium | Proxy + admin overrides |
| `webhooks.ts` | 2 | Medium | Strava + Plex webhooks (admin-only, may exclude from public docs) |
| `collecting.ts` | 9 | Medium | Discogs + Trakt |
| `watching.ts` | 15 | High | Movies + TV + manual entry |
| `running.ts` | 18 | High | Strava activities + stats |
| `listening.ts` | 15 | High | Last.fm scrobbles + tops + streaks |
