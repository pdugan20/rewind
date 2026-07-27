---
name: add-media
description: This skill should be used when the user asks to "add a movie", "add a vinyl", "add to my collection", "add physical media", "add a Blu-ray", "add a CD", or "bought these records". It handles both movies (via TMDb/Trakt) and music (via Discogs).
---

# Add Physical Media

Add physical media items to the Rewind collection. Supports two domains:

- **Movies** (Blu-ray, 4K UHD, DVD) -- resolved via TMDb, synced to Trakt, stored locally
- **Music** (Vinyl, CD, Cassette) -- resolved via Discogs, added to Discogs collection, stored locally

Treat a user request that names the items to add as authorization for those exact additions. Otherwise, preview the parsed items and formats and obtain approval before sending any production POST request. Never expose keys from `.dev.vars` in output.

## Setup

Read the admin API key from `.dev.vars` (the `REWIND_ADMIN_KEY` line). Read the `TMDB_API_KEY` line as well for fallback movie searches. All API calls go to `https://api.rewind.rest/v1`.

## Parsing Input

Extract items from freeform input -- pasted order receipts, comma-separated lists, or single items. Strip prices, quantities, and other noise. Identify each item's domain:

- **Movie indicators**: Blu-ray, 4K, UHD, DVD, HD-DVD, digital, or obviously a film title
- **Music indicators**: vinyl, LP, CD, cassette, record, or obviously an album/artist
- Ask the user if the domain is unclear

Determine the default format from context. If most items share a format, apply it as the default and only note exceptions.

## Adding Movies

Endpoint: `POST /admin/collecting/media`

```bash
curl -s -X POST https://api.rewind.rest/v1/admin/collecting/media \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"title":"<title>","year":<year>,"media_type":"<format>"}'
```

**Required field**: `media_type` -- one of: `bluray`, `uhd_bluray`, `dvd`, `hddvd`, `digital`

**Identification** (at least one required): `tmdb_id`, `imdb_id`, or `title` (with optional `year`)

**Optional fields**: `resolution`, `hdr`, `audio`, `audio_channels`

**Format mapping**:

- "4K UHD", "4K UHD+Blu-ray Combo", "UHD" -> `uhd_bluray`
- "Blu-ray" -> `bluray`
- "DVD" -> `dvd`

### Handling Ambiguous Matches

When the response returns `status: "ambiguous"`, show the candidates to the user and re-call with `tmdb_id`. When the matched title looks wrong (different film entirely), fall back to a direct TMDb search. See [references/disambiguation.md](./references/disambiguation.md) for the TMDb search pattern.

Always include `year` when known to reduce ambiguity.

## Adding Music

Endpoint: `POST /admin/collecting/vinyl`

```bash
curl -s -X POST https://api.rewind.rest/v1/admin/collecting/vinyl \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"title":"<title>","artist":"<artist>","year":<year>}'
```

**Identification** (at least one approach): `discogs_id` directly, or `title`/`artist` (with optional `year`)

When ambiguous, show candidates and re-call with `discogs_id`. Include `artist` whenever possible for better search precision.

## Usage

1. Parse all items and confirm the list with the user if adding more than 5 items
2. Run independent API calls in parallel (batch all movie adds together, all music adds together)
3. Handle disambiguation interactively -- show candidates, get user input, retry
4. Report results in a table: title, format, status (added/error/already existed)

## Additional Resources

- [references/disambiguation.md](references/disambiguation.md) -- TMDb and Discogs fallback search patterns, enum values for movie metadata fields
