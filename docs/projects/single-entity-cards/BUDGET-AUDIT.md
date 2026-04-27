# `structuredContent` Token-Budget Audit — Phase 0

Static analysis of single-entity tool responses to identify token bloat before adding three new cards. Re-run in Phase 4 against the post-trim shapes.

## Findings

### `get_article` — `mcp-server/src/tools/reading.ts:73`

- **Form:** `server.tool()` (legacy). Needs migration to `server.registerTool()` in Phase 1 to attach `_meta.ui.resourceUri`.
- **Returns** `structuredContent: a` where `a: ArticleDetail`.
- **Heavy field:** `content: string | null` — full article body, plain text. Self-documents as "5–30 KB" in the tool description.
- **Other fields:** `excerpt` (often duplicated against `content`), `highlights` (small), metadata.
- **Estimated size:** **8–35 KB** depending on article length. Frequently exceeds the 8 KB target.
- **Phase 1 fix:** drop `content` and `excerpt` from `structuredContent` (still available via the same tool's text rendering); cap `highlights` at 5 with a `highlight_count` total alongside.

### `get_artist_details` — `mcp-server/src/tools/listening.ts:545`

- **Form:** `server.tool()` (legacy). Needs migration in Phase 2.
- **Returns** `structuredContent: data` where `data: ArtistDetail`.
- **Fields:** name + metadata, image attachment, `top_albums[]` (capped at backend), `top_tracks[]` (capped at backend), Apple Music URL.
- **Estimated size:** **2–4 KB** typically — well under budget.
- **Phase 2 additions:** `bio_summary` + `bio_content` (a few KB at most), `listening_stats`, `sparkline` (~30 points × ~30 bytes = ~1 KB), `similar_artists` (5 entries × ~150 bytes = ~750 B). Estimated post-Phase-2: **5–7 KB**. Within budget.

### `get_attended_player` — `mcp-server/src/tools/attending.ts:393`

- **Form:** `server.tool()` (legacy). Needs migration in Phase 3.
- **Returns** `structuredContent: data` — **all appearances, unbounded**. The text rendering caps display at 25 with a "... and N more" line, but `structuredContent` includes the full array.
- **Heavy field:** `appearances: Array<{...}>` — unbounded. Each row carries `batting_line` and `pitching_line` JSON blobs (3–8 fields each). For a moderately attended player (Cal Raleigh, 32 games) this is ~10–15 KB. For a heavy player it could exceed 30 KB.
- **Phase 3 fix:** cap `attended_appearances` at 10 most recent. Add `attended_appearance_count` for the total. Aggregate over the full set into the `attended_summary` block (one object, not an array). Net response size drops below 8 KB even for heavy players.

### `get_attended_event` — `mcp-server/src/tools/attending.ts:674`

- **Form:** `server.registerTool()`. Already has `_meta.ui.resourceUri = ui://rewind/attended-event.html`. Reference implementation.
- **Returns** `structuredContent: { event, players, tickets, ... }`.
- **Estimated size:** **3–6 KB** for a typical MLB game — within budget.
- **No action needed.**

### Other single-entity tools (not in this project's scope)

| Tool                   | Form                  | Has card        | Notes                                                  |
| ---------------------- | --------------------- | --------------- | ------------------------------------------------------ |
| `get_album_details`    | `server.tool`         | no              | Future card target. Track listing only; small.         |
| `get_movie_details`    | `server.tool`         | no              | Future card target. Cast list could grow; check later. |
| `get_activity_details` | `server.tool`         | no              | Future card target. Splits could be large.             |
| `get_attended_event`   | `server.registerTool` | yes (game card) | Reference impl.                                        |

These are not migrated in this project but should follow the same shape conventions when their cards land (see `Follow-up projects` in `README.md`).

## Trim summary

| Tool                  | Before est. | After trim est.  | Phase |
| --------------------- | ----------- | ---------------- | ----- |
| `get_article`         | 8–35 KB     | 1–3 KB           | 1     |
| `get_artist_details`  | 2–4 KB      | 5–7 KB (+enrich) | 2     |
| `get_attended_player` | 10–30 KB    | 4–7 KB           | 3     |
| `get_attended_event`  | 3–6 KB      | unchanged        | —     |

## Conventions to enforce going forward

1. **No full-body fields in `structuredContent`.** Articles, bios, transcripts get a `*_summary` (1–2 sentences max) plus the full body accessible via the same tool's text rendering or via a separate explicit fetch.
2. **List caps.** Any embedded list in `structuredContent` is capped (default 5–10) with a sibling `*_count` field for the total.
3. **Aggregate before listing.** When displaying "your stats with this player/artist/article," aggregate first into one summary object; then optionally list a small N most-recent rows.
4. **Image attachments are objects, not raw URLs.** Always `{ cdn_url, url, thumbhash, dominant_color, accent_color }`.

These rules go in `README.md` Decisions table and apply to all tool responses in this project. Phase 4 re-audits against this list.
