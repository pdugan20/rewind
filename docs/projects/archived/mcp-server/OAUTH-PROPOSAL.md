# OAuth 2.0 Implementation Proposal

## Context

The Anthropic Connectors Directory requires MCP servers to authenticate users via OAuth 2.0. The current Rewind MCP server uses static Bearer tokens (API keys). This proposal covers what's needed to meet the directory requirements with an industry-standard implementation.

## What the MCP Spec Requires

The MCP authorization specification (2025-03-26) mandates:

- **OAuth 2.1** compliance (draft-ietf-oauth-v2-1-12)
- **Authorization Code grant with PKCE** (S256 only -- plain not allowed)
- **RFC 8414** Authorization Server Metadata (`/.well-known/oauth-authorization-server`)
- **RFC 9728** Protected Resource Metadata (`/.well-known/oauth-protected-resource`)
- **RFC 7591** Dynamic Client Registration (SHOULD support)
- All auth endpoints served over HTTPS
- Bearer tokens on every HTTP request

Machine-to-machine (client credentials) is explicitly rejected by both the MCP spec and Anthropic.

## How Claude Connects

When a user clicks "Connect" on a connector in Claude:

1. Claude hits `mcp.rewind.rest/mcp` and gets **HTTP 401** (triggering the auth flow)
2. Claude discovers auth endpoints via `GET /.well-known/oauth-authorization-server`
3. Claude registers itself via **Dynamic Client Registration** at `POST /register`
4. Claude generates PKCE `code_verifier`/`code_challenge` and opens a browser to `/authorize`
5. User sees a consent screen, authenticates, approves
6. Server redirects back with an authorization code
7. Claude exchanges the code for tokens at `POST /token`
8. All subsequent MCP requests include `Authorization: Bearer <access_token>`

Auth endpoints live at the **domain root** (`mcp.rewind.rest/authorize`), not under the MCP path.

## Recommended Architecture

### Use `@cloudflare/workers-oauth-provider`

Cloudflare publishes an OAuth 2.1 provider library purpose-built for Workers. It handles:

- OAuth 2.1 with PKCE (S256)
- RFC 8414 metadata endpoint
- RFC 9728 protected resource metadata
- RFC 7591 Dynamic Client Registration
- Token lifecycle (issuance, refresh, rotation, revocation)
- Encrypted token storage in Workers KV
- CSRF protection via state parameter
- Rate limiting on auth endpoints

This is the same library Cloudflare uses for their own MCP servers. It eliminates implementing the OAuth protocol from scratch.

### Where It Lives

The OAuth server runs **on the MCP worker** (`mcp.rewind.rest`), not on `api.rewind.rest`. The main API stays unchanged.

```
Claude  ──OAuth 2.1──>  mcp.rewind.rest  ──static API key──>  api.rewind.rest
         (user-facing)   (OAuth + MCP)      (internal, unchanged)
```

After OAuth completes, the MCP server has the authenticated user context. It continues to call `api.rewind.rest` with the existing static API key as a trusted server-to-server credential. The API key becomes an internal implementation detail, never exposed to end users.

### Infrastructure Additions

| Resource                           | Purpose             | Notes                                                                                                                           |
| ---------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **KV namespace** (`OAUTH_KV`)      | Token storage       | Encrypted at rest by `workers-oauth-provider`. Stores hashed client secrets, auth codes, access/refresh tokens.                 |
| **Login/consent page**             | User authentication | Simple HTML page served by the worker. User enters a passphrase to authenticate and sees requested scopes to approve.           |
| **User accounts table** (optional) | Multi-user support  | If staying single-user, a password hash stored as a Worker secret is sufficient. For multi-user, add `oauth_users` table to D1. |

### Endpoints Added to `mcp.rewind.rest`

| Endpoint                                  | Method   | Purpose                                                        |
| ----------------------------------------- | -------- | -------------------------------------------------------------- |
| `/.well-known/oauth-authorization-server` | GET      | RFC 8414 server metadata (supported grants, endpoints, scopes) |
| `/.well-known/oauth-protected-resource`   | GET      | RFC 9728 protected resource metadata                           |
| `/register`                               | POST     | Dynamic Client Registration (RFC 7591)                         |
| `/authorize`                              | GET      | Consent screen -- user authenticates and approves scopes       |
| `/authorize`                              | POST     | Form submission from consent screen                            |
| `/token`                                  | POST     | Token exchange (auth code -> tokens) and refresh               |
| `/mcp`                                    | POST/GET | MCP endpoint (existing, now behind OAuth)                      |

## Scope Design

All Rewind data is read-only from the MCP server's perspective. Scopes should be granular enough to be meaningful but not so numerous that the consent screen is overwhelming.

| Scope             | Description                         | Endpoints Covered                                                    |
| ----------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `read:listening`  | Access listening history and stats  | now playing, recent, stats, top lists, streaks, artist/album details |
| `read:running`    | Access running activities and stats | stats, recent runs, PRs, streaks, activity details                   |
| `read:watching`   | Access watch history and stats      | recent watches, movie details, stats                                 |
| `read:collecting` | Access collection data              | vinyl collection, collection stats                                   |
| `read:reading`    | Access reading data and highlights  | recent reads, highlights, stats                                      |
| `read:feed`       | Access cross-domain feed            | feed, on-this-day, search                                            |
| `read`            | All read scopes (convenience alias) | All of the above                                                     |

Default requested scope: `read` (all domains). Users can optionally restrict to specific domains.

## Token Lifetimes

