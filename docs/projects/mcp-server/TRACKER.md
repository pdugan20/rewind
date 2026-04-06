# MCP Server -- Task Tracker

## Phase 1: Project Scaffold & Transport Validation -- COMPLETE

- [x] **1.1** Initialize `rewind-mcp-server` package (package.json with bin field, TypeScript config, `@modelcontextprotocol/sdk` + `zod` deps)
- [x] **1.2** Build HTTP client module for `api.rewind.rest` (base URL from env, Bearer auth, typed fetch wrapper, default limit of 10 on list endpoints)
- [x] **1.3** Set up McpServer with StdioServerTransport and basic `get_health` tool as smoke test
- [x] **1.4** **Remote transport spike:** `WebStandardStreamableHTTPServerTransport` confirmed compatible with CF Workers -- uses Web Standard `Request`/`Response`, includes Hono example in SDK docs
- [x] **1.5** Add build script (tsc), verify `npx .` works locally
- [x] **1.6** Add `.mcp.json` to repo root for local development/testing with Claude Code
- [x] **1.7** Verify server connects and `get_health` tool works in Claude Desktop
- [x] **1.8** Create dedicated MCP API key (`mcp-server`, read scope) -- stored in `.dev.vars` as `REWIND_MCP_KEY`

## Phase 2: Core Tools -- COMPLETE

30 tools implemented with Zod input schemas, formatted text responses, `isError: true` on all error paths, and `readOnlyHint: true` annotations.

**2.1 -- Listening Domain (9 tools)**

- [x] **2.1.1** `get_now_playing` -- current track
- [x] **2.1.2** `get_recent_listens` -- recent scrobbles (with limit param)
- [x] **2.1.3** `get_listening_stats` -- overall stats
- [x] **2.1.4** `get_top_artists` -- top artists (period param: 7day, 1month, 3month, 6month, 12month, overall)
- [x] **2.1.5** `get_top_albums` -- top albums (same period param)
- [x] **2.1.6** `get_top_tracks` -- top tracks (same period param)
- [x] **2.1.7** `get_listening_streaks` -- streak data
- [x] **2.1.8** `get_artist_details` -- artist by ID
- [x] **2.1.9** `get_album_details` -- album by ID

**2.2 -- Running Domain (6 tools)**

- [x] **2.2.1** `get_running_stats` -- overall stats
- [x] **2.2.2** `get_recent_runs` -- recent activities
- [x] **2.2.3** `get_personal_records` -- PRs
- [x] **2.2.4** `get_running_streaks` -- streak data
- [x] **2.2.5** `get_activity_details` -- single run details
- [x] **2.2.6** `get_activity_splits` -- per-mile splits with pace, elevation, heart rate

**2.3 -- Watching Domain (4 tools)**

- [x] **2.3.1** `get_recent_watches` -- recently watched
- [x] **2.3.2** `get_movie_details` -- movie by ID
- [x] **2.3.3** `get_watching_stats` -- overall stats
- [x] **2.3.4** `browse_movies` -- browse by genre, decade, director, year with sorting

**2.4 -- Collecting Domain (4 tools)**

- [x] **2.4.1** `get_vinyl_collection` -- browse vinyl (with pagination, search, filters)
- [x] **2.4.2** `get_collecting_stats` -- collection stats
- [x] **2.4.3** `get_physical_media` -- browse Blu-ray, 4K UHD, HD DVD collection
- [x] **2.4.4** `get_physical_media_stats` -- physical media format breakdown

**2.5 -- Reading Domain (4 tools)**

- [x] **2.5.1** `get_recent_reads` -- recently saved articles
- [x] **2.5.2** `get_reading_highlights` -- highlights list
- [x] **2.5.3** `get_random_highlight` -- single random highlight
- [x] **2.5.4** `get_reading_stats` -- reading statistics

**2.6 -- Cross-Domain (3 tools)**

