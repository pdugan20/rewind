# Movie Deduplication -- Design Notes

## Problem

Three sources create `movies` rows using different lookup keys:

| Source | Primary Key | TMDB ID? | Risk |
|-------------|-----------------|----------|------|
| Plex | `plexRatingKey` | Sometimes | May insert without tmdbId, creating a row that Letterboxd can't find |
| Letterboxd | `tmdbId` | Always | Creates new row if Plex row exists without tmdbId |
| Trakt | `tmdbId` | Always | Same risk as Letterboxd |
| Manual | `tmdbId` | Always | Same risk |

## Current Lookup Logic

```text
Plex sync:     SELECT ... WHERE plexRatingKey = ?
Letterboxd:    SELECT ... WHERE tmdbId = ?
Trakt:         SELECT ... WHERE tmdbId = ?
Manual:        SELECT ... WHERE tmdbId = ?
```

If Plex inserts a movie with `plexRatingKey = 12345` and `tmdbId = NULL`, then Letterboxd later syncs the same film with `tmdbId = 550`, you get two rows for the same movie with separate watch histories.

## Solution: Unified Resolution Function

Create `src/services/watching/resolve-movie.ts` with a single `resolveMovie()` function that all sources call:

```text
resolveMovie({ tmdbId?, plexRatingKey?, title, year })
  1. If tmdbId provided:
     SELECT ... WHERE tmdbId = ?
     -> found: return existing row (update plexRatingKey if provided and missing)
     -> not found: continue to step 3

  2. If plexRatingKey provided:
     SELECT ... WHERE plexRatingKey = ?
     -> found: if tmdbId missing on row, resolve via TMDB and update. return row.
     -> not found: continue to step 3

  3. Search TMDB by title + year, get tmdbId
     SELECT ... WHERE tmdbId = ?
     -> found: return existing row (update plexRatingKey if provided and missing)
     -> not found: INSERT new movie with all available IDs. return new row.
```

This ensures:

- Every movie gets a tmdbId (the universal key) on first encounter
- Plex movies that arrive before Letterboxd get their tmdbId populated immediately
- Subsequent sources always find the existing row via tmdbId
- plexRatingKey is back-filled onto rows that were created by other sources

## Migration Script for Existing Duplicates

```text
1. Find duplicates: movies with matching tmdbId or matching (title, year, tmdbId IS NOT NULL)
2. For each group, pick the "winner" (prefer row with most watch_history records)
3. UPDATE watch_history SET movieId = winner WHERE movieId IN (losers)
4. UPDATE movie_genres SET movieId = winner WHERE movieId IN (losers) (skip conflicts)
5. UPDATE movie_directors SET movieId = winner WHERE movieId IN (losers) (skip conflicts)
6. UPDATE trakt_collection SET movieId = winner WHERE movieId IN (losers)
7. UPDATE images SET entityId = winner WHERE entityId IN (losers) AND domain = 'watching'
8. DELETE FROM movies WHERE id IN (losers)
```

Run diagnostic query first to understand scope before writing the migration.