| Token Type          | Lifetime         | Notes                                                                                                           |
| ------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Authorization code  | 10 minutes       | Single-use, stored hashed                                                                                       |
| Access token        | 1 hour           | Standard OAuth practice. Short-lived to limit exposure. Claude silently refreshes.                              |
| Refresh token       | 90 days, sliding | Resets on each use. Regular usage means you never re-authenticate. Rotated (new token issued, old invalidated). |
| Client registration | No expiration    | DCR clients persist until revoked                                                                               |

## Security Measures

| Measure                            | Implementation                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| **PKCE (S256)**                    | Mandatory. Prevents authorization code interception.                              |
| **State parameter**                | Handled by `workers-oauth-provider`. Prevents CSRF.                               |
| **Token hashing**                  | All tokens stored as SHA-256 hashes. Never stored plaintext.                      |
| **Redirect URI validation**        | Exact match required. Localhost exception per RFC 8252.                           |
| **HTTPS only**                     | Enforced by Cloudflare. Localhost allowed for development.                        |
| **Rate limiting**                  | Auth endpoints rate-limited (100/15min authorize, 50/15min token, 20/hr register) |
| **Refresh token rotation**         | New refresh token on every use. Old one invalidated. Limits replay window.        |
| **Token revocation on disconnect** | Anthropic removes tokens on user disconnect. Server-side tokens expire naturally. |

## Authentication Strategy: GitHub OAuth Delegation

The MCP server acts as its own OAuth authorization server (as required by the MCP spec), but delegates actual user authentication to GitHub. This is the "upstream OAuth delegation" pattern that `workers-oauth-provider` supports natively.

### How It Works

1. Claude redirects user to `mcp.rewind.rest/authorize`
2. Consent page shows "Sign in with GitHub" button
3. User clicks, authenticates with GitHub (the MCP server never handles passwords)
4. GitHub redirects back with an authorization code
5. MCP server exchanges the code for a GitHub access token, reads the GitHub user ID
6. MCP server maps the GitHub user ID to a Rewind `user_id`
7. MCP server issues its own OAuth tokens (access + refresh) back to Claude

### Why GitHub

- No password management, no email service, no external infrastructure beyond a free GitHub OAuth App
- Multi-user ready from day one (each GitHub account maps to a Rewind user_id)
- Anthropic QA can test with their own GitHub account (just pre-provision a test user_id mapped to their GitHub ID)
- `workers-oauth-provider` has built-in support for this exact pattern

### Setup Required

- **GitHub OAuth App** (github.com/settings/developers): name, callback URL (`https://mcp.rewind.rest/callback`), get client ID + secret
- **Worker secrets**: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
- **User allowlist**: KV key or env var mapping GitHub user IDs to Rewind user_ids. Starts as a simple JSON map, can be upgraded to a D1 table for multi-user.

## Implementation Phases

### Implementation Steps

1. Add `@cloudflare/workers-oauth-provider` dependency
2. Create KV namespace `OAUTH_KV` in wrangler.toml
3. Create GitHub OAuth App, store `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as worker secrets
4. Implement `OAuthProvider` class with GitHub upstream delegation
5. Build consent HTML page ("Sign in with GitHub" button + scope display)
6. Handle GitHub callback: exchange code, read GitHub user ID, map to Rewind user_id
7. Wire up `workers-oauth-provider` middleware in worker.ts (replaces manual Bearer check)
8. Add `.well-known` metadata endpoints
9. Create user allowlist mapping (GitHub user ID -> Rewind user_id)
10. Pre-provision Anthropic QA test user with sample data
11. Test with Claude Desktop and claude.ai

Estimated effort: **2-3 days**

## What Changes in the Existing Codebase

| Component                                | Change                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mcp-server/worker.ts`                   | Replace static Bearer auth with `workers-oauth-provider` middleware. MCP endpoint returns 401 when unauthenticated. |
| `mcp-server/wrangler.toml`               | Add KV namespace binding                                                                                            |
| `mcp-server/src/consent.ts` (new)        | HTML consent page with "Sign in with GitHub"                                                                        |
| `mcp-server/src/oauth-provider.ts` (new) | `OAuthProvider` implementation with GitHub upstream delegation                                                      |
| `mcp-server/src/github-auth.ts` (new)    | GitHub OAuth code exchange and user ID lookup                                                                       |
| Worker secrets (new)                     | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                                                                          |
| `api.rewind.rest`                        | **No changes.** Stays on static API keys.                                                                           |
| `mcp-server/src/index.ts` (stdio)        | **No changes.** Local stdio transport keeps using env var API key.                                                  |

The OAuth layer only affects the remote Worker transport. Local usage (Claude Desktop via stdio, Claude Code) continues to use `REWIND_API_KEY` directly.

## Decision Matrix

| Path                       | Effort   | Unlocks                                                                                         |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| **Skip OAuth**             | 0        | MCP server works for personal use via stdio + manual Bearer token config. No directory listing. |
| **GitHub OAuth**           | 2-3 days | Directory submission. Multi-user ready. Anthropic QA can test with their own GitHub account.    |
| **+ Production hardening** | +1 day   | Token revocation endpoint, audit logging, admin dashboard for active sessions.                  |

## References

- [MCP Authorization Specification (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization)
- [Cloudflare workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
- [Cloudflare MCP Authorization Docs](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)
- [Cloudflare Blog: Building AI Agents with MCP, Auth, and Durable Objects](https://blog.cloudflare.com/building-ai-agents-with-mcp-authn-authz-and-durable-objects/)
- [Anthropic Connectors Directory FAQ](https://support.claude.com/en/articles/11596036-anthropic-connectors-directory-faq)
