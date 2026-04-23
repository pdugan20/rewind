# Project: MCP Richness

Upgrade the Rewind MCP server from text-only responses to the full MCP 2025-06-18 content surface: images, resource links, structured content, richer resources, and elicitation where it helps.

## Target client

**Primary:** Claude Desktop (macOS) and Claude iOS apps -- they render MCP content blocks (text, image, resource_link) as first-class UI and respect `structuredContent` per spec. The `rewind-mcp-server` npm package and the deployed Worker at `mcp.rewind.rest` exist for these clients.

**Secondary / dev-only:** Claude Code CLI. It has real limitations (image blocks reach the model but don't render inline; `structuredContent` appears to hide `content` blocks in its UI) -- we do not optimize for those quirks. Use Claude Code for development, validate in Claude Desktop.

## Motivation

Today every one of the 27 tools returns a single `{ type: 'text', text }` block. The underlying Rewind API has far more to offer:

- A full image CDN with thumbhash, dominant_color, and accent_color metadata (album art, posters, vinyl covers, artist imagery) -- none of which reaches the MCP client.
- External platform URLs (Letterboxd reviews, Strava activities, Discogs releases, Instapaper articles) baked into prose instead of delivered as first-class links.
- Year-in-review and aggregate endpoints (genres over time, decades, directors, streaks) exposed only as raw JSON resources, not as structured tool output Claude can reason over.

The MCP 2025-06-18 spec and Claude Code both support image content, `resource_link`, `structuredContent`, embedded resources, elicitation, and server instructions for Tool Search. We are using none of it.

## Scope

Tiers 1 and 2 from the richness analysis:

- Add `resource_link` for external platform URLs
- Add `structuredContent` (JSON) alongside text for all stats/aggregate tools
- Add `image` content on single-entity detail tools and top-N thumbnails on list tools
- Add a `server.instructions` string
- Bump `@modelcontextprotocol/sdk` from 1.12.1 to latest
- Expose more @-mention resources for specific entities
- Add aggregate tools wrapping existing endpoints (genre over time, decades, directors)
- Selective elicitation on genuine disambiguation cases

## Non-goals / Out of scope

- **MCP Apps (mcp-ui / `ui://` iframe resources).** Parked. Not supported in Claude Code CLI today. Revisit if Claude.ai or Claude Desktop becomes a primary audience.
- **Audio content.** Spec supports it, but Claude Code doesn't render audio.
- **Channels / push messages.** Separate feature with its own deployment shape; reconsider after richness lands.
- **New domains.** This project only enhances the five existing domains.

## Architecture

### Current

All tools return text:

```ts
return { content: [{ type: 'text', text: '...' }] };
```

### Target

Tools return a mix of content blocks plus optional structured content:

```ts
return {
  content: [
    { type: 'text', text: '...' },
    { type: 'image', data: '<base64>', mimeType: 'image/jpeg' },
    {
      type: 'resource_link',
      uri: 'https://letterboxd.com/...',
      name: 'Letterboxd review',
      mimeType: 'text/html',
    },
  ],
  structuredContent: {
    /* JSON shape mirroring the API response */
  },
};
```

See [DESIGN.md](DESIGN.md) for canonical shapes per tool class and the helper functions that enforce them.

## Documents

| File                           | Purpose                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| [TRACKER.md](TRACKER.md)       | Phased task tracker with discrete checkboxes                                                      |
| [DESIGN.md](DESIGN.md)         | Canonical response shapes per tool class, helper utilities, image policy, structuredContent rules |
| [SMOKE-TEST.md](SMOKE-TEST.md) | What to verify in a live Claude Code session after Phase 0 and after each domain                  |

## Phase Summary

| Phase | Focus            | Scope                                                                                                |
| ----- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| 0     | Foundation       | SDK bump, content-block helpers, `server.instructions`, smoke test in live Claude Code               |
| 1     | Watching (pilot) | Full Tier 1+2 for watching -- posters, Letterboxd links, structured stats, entity resources          |
| 2     | Listening        | Album art, Apple Music links, structured stats, artist/album entity resources                        |
| 3     | Collecting       | Vinyl covers, Discogs links, structured stats, record entity resources                               |
| 4     | Reading          | Article domain icons, original URLs as links, structured stats, article/highlight resources          |
| 5     | Running          | Strava links, structured stats, activity entity resources (maps deferred -- see non-goals)           |
| 6     | Cross-domain     | Enhance `search`, `get_feed`, `get_on_this_day` to emit resource_links into the new entity resources |

## Sequencing Notes

- **Phase 0 first, always.** SDK bump and shared helpers land once and unblock everything downstream. Smoke test at the end of Phase 0 decides whether any policy (e.g., image cap, MIME preference) needs adjusting before the sweep.
- **Watching as the pilot domain** because it exercises all four Tier 1 content types in one domain: posters (image), Letterboxd URLs (resource_link), `get_watching_stats` + genre/decade/director aggregates (structuredContent), and detail lookups (entity resources).
- **Phases 2-5 can run sequentially or in parallel** once the Phase 1 pattern is validated. Recommended order listed above matches visual payoff: the list starts with the domain that benefits most from images and ends with running (maps parked).
- **Phase 6 depends on Phases 1-5** because cross-domain tools emit resource_links pointing at entity resources that only exist after their domain's phase completes.

## Confidence

Overall high. Known unknowns called out in [SMOKE-TEST.md](SMOKE-TEST.md):

- How the user's terminal renders image content blocks (Claude still reasons over them either way).
- Measured upside of `structuredContent` over plain text for stats tools.
- Whether any per-tool response exceeds `MAX_MCP_OUTPUT_TOKENS` once images are inlined -- Phase 0 sets the image policy to avoid this.
