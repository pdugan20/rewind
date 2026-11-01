# Threat model

Codex Security reads this file as the repository's threat model. It describes how Rewind
works, where untrusted input enters, and the controls the code must keep.

## Scope and protected assets

Rewind aggregates one person's activity (listening, running, watching, reading, and
attending) through Cloudflare Workers: a REST API with cron jobs, an MCP server over HTTP
or local stdio, and a CD artwork Worker (`README.md`, `src/index.ts`,
`mcp-server/src/index.ts`, `src/cd-artwork-worker.ts`). Data lives in D1, R2, Vectorize,
and KV (`wrangler.toml`, `wrangler.cd-artwork.jsonc`, `mcp-server/wrangler.toml`).

Protected assets are the activity history (including running coordinates, routes, and
heart rate, and reading highlights), provider OAuth tokens, API keys, generated artwork,
and paid model and embedding capacity.

## Entry points

- **REST callers** send requests and uploads. Health and OpenAPI routes are public; data
  routes need a read key and administrative routes an admin key (`src/index.ts`,
  `src/routes/keys.ts`).
- **Provider webhooks** from Strava and Plex arrive outside Bearer authentication
  (`src/routes/webhooks.ts`).
- **MCP clients** send protocol and OAuth input, with GitHub as the identity provider;
  local owners configure stdio credentials (`mcp-server/src/worker.ts`,
  `mcp-server/src/client.ts`).
- **Providers and publishers** supply content, metadata, and URLs that Rewind fetches
  (`src/services/images/sources/og-image.ts`, `src/services/attending/allowlist.ts`).
- **Reviewers and cron jobs** drive artwork decisions (`src/cd-artwork-worker.ts`).
- **Maintainers and CI** supply imports, dependencies, migrations, and releases
  (`.github/workflows/deploy.yml`, `.github/workflows/mcp-server.yml`).

## Trust boundaries and assumptions

- API keys are random, stored as SHA-256 hashes, and checked for expiry and admin scope
  (`src/lib/auth.ts`). CORS is not authentication (`src/lib/cors.ts`).
- Rewind serves a single owner. User IDs in the schema do not establish multi-tenant
  isolation, so any authenticated access reaches the owner's data (`docs/ARCHITECTURE.md`).
- The artwork gallery trusts Cloudflare Access JWTs, and its writes require same-origin
  JSON with custom headers (`src/services/cd-artwork/gallery-auth.ts`).
- Worker bindings and CI deploy credentials are privileged.

## Sensitive data and privileged actions

Provider access and refresh tokens are stored in D1 (`src/db/schema/`). Admins create and
revoke keys and export data (`src/routes/keys.ts`, `src/routes/export.ts`). Artwork
images go to OpenAI and reading text to Voyage for embeddings
(`src/services/cd-artwork/generation.ts`, `src/services/embeddings/voyage.ts`).

## Required controls

1. **Webhook provenance.** Every webhook is verified before it writes or deletes anything:
   Strava events must match the configured subscription and athlete, Plex requests must
   carry the configured secret, payloads are bounded, and verification fails closed.
2. **Authorization.** Read, admin, export, and MCP paths check the key's scope, and the
   MCP server enforces the scopes its grants advertise.
3. **Credentials.** Exports, logs, and error responses never contain provider tokens or
   API keys, export responses are not cached, and key revocation takes effect everywhere
   within a known window.
4. **Outbound fetches.** Fetches of supplied URLs allow only HTTPS to public hosts, check
   redirects, forward no credentials, and bound bytes, decoding, and time, matching the
   artwork pipeline's checks (`src/services/cd-artwork/sources.ts`).
5. **Paid work and private artwork.** Artwork candidates stay private until approved,
   reads and reviews are authorized, uncertain generation outcomes are not retried
   blindly, and spend is bounded beyond per-isolate rate limits (`src/lib/rate-limit.ts`).
6. **Releases.** Privileged deploy jobs never run pull-request code, npm releases keep
   provenance, and release automation has the least write access it needs
   (`.github/workflows/release-please.yml`).

## Review priorities

Review webhook handlers that write or delete, then authorization and exports, then
outbound fetches, artwork billing, and CI. Treat article text returned through MCP as
untrusted content (`mcp-server/src/tools/reading.ts`).

## Uncertain assumptions

- Live Cloudflare Access and WAF policies, bucket exposure, secret scopes, and the
  deployed revisions can't be confirmed from the Worker configuration in this repository.
- Branch and tag protection, environment approvals, and CI credential privileges live in
  GitHub settings.
- Provider retention of submitted text and images, and backup and recovery guarantees,
  are not established by the code.

## When to update this model

Update it when authentication, routes, provider integrations, storage, artwork billing or
publication, or the release workflow change (`AGENTS.md`, `docs/MAINTENANCE.md`).
