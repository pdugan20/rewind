# Artist Genre Tags -- Genre Classification for Listening Data

## Motivation

The listening domain has no genre data. Every scrobble links to an artist, but there's no way to answer "what genres do I listen to?" or "how has my genre mix changed over time?". This blocks features like:

- Stacked bar chart showing genre breakdown by month (the primary use case)
- Genre distribution in year-in-review
- Genre filtering on browse/recent endpoints
- Cross-domain genre insights (e.g., vinyl collection genres vs. listening genres)

## Approach

Use Last.fm's `artist.getTopTags` API to fetch community-submitted tags for each artist. Store raw tags (with weights) on the artist record for flexibility, plus a normalized `genre` field (single primary genre) for fast, indexable queries.

A curated genre allowlist filters junk tags ("seen live", "female vocalists", artist self-tags) and normalizes synonyms ("Hip-Hop", "hip hop", "rap" all map to "Hip-Hop"). The allowlist is applied at two levels:

- **Storage time**: The `genre` column gets the top allowlisted tag
- **Query time**: Raw `tags` can be filtered through the allowlist for multi-genre breakdowns

## Data Source

**Last.fm `artist.getTopTags`** -- chosen because:

- Artist names match exactly (data already comes from Last.fm)
- No ID mapping step needed
- API key already available (`LASTFM_API_KEY`)
- 5 req/sec rate limit, no daily cap
- Returns tags with 0-100 weight for ranking

Returns ~10 tags per artist. After allowlist filtering, typically 3-5 usable genre tags remain.

## Scope

### In scope

- Phase 1: Schema, allowlist, Last.fm client method
- Phase 2: Backfill script for existing 4,382 artists
- Phase 3: Sync integration (tag new artists automatically)
- Phase 4: Genre endpoints (`/listening/genres`, genre on artist responses)
- Phase 5: Documentation, cleanup, archive

### Out of scope

- Track-level or album-level genre tags (artist-level is sufficient and far more reliable)
- MusicBrainz or Spotify as data sources (Last.fm is the simplest path with exact name matching)
- Genre data for filtered artists (audiobooks, holiday music, etc.)

## Files

| File                     | Description                              |
| ------------------------ | ---------------------------------------- |
| [TRACKER.md](TRACKER.md) | Phase/task tracker with progress         |
| [DESIGN.md](DESIGN.md)   | Schema design, allowlist, endpoint specs |
