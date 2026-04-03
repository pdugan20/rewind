# MCP Server -- Task Tracker

## Phase 1: Project Scaffold & Transport Validation -- COMPLETE

- [x] **1.1** Initialize `rewind-mcp-server` package (package.json with bin field, TypeScript config, `@modelcontextprotocol/sdk` + `zod` deps)
- [x] **1.2** Build HTTP client module for `api.rewind.rest` (base URL from env, Bearer auth, typed fetch wrapper, default limit of 10 on list endpoints)
- [x] **1.3** Set up McpServer with StdioServerTransport and basic `get_health` tool as smoke test
- [x] **1.4** **Remote transport spike:** `WebStandardStreamableHTTPServerTransport` confirmed compatible with CF Workers -- uses Web Standard `Request`/`Response`, includes Hono example in SDK docs
- [x] **1.5** Add build script (tsc), verify `npx .` works locally
- [x] **1.6** Add `.mcp.json` to repo root for local development/testing with Claude Code
- [ ] **1.7** Verify server connects and `get_health` tool works in Claude Desktop
- [ ] **1.8** Create dedicated MCP API key with higher rate limit (120+ RPM) via admin endpoint

## Phase 2: Core Tools -- COMPLETE

All 26 tools implemented with Zod input schemas, formatted text responses, and `isError: true` on all error paths.

**2.1 -- Listening Domain**

- [x] **2.1.1** `get_now_playing` -- current track
- [x] **2.1.2** `get_recent_listens` -- recent scrobbles (with limit param)
- [x] **2.1.3** `get_listening_stats` -- overall stats
- [x] **2.1.4** `get_top_artists` -- top artists (period param: 7day, 1month, 3month, 6month, 12month, overall)
- [x] **2.1.5** `get_top_albums` -- top albums (same period param)
- [x] **2.1.6** `get_top_tracks` -- top tracks (same period param)
- [x] **2.1.7** `get_listening_streaks` -- streak data
- [x] **2.1.8** `get_artist_details` -- artist by ID
- [x] **2.1.9** `get_album_details` -- album by ID

**2.2 -- Running Domain**

- [x] **2.2.1** `get_running_stats` -- overall stats
- [x] **2.2.2** `get_recent_runs` -- recent activities
- [x] **2.2.3** `get_personal_records` -- PRs
- [x] **2.2.4** `get_running_streaks` -- streak data
- [x] **2.2.5** `get_activity_details` -- single run with splits

**2.3 -- Watching Domain**

- [x] **2.3.1** `get_recent_watches` -- recently watched
- [x] **2.3.2** `get_movie_details` -- movie by ID
- [x] **2.3.3** `get_watching_stats` -- overall stats

**2.4 -- Collecting Domain**

- [x] **2.4.1** `get_vinyl_collection` -- browse vinyl (with pagination, default limit 10)
- [x] **2.4.2** `get_collecting_stats` -- collection stats

**2.5 -- Reading Domain**

- [x] **2.5.1** `get_recent_reads` -- recently saved articles
- [x] **2.5.2** `get_reading_highlights` -- highlights list
- [x] **2.5.3** `get_random_highlight` -- single random highlight
- [x] **2.5.4** `get_reading_stats` -- reading statistics

**2.6 -- Cross-Domain**

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
- [ ] **4.5** Deploy to Cloudflare Workers (`npx wrangler deploy` from mcp-server/)
- [ ] **4.6** Configure DNS for `mcp.rewind.rest` (Cloudflare custom domain auto-provisions)
- [ ] **4.7** Test with claude.ai Integrations (web)
- [ ] **4.8** Test with Claude iOS app
- [ ] **4.9** Test with Claude Desktop (stdio path, end-to-end)

## Phase 5: Publish & Distribution

- [x] **5.1** Write README (compact: badges, one config block, tool summary table, example queries)
- [x] **5.2** GitHub Actions workflow (`.github/workflows/mcp-server.yml`) -- builds on PR/push, publishes to npm on `mcp-server-v*` tag, deploys Worker on main push
- [x] **5.3** Add `NPM_TOKEN` secret to GitHub repo settings
- [x] **5.4** First publish: `rewind-mcp-server@0.1.0` live on npm
- [ ] **5.5** Set up npm Trusted Publishing (replace token with OIDC -- now that package exists on npm)
- [ ] **5.6** Set up release-please for automated versioning and changelog from conventional commits
- [ ] **5.7** Update README with iOS/web instructions after OAuth is tested end-to-end
- [ ] **5.8** List on mcp.so (community directory)
- [ ] **5.9** List on smithery.ai (registry with one-click install)
- [x] **5.10** Add `.mcp.json` to this repo (production config)
- [x] **5.11** Add MCP server section to docs.rewind.rest (Mintlify MDX page with install tabs, tool tables, example conversations)
- [ ] **5.12** Tag GitHub repo with `mcp-server` topic

