# OpenAPI Quality

Technical reference for improving the OpenAPI spec quality.

## operationId Strategy

### Current State

104 Spectral warnings: every endpoint is missing `operationId`. This breaks:

- SDK/client code generation (operationId becomes the function name)
- Scalar URL anchors (path routing uses operationId)
- AI tool integration (operationId is the primary way tools identify endpoints)

### Naming Convention

Pattern: `{verb}{Domain}{Resource}{Detail?}`

- Verb: `get`, `post`, `put`, `delete`, `list`
- Domain: `Listening`, `Running`, `Watching`, `Collecting`, `Feed`, `Search`, `Images`, `System`, `Admin`
- Resource: singular noun (`Artist`, `Activity`, `Movie`, `Collection`)
- Detail: optional qualifier (`Recent`, `Stats`, `TopArtists`, `YearInReview`)

### Examples by Route File

```text
system.ts (2)
  GET  /health           -> getHealth
  GET  /health/sync      -> getHealthSync

listening.ts (19)
  GET  /listening/recent         -> getListeningRecent
  GET  /listening/now-playing    -> getListeningNowPlaying
  GET  /listening/top/artists    -> getListeningTopArtists
  GET  /listening/top/albums     -> getListeningTopAlbums
  GET  /listening/top/tracks     -> getListeningTopTracks
  GET  /listening/artists        -> listListeningArtists
  GET  /listening/artists/:id    -> getListeningArtist
  GET  /listening/albums         -> listListeningAlbums
  GET  /listening/albums/:id     -> getListeningAlbum
  GET  /listening/stats          -> getListeningStats
  GET  /listening/streaks        -> getListeningStreaks
  GET  /listening/calendar       -> getListeningCalendar
  GET  /listening/history/:name  -> getListeningHistory
  GET  /listening/year-in-review -> getListeningYearInReview
  ...admin endpoints with Admin prefix

running.ts (19)
  GET  /running/activities       -> listRunningActivities
  GET  /running/activities/:id   -> getRunningActivity
  GET  /running/stats            -> getRunningStats
  GET  /running/year-in-review   -> getRunningYearInReview
  GET  /running/streaks          -> getRunningStreaks
  GET  /running/charts/weekly    -> getRunningChartsWeekly
  GET  /running/charts/monthly   -> getRunningChartsMonthly
  GET  /running/gear             -> listRunningGear
  GET  /running/races            -> listRunningRaces
  GET  /running/eddington        -> getRunningEddington
  ...

watching.ts (19)
  GET  /watching/recent          -> getWatchingRecent
  GET  /watching/movies          -> listWatchingMovies
  GET  /watching/movies/:id      -> getWatchingMovie
  GET  /watching/shows           -> listWatchingShows
  GET  /watching/shows/:id       -> getWatchingShow
  GET  /watching/stats           -> getWatchingStats
  GET  /watching/ratings         -> listWatchingRatings
  GET  /watching/reviews         -> listWatchingReviews
  GET  /watching/year-in-review  -> getWatchingYearInReview
  ...

collecting.ts (19)
  GET  /collecting/vinyl          -> listCollectingVinyl
  GET  /collecting/vinyl/:id     -> getCollectingVinylRecord
  GET  /collecting/wantlist      -> listCollectingWantlist
  GET  /collecting/stats         -> getCollectingStats
  GET  /collecting/calendar      -> getCollectingCalendar
  GET  /collecting/media         -> listCollectingMedia
  GET  /collecting/media/:id     -> getCollectingMediaItem
  ...
```

### Implementation

In zod-openapi, `operationId` is set on the route definition:

```typescript
const route = createRoute({
  method: 'get',
  path: '/listening/recent',
  operationId: 'getListeningRecent',
  tags: ['Listening'],
  summary: 'Recent scrobbles',
  // ...
});
```

## Response Examples

### Strategy

Add `example` to the response schema's `content` block. Use realistic but anonymized data. Examples should demonstrate:

- Pagination envelope shape
- Image attachment shape (cdn_url, thumbhash, colors)
- Date format (ISO 8601)
- Null handling for optional fields
- Nested object structures

### Implementation

In zod-openapi, examples can be added to the response content:

```typescript
responses: {
  200: {
    description: 'Recent scrobbles',
    content: {
      'application/json': {
        schema: RecentScrobblesResponseSchema,
        example: {
          data: [
            {
              track: { id: 1234, name: 'Everything In Its Right Place', url: '...' },
              artist: { id: 91, name: 'Radiohead' },
              album: { id: 456, name: 'Kid A', image: { cdn_url: '...', thumbhash: '...', dominant_color: '#1a1a2e', accent_color: '#e94560' } },
              scrobbled_at: '2026-03-18T14:30:00Z',
            },
          ],
          pagination: { page: 1, limit: 20, total: 15420, total_pages: 771 },
        },
      },
    },
  },
},
```

### Priority Endpoints for Examples

1. `GET /v1/listening/recent` -- most common first call
2. `GET /v1/listening/top/artists` -- demonstrates top list + image shape
3. `GET /v1/running/stats` -- demonstrates stats summary shape
4. `GET /v1/running/activities` -- demonstrates activity detail
5. `GET /v1/watching/recent` -- demonstrates nested movie shape
6. `GET /v1/watching/movies` -- demonstrates movie list
7. `GET /v1/collecting/vinyl` -- demonstrates vinyl record shape
8. `GET /v1/feed` -- demonstrates cross-domain feed
9. `GET /v1/search` -- demonstrates search results
10. `GET /v1/health` -- simple reference shape
