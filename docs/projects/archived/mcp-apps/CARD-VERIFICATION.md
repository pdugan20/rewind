# Card polish — verification in Claude app

Walkthrough for verifying the card-alignment work from commit `cd94ae1` in
the live Claude app (Desktop + iOS). One section per tool; each has a
trigger prompt, what to look for, and the smells that mean something
didn't plumb.

## Setup

This pass touches only the bundled UI HTML — no API changes, no schema
changes. Local-build inner loop:

```bash
cd mcp-server
npm run build:web        # rebuild HTML bundles into src/ui-bundles.ts (~0.3s)
npm run build            # tsc -> dist/ (~1s)
```

The rebuild is fast (sub-second `build:web` after the 2026-04-28
programmatic-Vite refactor) so this lives at the top of the inner loop,
not as a separate ceremony.

Then in Claude Desktop:

1. Settings → Connectors — confirm `rewind-local` is enabled (and
   `rewind` is **disabled** — tool names collide).
2. ⌘Q to quit fully, reopen Claude Desktop.
3. Ask Claude: "what version of rewind MCP server are you connected to?"
   to confirm you're hitting the local build.

For iOS: rebuild + restart Desktop is enough — iOS reads the same
connector config when you sign in. If iOS still shows old behavior,
sign out + sign back in.

---

How's Julio Rodriguez's hitting looking this year?

I remember reading an article a few years ago about Ichiro, I think it was on ESPN, about like, how he had a great work ethic.

I think it mentioned him going to the batting cages in Japan and training. Can you find that for me?

---

## What to verify, per tool

### `get_recent_watches` — Reviewed / Watched tabs

**Trigger:** "what have I watched recently"

**Expect:**

- Card titled **Recent watches**, "{N} watched" subtitle.
- Two-segment pill toggle: **Reviewed** and **Watched**, each with a
  count badge. Reviewed is selected by default.
- Reviewed tab: each row has poster (72×108, 8px radius), title +
  half-stars on the same line, sub line `year · director · time-ago`,
  2-line review prose underneath at ~85% opacity.
- Watched tab: same row chrome but the body line is the film synopsis
  (TMDB summary or tagline) at ~62% opacity — visibly dimmer than a
  review.
- Stars: filled at 45% currentColor opacity (soft, not jet-black);
  empty stars are barely visible 18% glyphs; half-stars render as a
  clean left-half via clip-path.
- **No** "× N" or "rewatch" labels in the sub line.
- Bottom of card: full-width black pill — _"View diary on Letterboxd ↗"_.
- Tapping a row with a review opens the Letterboxd review URL; tapping
  the bottom pill opens your Letterboxd diary.

**Smells:**

- Tabs visible when only one bucket has items — should be hidden, single
  view rendered instead.
- Watched-tab body shows review prose for any film — bucket leak.
- White inverted pill at the bottom — wrong CTA style (we use full-
  width black for primary single-destination CTAs).
- Stars look near-black — opacity didn't apply (look for 45%).
- Posters with sharp 4px corners — radius didn't update (should be 8).

### `get_recent_reads` — tighter top spacing

**Trigger:** "what have I read recently" / "show my recent reads"

**Expect:**

- Card titled **Recent reads**, "{N} saved" subtitle.
- The **first article row sits closer to the title** than before — gap
  is ~5px tighter (no toggle, no buffer).
- Articles without an image: thumb area renders **nothing** (not a
  fallback colored tile).
- Article rows: title, meta line `author · domain · X min read · saved`,
  2-line description blurb. No hover bg. No bottom-border dividers.

**Smells:**

- Visible colored thumb where an article lacks an image — old fallback
  tile didn't get removed.
- Title-to-first-row gap looks the same as before — `marginTop: -5` on
  `listStyle` didn't apply.

### `get_top_albums` — single list, larger art

**Trigger:** "top albums this month"

**Expect:**

- Card titled **Top albums**, period subtitle.
- **No List/Grid toggle.** Single list view, period.
- Album thumbnails are 56×56 (up from 44) with the canonical 1px
  hairline border + neutral fill — no brand-color background.
- Each row: thumb · name + plays · sparkline · "Listen ↗" white pill.
- Tapping a row opens Apple Music when the link exists.

**Smells:**

- A toggle still shows up — old build cached.
- Thumbs look 44px — `ROW_THUMB_PX` didn't update.
- Brand-colored thumb backgrounds — old `dominant_color` fallback bg
  came back somehow.

### `get_top_artists` — sanity check

**Trigger:** "top artists this year"