- [x] **2.6.1** `search` -- full-text search (query, optional domain filter)
- [x] **2.6.2** `get_feed` -- unified activity feed (with date filter params)
- [x] **2.6.3** `get_on_this_day` -- historical items for today's date

## Phase 3: Resources & Prompts -- COMPLETE

**3.1 -- Resources**

- [x] **3.1.1** `rewind://sync/status` -- sync health per domain
- [x] **3.1.2** `rewind://listening/year/{year}` -- listening year-in-review
- [x] **3.1.3** `rewind://running/year/{year}` -- running year-in-review
- [x] **3.1.4** `rewind://watching/year/{year}` -- watching year-in-review

**3.2 -- Prompts**

- [x] **3.2.1** `weekly-summary` prompt template
- [x] **3.2.2** `year-in-review` prompt template
- [x] **3.2.3** `compare-periods` prompt template

## Phase 4: Remote Transport & Deployment

- [x] **4.1** Implement dual transport entry points (stdio for local, Streamable HTTP for remote)
- [x] **4.2** Create Cloudflare Worker project for hosting (`mcp.rewind.rest`) -- wrangler.toml, worker.ts, dry-run verified (155KB gzipped)
- [x] **4.3** Implement auth for remote transport (Bearer token passthrough -- user's own API key forwarded to api.rewind.rest)
- [x] **4.4** Handle multi-tenancy (each request creates a fresh RewindClient with the caller's API key -- stateless, no server-side state)
- [x] **4.5** Deploy to Cloudflare Workers (automated via CI on main push and tag)
- [x] **4.6** Configure DNS for `mcp.rewind.rest` (live, returns 200)
- [x] **4.7** Test with claude.ai Integrations (web) -- OAuth flow via GitHub, remote server at mcp.rewind.rest
- [x] **4.8** Test with Claude iOS app -- synced from web automatically
- [x] **4.9** Test with Claude Desktop (stdio path, end-to-end) -- works with nvm full path workaround

## Phase 5: Publish & Distribution

- [x] **5.1** Write README (compact: badges, one config block, tool summary table, example queries)
- [x] **5.2** GitHub Actions workflow (`.github/workflows/mcp-server.yml`) -- builds on PR/push, publishes to npm on `mcp-server-v*` tag with OIDC provenance, deploys Worker on main push, creates GitHub Release
- [x] **5.3** npm Trusted Publishing via OIDC (no stored NPM_TOKEN -- uses GitHub Actions id-token)
- [x] **5.4** First publish: `rewind-mcp-server@0.1.0` live on npm
- [x] **5.5** Publish `rewind-mcp-server@0.1.1` with provenance via trusted publishing (Node 24 required for npm 11+ OIDC support)
- [x] **5.6** Set up release-please for automated versioning and changelog from conventional commits (PAT stored as RELEASE_PLEASE_TOKEN)
- [x] **5.7** Update README with mobile/web instructions and broader MCP client framing (Desktop Apps, Mobile & Web, Claude Code)
- [ ] ~~**5.8** List on mcp.so (community directory)~~ -- deferred
- [ ] ~~**5.9** List on smithery.ai (registry with one-click install)~~ -- deferred
- [x] **5.10** Add `.mcp.json` to this repo (production config)
- [x] **5.11** Add MCP server section to docs.rewind.rest (Mintlify MDX page with capability cards, tool tables, example queries, security section, changelog entry)
- [x] **5.12** Tag GitHub repo with `mcp-server` and `mcp` topics

## Phase 6: Connectors Directory Readiness

Non-OAuth requirements for Anthropic Connectors Directory submission.

**6.1 -- Tool Annotations -- COMPLETE**

- [x] **6.1.1** Add `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true` annotations to all tools

**6.2 -- Rate Limiting & Security -- COMPLETE**

- [x] **6.2.1** Add per-IP rate limiting to the remote Worker (120 RPM sliding window, 429 with Retry-After header)
- [x] **6.2.2** Validate response sizes stay under 25,000 token limit -- all tools capped at limit=50, worst case ~5K chars

**6.3 -- Privacy & Legal -- COMPLETE**

- [x] **6.3.1** MCP connector section added to existing privacy policy at `rewind.rest/privacy`
- [x] **6.3.2** Data Processing Agreement written at `rewind.rest/dpa`
- [x] **6.3.3** Deploy updated landing site -- privacy policy and DPA live

**6.4 -- QA & Submission Prep**

- [ ] **6.4.1** Create read-only test account with sample data across all domains for Anthropic QA
- [ ] **6.4.2** Run pre-submission checklist from Anthropic's remote connector guide
- [ ] **6.4.3** Submit to Connectors Directory review form

**6.5 -- OAuth 2.0 via GitHub (see OAUTH-PROPOSAL.md for design rationale)**

Infrastructure:

- [x] **6.5.1** Add `@cloudflare/workers-oauth-provider` dependency to mcp-server
- [x] **6.5.2** Add KV namespace `OAUTH_KV` binding to wrangler.toml
- [x] **6.5.3** Create KV namespace and update wrangler.toml with ID
- [x] **6.5.4** Create GitHub OAuth App, callback: `https://mcp.rewind.rest/callback`
- [x] **6.5.5** Store secrets: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, REWIND_API_KEY, USER_ALLOWLIST

Implementation:

- [x] **6.5.6** Implement GitHub auth module (`github-auth.ts`)
- [x] **6.5.7** Implement OAuth-aware worker (`worker.ts`)
- [x] **6.5.8** Build consent HTML page (`consent.ts`)
- [x] **6.5.9** Well-known OAuth endpoints handled by `workers-oauth-provider`
- [x] **6.5.10** Configure token lifetimes: 1h access, 90d refresh, S256-only PKCE
- [x] **6.5.11** User allowlist via `USER_ALLOWLIST` env var
- [ ] **6.5.12** Pre-provision Anthropic QA test user with sample data across all domains

Verification:

- [ ] **6.5.14** Test full OAuth flow with Claude Desktop
- [x] **6.5.15** Test full OAuth flow with claude.ai Integrations
- [x] **6.5.16** Verify stdio transport (Claude Code / local Desktop) still works with `REWIND_API_KEY`

**6.6 -- Visual Design & Polish**

Depends on logo/favicon work tracked in `docs/projects/docs-site-improvements/TRACKER.md`.

- [ ] **6.6.0** Add logo to GitHub OAuth App
- [ ] **6.6.1** Polish OAuth consent page: add logo, match landing site colors/typography, test on mobile
- [ ] **6.6.2** Style privacy policy MCP section and DPA page
- [ ] **6.6.3** Add logo to Mintlify MCP server docs page header
- [ ] **6.6.4** Create OG image for MCP docs page
- [ ] **6.6.5** Review consent page in actual OAuth flow (desktop + mobile browser)
- [ ] **6.6.6** Add Rewind logo + favicon to consent page

## Phase 7: Developer Tooling & Testing

**7.1 -- MCP Inspector**

- [x] **7.1.1** Add `"inspect"` script to package.json (`npx @modelcontextprotocol/inspector node dist/index.js`)
- [x] **7.1.2** Validate all tools, resources, and prompts via Inspector UI
- [x] **7.1.3** Document Inspector usage in INSTALLATION.md

**7.2 -- Unit Tests -- COMPLETE**

- [x] **7.2.1** Set up test framework (Vitest) for mcp-server (own vitest.config.ts)
- [x] **7.2.2** Write tests using MCP SDK client classes with in-memory transport (`server.test.ts`)
- [x] **7.2.3** Test each tool returns well-formed responses (text content, no raw JSON, isError on failures)
- [x] **7.2.4** Test error handling and response content quality
- [x] **7.2.5** Tests run in MCP Server CI workflow (`npm test` in build job). Root Vitest excludes `mcp-server/` to avoid SDK resolution conflicts.
