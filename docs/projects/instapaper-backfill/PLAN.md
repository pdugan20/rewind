# Instapaper bulk backfill — plan

Living doc. Last updated 2026-04-28. Edit the **Status** boxes as phases land.

## Goal

Pull every retrievable article from the user's Instapaper account into Rewind so the reading domain reflects the user's actual archive (~19,961 bookmarks) instead of the API-visible slice (~1,119).

## Current state

|                                                   | Count   | Source                                                |
| ------------------------------------------------- | ------- | ----------------------------------------------------- |
| Bookmarks in user's Instapaper (CSV ground truth) | 19,961  | `~/Downloads/instapaper-export.csv`                   |
| Articles already in DB                            | 1,437   | `/v1/reading/articles?source=instapaper`              |
| Gap to close                                      | ~18,524 | (~12.5K w/ body via getText, ~6K as no_body)          |
| Live-sync structural fix                          | shipped | `c8441e4f` — archive 100→500 + iterate custom folders |

Why a CSV-driven backfill at all: Instapaper's `bookmarks/list` is hard-capped at 500 per folder; the `have=` parameter is for delta-skip, not pagination. Articles older than the most-recent 500 per folder, plus orphaned bookmarks not in any folder, are unreachable via the live API. Only the CSV export at `instapaper.com/user` lists every bookmark.

Why not just use the source URL: ~33% of articles return `1550 Error generating text version` from `bookmarks/get_text`. Empirically this maps to paywalled sources (NYT/WSJ/Bloomberg/WaPo), where Instapaper's on-demand re-fetch hits 401/403. Instapaper does not maintain a permanent body cache — `getText` re-fetches each call.

## Phase 0 — up-front prep

Status: **in progress**

- [ ] **0a. Update backfill script: `bookmarks/add` with `archived=1`.** Replaces the two-call `add → archive` round-trip (which caused user-side Unread folder pollution + iOS notifications). Single call, idempotent ID lookup, no folder side effect. ~5 lines in `scripts/backfills/backfill-from-csv.ts`.

- [ ] **0b. Generate a long-lived Cloudflare API token.** The wrangler OAuth token expires every 24h. Phase 1 takes 5-7 hours so a mid-run expiry is a real risk. Create a token at `dash.cloudflare.com/profile/api-tokens` with **D1 → Edit** scope, save as `CLOUDFLARE_API_TOKEN` in `.dev.vars`. The script's `getCfApiToken()` already prefers the env var.

- [ ] **0c. MCP no-body filter (3 small route changes).** Land before Phase 1 so the in-progress run doesn't pollute the UX with empty cards.
  - `get_recent_reads`: exclude `enrichment_status='no_body'` from default response; opt-in flag `include_no_body`.
  - `get_article(id)`: surface `body_unavailable: true` flag in structuredContent so the article card UI can render "Body not available — read on source" instead of empty.
  - Search ranking: deprioritize no-body matches in the FTS hybrid score.

- [ ] **0d. Pre-flight dry-run.** `--csv ~/Downloads/instapaper-export.csv --limit 25 --dry-run` after 0a lands. Confirms parser + dedup still work end-to-end. ~30s.

## Phase 1 — bulk ingest with `archived=1`

Status: **pending Phase 0**

**Inputs:** updated script, fresh CF API token, full CSV.

**Per-article flow (concurrency=4):**

1. URL/ID dedup (skip if already in DB)
2. `bookmarks/add(url, archived=1)` → idempotent ID lookup, no Unread side effect
3. `bookmarks/get_text(id)`:
   - 200 → extract body, word count, 3000-char excerpt → `enrichment_status='completed'`
   - 400/1550 → URL+title placeholder → `enrichment_status='no_body'`
4. OG fetch on source URL (best-effort; tolerates failure)
5. Highlights fetch + insert (`reading_highlights`, idempotent on `source_id`)
6. D1 `INSERT … ON CONFLICT DO UPDATE` (re-runs safe)

**Post-pass admin triggers (in order):**

1. `POST /v1/reading/admin/backfill-images` — image pipeline picks up new `og_image_url`
2. `POST /v1/admin/reembed-reading` — Voyage embeddings (~$0.20)
3. `POST /v1/admin/reindex-search` — FTS5 rebuild (no per-token cost)

**Run command:**

```bash
cd /Users/patrickdugan/Documents/Github/rewind
npx tsx scripts/backfills/backfill-from-csv.ts \
  --csv ~/Downloads/instapaper-export.csv \
  > /tmp/backfill-full.log 2>&1 &
```

**Monitor:**

```bash
# rate + progress
tail -f /tmp/backfill-full.log | grep -E "done @|FAILED"
# count completed in DB
node -e "..."  # see scripts/probe-instapaper.ts pattern
```

**Expected outcome:**

- ~12,500 articles with full body, image, embedding, highlights
- ~6,000 articles as `no_body` placeholders (URL + title only)
- ~5-7 hours wall time
- ~$0.20 Voyage cost

**Failure / resume:** dedup is on bookmark_id and source URL, so killing + restarting after any crash skips already-ingested rows. No state to track manually.

## Phase 2 — ScraperAPI recovery for the no-body set

Status: **pending Phase 1**

**Why:** ~6,000 articles still have no body after Phase 1. ScraperAPI on the source URL recovers ~75% (per empirical test 6/8 across NYT, WaPo, SF Chronicle). WSJ is 0/2 — assume unrecoverable. Cost optimization is the meat of this phase.

