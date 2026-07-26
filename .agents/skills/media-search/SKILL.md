---
name: media-search
description: This skill should be used when the user asks to "search for a movie", "find a record on Discogs", "look up a film", "search TMDb", "search Discogs", "what's the TMDb ID for", "what's the Discogs ID for", or wants to look up media metadata before adding it to the collection.
---

# Media Search

Search TMDb (movies) and Discogs (music releases) to find metadata and IDs. Useful for disambiguation before adding items to the collection, or for quick lookups.

## Setup

Read API keys from `.dev.vars`:

- `TMDB_API_KEY` -- for movie searches (used as Bearer token)
- `DISCOGS_PERSONAL_TOKEN` -- for music searches (used as `Discogs token=<value>`)

## Movie Search (TMDb)

```bash
curl -s "https://api.themoviedb.org/3/search/movie?query=<title>&language=en-US" \
  -H "Authorization: Bearer <TMDB_API_KEY>"
```

Add `&year=<year>` to narrow results. If the year filter returns nothing, retry without it.

Display results as a table: TMDb ID, title, release date. For detailed info on a specific movie:

```bash
curl -s "https://api.themoviedb.org/3/movie/<tmdb_id>?language=en-US" \
  -H "Authorization: Bearer <TMDB_API_KEY>"
```

## Music Search (Discogs)

```bash
curl -s "https://api.discogs.com/database/search?q=<query>&type=release&per_page=10" \
  -H "Authorization: Discogs token=<DISCOGS_PERSONAL_TOKEN>" \
  -H "User-Agent: RewindAPI/1.0"
```

Add `&artist=<artist>` and/or `&year=<year>` to narrow results.

Display results as a table: Discogs ID, title (includes artist), year, format, country. For detailed info:

```bash
curl -s "https://api.discogs.com/releases/<discogs_id>" \
  -H "Authorization: Discogs token=<DISCOGS_PERSONAL_TOKEN>" \
  -H "User-Agent: RewindAPI/1.0"
```

## Usage

Determine the search domain from context:

- Mentions of director, actor, Blu-ray, or clearly a film -> TMDb
- Mentions of artist, band, album, vinyl, LP, CD -> Discogs
- If unclear, search both and present results grouped by domain