## Phase 6: Connectors Directory Readiness

Non-OAuth requirements for Anthropic Connectors Directory submission.

**6.1 -- Tool Annotations -- COMPLETE**

- [x] **6.1.1** Add `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true` annotations to all 27 tools (including get_health)

**6.2 -- Rate Limiting & Security -- COMPLETE**

- [x] **6.2.1** Add per-IP rate limiting to the remote Worker (120 RPM sliding window, 429 with Retry-After header)
- [x] **6.2.2** Validate response sizes stay under 25,000 token limit -- all tools capped at limit=50, worst case ~5K chars

**6.3 -- Privacy & Legal**

- [x] **6.3.1** MCP connector section added to existing privacy policy at `rewind.rest/privacy` (covers data flow, OAuth tokens, Anthropic data handling, disconnecting)
- [x] **6.3.2** Data Processing Agreement written at `rewind.rest/dpa` (data categories, sub-processors, security measures, data subject rights, retention, breach notification)
- [x] **6.3.3** Deploy updated landing site -- privacy policy and DPA live at rewind.rest/privacy and rewind.rest/dpa

**6.4 -- QA & Submission Prep**

- [ ] **6.4.1** Create read-only test account with sample data across all domains for Anthropic QA
- [ ] **6.4.2** Run pre-submission checklist from Anthropic's remote connector guide
- [ ] **6.4.3** Submit to Connectors Directory review form

**6.5 -- OAuth 2.0 via GitHub (see OAUTH-PROPOSAL.md for design rationale)**

Infrastructure:

- [x] **6.5.1** Add `@cloudflare/workers-oauth-provider` dependency to mcp-server
- [x] **6.5.2** Add KV namespace `OAUTH_KV` binding to wrangler.toml (ID needs to be filled after `npx wrangler kv namespace create OAUTH_KV`)
- [x] **6.5.3** Create KV namespace and update wrangler.toml with ID `78305332b9b44b138ad56dcad3d6d569`
- [x] **6.5.4** Create GitHub OAuth App (https://github.com/settings/applications/3506939), callback: `https://mcp.rewind.rest/callback`
- [x] **6.5.5** Store secrets: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, REWIND_API_KEY, USER_ALLOWLIST (pdugan20 -> user_id 1)

Implementation:

- [x] **6.5.6** Implement GitHub auth module (`github-auth.ts` -- code exchange, user ID lookup)
- [x] **6.5.7** Implement OAuth-aware worker (`worker.ts` -- `OAuthProvider` with GitHub upstream delegation, rate limiting, MCP handler)
- [x] **6.5.8** Build consent HTML page (`consent.ts` -- "Sign in with GitHub" button, scope display, Rewind branding, dark theme)
- [x] **6.5.9** `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` handled automatically by `workers-oauth-provider`
- [x] **6.5.10** Configure token lifetimes: 1h access, 90d refresh, S256-only PKCE
- [x] **6.5.11** User allowlist via `USER_ALLOWLIST` env var (JSON map of GitHub user ID -> Rewind user_id)
- [ ] **6.5.12** Pre-provision Anthropic QA test user with sample data across all domains

**6.6 -- Visual Design & Polish**

Depends on logo/favicon work tracked in `docs/projects/docs-site-improvements/TRACKER.md` (Phase 4.1-4.4). These tasks cover MCP-specific design and ensuring new pages match the site.

- [ ] **6.6.0** Add logo to GitHub OAuth App (https://github.com/settings/applications/3506939)
- [ ] **6.6.1** Polish OAuth consent page (`consent.ts`): add logo, match landing site colors/typography, test on mobile
- [ ] **6.6.2** Style privacy policy MCP section and DPA page: review layout in landing site context, ensure consistent formatting with existing legal pages
- [ ] **6.6.3** Add logo to Mintlify MCP server docs page header
- [ ] **6.6.4** Create OG image for MCP docs page (for link previews when sharing docs.rewind.rest/mcp-server)
- [ ] **6.6.5** Review consent page in actual OAuth flow (desktop + mobile browser) and fix any layout issues
- [ ] **6.6.6** Add Rewind logo + favicon to consent page (standalone HTML, not part of docs/landing site)

Cross-project dependencies (tracked in docs-site-improvements):

- Logo design (4.1.1) -- needed for consent page, docs, landing site
- Favicon generation (4.2.1) -- needed for consent page
- Theme alignment (4.4) -- landing site + docs + consent page should all match

Verification:

- [ ] **6.5.14** Test full OAuth flow with Claude Desktop (should trigger browser auth via GitHub, then connect)
- [ ] **6.5.15** Test full OAuth flow with claude.ai Integrations
- [ ] **6.5.16** Verify stdio transport (Claude Code / local Desktop) still works with `REWIND_API_KEY` -- OAuth does not apply to stdio