**Expect:** Same row chrome as Top albums — small thumb, name +
detail + plays, sparkline (uniform light color), "Listen ↗" white
pill. No list/grid toggle (this card never had one).

**Smells:**

- Sparkline using the album/artist accent color in some rows — the
  uniform `currentColor 0.2` treatment regressed.

### `get_top_tracks` — by-album CTA stays black

**Trigger:** "top tracks this month"

**Expect:**

- Card with the existing List / By-album toggle (intentional — this
  one stays).
- In By-album view, each album group has a **black** "Listen ↗" pill —
  not white. Reverted from a brief stint at white.
- List view: rows with track name, album, plays, mini bar.

**Smells:**

- "Listen ↗" pill renders white-on-black inverted — revert didn't take.

### `get_attended_event` — unplayed half-inning

**Trigger:** "show me the {Phillies} game I attended on {date}" — pick
a game where the home team was winning going into the bottom of the 9th
(home team didn't bat). If you don't have one handy, any walk-off win or
home win where the home team led after 8.5 innings.

**Expect:**

- Linescore grid renders with one row per team, one column per inning.
- The cell for the unplayed half-inning shows **"X"** (capital X), not
  blank, not 0, not "—".

**Smells:**

- The cell is empty — the `r ?? 'X'` fallback didn't apply.
- Cell shows `null` or `undefined` literal — type widening failed and
  it's stringifying.

### `get_article` (detail) — reference for the black CTA

Not changed in this commit, but the Reading-detail card is the canonical
"big black bottom CTA" — when verifying recent-watches, glance at this
to confirm the CTA shapes match.

**Trigger:** "open that Atlantic article I saved" / any article tool
result.

**Expect:** Bottom of card has a full-width black pill _"Read on {domain} ↗"_.
Recent-watches' Letterboxd CTA should look identical in shape and
weight.

## General smells that mean a bundle didn't ship

- Card renders as plain JSON / structured-content text instead of
  styled HTML → MCP Apps host didn't pick up the `_meta.ui.resourceUri`,
  or the `ui://` resource isn't registered, or you're connected to
  `rewind` (npm) instead of `rewind-local`.
- Card looks identical to before any of this work — old `dist/` got
  served. `rm -rf dist/ && npm run build && npm run build:web` and
  restart Desktop.
- Tools work but rendering looks broken inside an MCP Apps card — open
  the in-app DevTools (Desktop only: View → Developer → Toggle
  DevTools) and look for inline-style or React errors in the iframe.

## When the local build is good, before publishing

The `mcp-server/` workspace ships through **two independent CI paths**.
Don't conflate them — most of the time you only need one.

### Path A — Cloudflare Worker (`mcp.rewind.rest`)

Serves Claude iOS, claude.ai web, and any client that connects via the
remote URL. The `deploy-worker` job in `.github/workflows/mcp-server.yml`
runs for matching pushes to `main` and deploys when the production-impact
classifier finds an MCP runtime change. It also deploys every `v*` release
tag. That means a conventional-commit runtime fix lands and the Worker is
live ~2 min later — **no release-please PR, no tag, no version bump
required**.

For iOS-only / web-only iteration this is the fast path. Push and test;
let the release-please PR catch up whenever.

### Path B — npm package (`rewind-mcp-server`)

Serves Claude Desktop and Claude Code via stdio (the `npx
rewind-mcp-server` config in `claude_desktop_config.json`). The
`publish-npm` job is gated on the `v*` tag, so it only fires
when a release-please PR is merged.

Publishing is automated — never run `npm publish` by hand and never bump
`mcp-server/package.json` manually. Both will fail CI's drift check
(`.github/workflows/mcp-server.yml` "Verify release-please manifest
matches package.json"). The flow:

1. Land conventional-commit-prefixed commits (`feat:`, `fix:`, etc.)
   touching `mcp-server/**` on `main`. (This already triggers the
   Worker redeploy via Path A.)
2. `release-please.yml` opens (or updates) a release PR that bumps
   `mcp-server/package.json` AND `.release-please-manifest.json`
   atomically and updates `mcp-server/CHANGELOG.md`.
3. Merge the release PR. release-please tags the release as
   `v<version>`.
4. `mcp-server.yml` reacts to the tag: builds, publishes to npm with
   provenance, and redeploys the Cloudflare Worker again (idempotent —
   Path A already deployed the same code on the original push).
5. Flip Claude Desktop's connector from `rewind-local` to `rewind`.
   On iOS, sign out + sign back in so the new version is picked up.
6. Re-run a single trigger from above (e.g. `get_recent_watches`) on
   the published build to confirm parity.