**ScraperAPI plan context:** Hobby plan, 100K credits/month. 93,100 remaining as of 2026-04-28. Renews in 25 days.

**Cost optimization (must-have, not optional):**

| Strategy                                  | Calls            | Credits | % of remaining |
| ----------------------------------------- | ---------------- | ------- | -------------- |
| Naive `render=true` for all               | 6,000            | 60,000  | 65%            |
| Static-first (1cr), render-on-fail (10cr) | ~6,000 + retries | ~33,000 | 35%            |
| + skip WSJ + dead URLs                    | ~4,500           | ~25,000 | 27%            |

**Recovery script `scripts/backfills/recover-no-body.ts` — to be built:**

1. Query D1 for `enrichment_status='no_body' AND source='instapaper' AND user_id=1`
2. For each row:
   - Skip if domain in known-impossible list (`wsj.com` for now, expandable)
   - HEAD-check source URL — if 404/410, mark as `no_body_dead`, skip
   - ScraperAPI `render=false` (1 credit) — extract body via `<article>` → `<main>` → largest `<div>` heuristic, strip nav/header/footer
   - If body < 200 chars OR matches error-page heuristics ("SKIP ADVERTISEMENT…", "A required part of this site couldn't load…", "Subscribe to read…"): retry with `render=true` (10 credits)
   - On success: UPDATE row with body, body_excerpt, word_count, set `enrichment_status='completed'`
   - Track `X-RemainingCredits` from response headers; auto-stop if drop below 10K threshold
3. After pass: re-trigger `/v1/admin/reembed-reading` to update embeddings now that the bodies exist
4. Stage in chunks: `--limit 500` first run, observe success rate + actual credits/article, then full run

**Expected outcome:**

- ~4,500-5,000 of 6,000 recovered to `completed`
- ~1,000-1,500 stay `no_body` (mostly WSJ + true dead links + extraction failures)
- ~$1-2 in ScraperAPI credits

## Phase 3 — verification

Status: **pending Phase 2**

- [ ] Re-run `npx tsx scripts/backfills/diff-instapaper.ts` → API↔DB gap should be near zero (only the unrecoverable subset).
- [ ] Spot-check Ichiro: `get_article(1121)` returns full body; semantic search for "Ichiro work ethic Japan" returns it as top match.
- [ ] Spot-check a Phase-2-recovered article: pick one previously-no_body row that's now `completed`, verify body looks right.
- [ ] `/v1/reading/stats` reports total ~19K with breakdown of `completed` vs `no_body` counts.
- [ ] Claude Desktop: ask "what did I read recently" — no empty cards in the response (Phase 0c filter working).
- [ ] Claude Desktop: ask about a specific article from 2018 (e.g., the Ichiro piece). Expect semantic_search → get_article(id) → rich card render.

## Known limitations

- **WSJ articles stay no_body.** Both `getText` and ScraperAPI fail. WSJ's paywall is sophisticated; even residential IPs return paywall stubs. User keeps URL+title in DB, can navigate to WSJ.com if they have an active subscription.
- **~31 custom-folder articles flatten to Archive.** Backfill ingests them but loses the user-defined folder (e.g., "Pete & Pete", "David Foster Wallace"). User can re-categorize manually in Instapaper after; not blocking.
- **Notification spam during Phase 1 was a real risk** — solved by `archived=1` parameter to `bookmarks/add`. Don't regress.

## Reference

**Scripts:**

- `scripts/probe-instapaper.ts` — count Instapaper bookmarks per folder, target-id check, OAuth diagnostics
- `scripts/probe-add.ts` — verify `bookmarks/add` idempotency on a known URL (includes side-effect probe)
- `scripts/backfills/diff-instapaper.ts` — API↔DB diff (read-only, prod API)
- `scripts/backfills/backfill-from-csv.ts` — main ingest script (Phase 1)
- `scripts/backfills/recover-no-body.ts` — to be built (Phase 2)
- `scripts/compare-body-recovery.ts` — Phase 2 strategy validation; safe to delete after Phase 2 lands

**Required env vars (in `.dev.vars`):**

- `INSTAPAPER_CONSUMER_KEY` / `INSTAPAPER_CONSUMER_SECRET` / `INSTAPAPER_ACCESS_TOKEN` / `INSTAPAPER_ACCESS_TOKEN_SECRET`
- `REWIND_ADMIN_KEY` (for production API reads + admin trigger calls)
- `CLOUDFLARE_API_TOKEN` (Phase 0b — long-lived alternative to wrangler OAuth)
- `SCRAPER_API_KEY` (Phase 2)
- `INSTAPAPER_SESSION_COOKIE` — investigated, not used (cookie-based recovery loses to ScraperAPI 2/8 vs 6/8)

**Admin endpoints triggered:**

- `POST /v1/reading/admin/backfill-images` — body `{ "limit": N }`
- `POST /v1/admin/reembed-reading` — body `{}` (Voyage)
- `POST /v1/admin/reindex-search` — body `{}` (FTS)
- `POST /v1/admin/sync/reading` — manual sync trigger (uses live `bookmarks/list`, capped)

**Key files modified for the live-sync structural fix (already shipped):**

- `src/services/instapaper/sync.ts:492-507` — archive cap 100→500, iterate custom folders
- Deployed at version `c8441e4f` on 2026-04-28
