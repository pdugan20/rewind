# MCP Richness -- Smoke Test

Manual checklist run against a live Claude Code session against the local MCP server. Run once at the end of Phase 0, once after Phase 1, and spot-check after Phases 2-5.

## Setup

1. `cd mcp-server && npm run build`
2. Connect the built server to Claude Code:

   ```bash
   claude mcp add --transport stdio rewind-local -- node /absolute/path/to/rewind/mcp-server/dist/index.js
   ```

   Or point at the deployed Worker:

   ```bash
   claude mcp add --transport http rewind https://mcp.rewind.rest/mcp
   ```

3. In a fresh Claude Code session, run `/mcp` and confirm the server status is connected.

## Phase 0 checks

Verify the foundation before spreading it across domains.

- [ ] `/mcp` shows the server's `instructions` field populated (or: ask Claude "what can the rewind server do?" and confirm it paraphrases the instructions).
- [ ] Type `@rewind-local:` and confirm resources appear in the autocomplete.
- [ ] Pick one pilot tool updated for Phase 0 (a minimal `get_health` variant is fine) and call it. Confirm:
  - [ ] Text block renders as before.
  - [ ] If an image block is returned: note whether the terminal displays it inline. If not, capture which terminal emulator is in use and whether Claude still reasons over the image when asked about it.
  - [ ] If a `resource_link` is returned: confirm it appears in the transcript and whether it is rendered as clickable or as a plain URL.
  - [ ] If `structuredContent` is returned: ask Claude a question that requires the JSON (e.g. "what's the exact scrobble count?") and confirm the answer is precise, not approximate.

## Phase 1 checks (Watching pilot)

After Phase 1 merges, run the following prompts and verify:

- [ ] "What did I watch last week?" -- returns `get_recent_watches` with top-N posters rendered or referenced, Letterboxd review links where a review exists.
- [ ] "Tell me about the last movie I watched in detail" -- returns `get_movie_details` with poster image, Letterboxd resource link, structured content with full movie metadata.
- [ ] "What's my top genre of films this year?" -- returns an aggregate tool with a genre breakdown Claude can quote exact percentages from.
- [ ] Reference a movie via `@rewind:rewind://movie/<id>` and confirm the content fetches and the conversation can ask follow-ups about it.
- [ ] Check total token usage per call in the transcript -- confirm no response exceeds `MAX_MCP_OUTPUT_TOKENS`. If any does, revisit image policy.

## Phases 2-5 spot checks

One representative prompt per domain, verifying the same four content types render:

- [ ] Listening: "What was my top album last month?" -- expect cover art, Apple Music link, structured content.
- [ ] Collecting: "Show me the last three records I added" -- expect top-N covers, Discogs links.
- [ ] Reading: "What articles did I finish this week?" -- expect original article links, structured content.
- [ ] Running: "What was my longest run this year?" -- expect Strava link, structured activity metrics.

## Phase 6 checks

- [ ] "What did I do on <date>?" via `get_feed` -- returns a mix of entity `resource_link`s across domains.
- [ ] Search "blade runner" -- returns resource_links pointing at `rewind://movie/<id>` that are fetchable by @-mention.
- [ ] "On this day last year" -- returns cross-domain resource_links.

## Failure modes to watch for

- **Oversized responses**: Claude Code warns above 10K tokens, defaults cap at 25K. If any tool exceeds the cap, either paginate more aggressively or add `_meta.anthropic/maxResultSizeChars` on the tool's `tools/list` entry (up to 500K chars for text; does not apply to images).
- **Stale cached image responses**: CDN has its own cache; if thumbhash or dominant_color metadata changes, image URL cache should be bypassed with a cache-busting query param rather than requesting image bytes in the tool.
- **Resource URI collisions**: `rewind://movie/<tmdb_id>` vs `rewind://movie/<internal_id>` must pick one canonical id scheme before Phase 6. Document the choice in DESIGN.md when Phase 1 concludes.
- **Terminal image rendering**: If the user's terminal doesn't display images, Claude still reasons over them, but the UX loses the "see the poster" value. Note the terminal emulator in the smoke-test notes so future decisions about image size/quantity have context.
