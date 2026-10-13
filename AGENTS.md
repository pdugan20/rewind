# Rewind

## Work modes

- Default to exploration for UI, documentation, prototypes, and small changes. Make focused edits directly; do not require a formal spec, separate plan, worktree, or TDD.
- Apply production rigor when the user explicitly asks to ship, harden, prepare a release, or use strict TDD. Match verification to risk and obey any stronger test requirements below.
- Ask before deployments, remote D1 migrations, production-data changes, live API mutations, releases, or security-rule changes. A user request naming the exact mutation and target counts as approval for that operation.

Personal data aggregation service. Syncs data from Strava, Last.fm, Discogs, Plex, Letterboxd, and Instapaper into Cloudflare D1, serves via REST API at `api.rewind.rest` with an image CDN at `cdn.rewind.rest`. MCP server published as `rewind-mcp-server` on npm, deployed as a Cloudflare Worker at `mcp.rewind.rest`.

## Development Commands

```bash
npm run dev          # Start local dev server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
npm run db:generate  # Generate Drizzle migrations from schema changes
npm run db:migrate   # Apply migrations to local D1
npm run db:remote    # Apply migrations to remote D1
npm run db:studio    # Open Drizzle Studio (local D1)
npm run lint         # ESLint
npm run format       # Prettier
npm run lint:claude  # claudelint (validate agent instruction files)
npm test             # Vitest
```

## Agent configuration

- `AGENTS.md` is the canonical cross-agent guide; `CLAUDE.md` is only a compatibility shim.
- Repository skills live in `.agents/skills`. Claude consumes those same files through symlinks in
  `.claude/skills`; do not maintain a second copy.
- Keep domain procedures such as adding and finding media project-scoped. General design, delivery, review, and
  hardening workflows come from the global agent-tooling setup.
- See `.agents/skills/README.md` for the project inventory and mutation boundaries.

## Architecture Overview

Hono on Cloudflare Workers with D1 (SQLite) for structured data, R2 for image storage, and Cloudflare Images for on-the-fly transforms. Drizzle ORM for type-safe database access. Hono RPC for end-to-end type inference with consuming clients. All routes prefixed with `/v1/`. Data routes use Bearer API keys; see the exceptions below. User IDs are part of the schema, but do not imply complete multi-tenant isolation.

Six data domains: listening (Last.fm + Apple Music), running (Strava), watching (Plex + Letterboxd + manual), collecting (Discogs + Trakt), reading (Instapaper), attending (Google Calendar + Gmail). Each domain has its own sync worker (cron-triggered), database tables, and route handlers.

## Source map

- [Architecture](docs/ARCHITECTURE.md) explains the system and links to implementation entry points.
- [Documentation index](docs/README.md) lists current guides and project history.
- [Documentation maintenance](docs/MAINTENANCE.md) defines sources of truth, regeneration, and required checks.
- Routes and response schemas live in `src/routes/`; database schemas live in `src/db/schema/`.
- The separate artwork Worker lives in `src/cd-artwork-worker.ts`; MCP registrations live in `mcp-server/src/`.

## Key Conventions

- All route handlers return JSON with consistent shapes
- Data endpoints require `Authorization: Bearer rw_...`. `/v1/health`, `/v1/health/sync`, and `/v1/openapi.json` are public; webhooks use provider-specific verification. Read keys access read routes; admin routes require admin keys.
- Scope owner-bearing queries to the authenticated user; a default `user_id` does not establish isolation.
- Error responses: `{ "error": "message", "status": 404 }`
- Cache-Control headers set per endpoint group (see docs/ARCHITECTURE.md)
- Image responses include `dominant_color` and `accent_color` hex values alongside `thumbhash`
- No emojis in logging -- use `[INFO]`, `[ERROR]`, `[SYNC]` prefixes
- All dates stored and returned as ISO 8601 strings
- Pagination: `{ data: [...], pagination: { page, limit, total, total_pages } }`
- Date filtering: most list/recent/stats/feed endpoints accept optional `date` (YYYY-MM-DD), `from`, `to` (ISO 8601) query params via shared `DateFilterQuery` schema

## Documentation maintenance

For changes to API or MCP contracts, update source descriptions and regenerate snapshots/reference pages in the same change. Run `npm run docs:check` and the checks in [docs/MAINTENANCE.md](docs/MAINTENANCE.md). Keep endpoint inventories, response types, schedules, and configuration values in their authoritative sources; link to them from prose. Add new project directories to `docs/README.md`.

## Documentation style

- **No parentheticals in user-facing headings.** Reader-facing pages (`README.md`, `docs-mintlify/**`, `docs-site/src/pages/**`, public changelog entries) keep headings clean — never `## Foo (Bar)`. If you need to qualify, use an em-dash (`## Foo — Bar`), a colon (`## Foo: Bar`), or rewrite as a subhead. Internal `docs/` design notes are exempt — they're allowed to use parens for project-tracking shorthand like `## Phase 7 (deferred)`.

## Configuration

Use `src/types/env.ts` for Worker bindings and configuration types, `.dev.vars.example` as the local starter file, and `wrangler.toml` / `wrangler.cd-artwork.jsonc` for Worker configuration. The starter file is not an exhaustive inventory. Never copy actual secrets into documentation.

## Database

- D1 binding: `DB`
- R2 binding: `IMAGES`
- Drizzle config: `drizzle.config.ts`
- Schema files: `src/db/schema/*.ts`
- Migrations generated by `drizzle-kit generate` into `migrations/`

## Testing

- Vitest with `@cloudflare/vitest-pool-workers` for Workers environment
- Test files: `*.test.ts` alongside source or in `__tests__/` directories
- Run: `npm test`
