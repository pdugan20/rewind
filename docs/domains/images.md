# Image Pipeline

Centralized image management for all domains. Fetches from multiple sources in priority order, stores originals in Cloudflare R2, generates ThumbHash blur placeholders, extracts dominant and accent colors, and serves via CDN with on-the-fly transforms through Cloudflare Images.

## Architecture

ASCII flow diagram:

```text
Image Sources              Pipeline                    Storage & Delivery
─────────────              ────────                    ──────────────────
Cover Art Archive                                      Cloudflare R2
iTunes Search API    ──►   Fetch from source   ──►     ├── original image
Apple Music API            Generate ThumbHash           └── metadata in D1
Fanart.tv                  Extract colors                      │
TMDB                       Upload to R2                        ▼
Plex transcode             Store metadata in D1         cdn.rewind.rest
                                                       └── Cloudflare Images
                                                           (on-the-fly transforms)
```

## Image Sources

### Cover Art Archive (Music -- Primary)

- Base URL: https://coverartarchive.org
- Auth: None
- Rate limit: No hard limit. MusicBrainz lookup API has soft limit of 1 req/sec.
- Used for: Album front cover art
- Resolutions: 250px, 500px, 1200px thumbnails + original (community uploads, often 1500-3000px+)
- Key endpoints:
  - GET /release/{mbid} -- JSON listing of all cover art for a release
  - GET /release/{mbid}/front -- redirects to front cover image
  - GET /release/{mbid}/front-500 -- 500px thumbnail
  - GET /release/{mbid}/front-1200 -- 1200px thumbnail
- Matching: Requires MusicBrainz Release MBID from Last.fm scrobble data
- Gotcha: Not all releases have cover art. ~70% coverage for mainstream Western music.
- Storage: Can cache/store locally. No TOS restrictions on caching duration.
- Attribution: Not required, but encouraged.

### iTunes Search API (Music -- Fallback)

- Base URL: https://itunes.apple.com/search
- Auth: None
- Rate limit: ~20 requests/minute (undocumented)
- Used for: Album art when Cover Art Archive has no match
- Max resolution: Up to 3000x3000
- Key endpoint: GET /search?term={artist}+{album}&media=music&entity=album&limit=1
- Image URL: artworkUrl100 field, replace "100x100" in URL with "600x600" or "3000x3000"
- Matching: Search by artist + album name
- Gotcha: May return wrong album for common names. Use artist + album together for accuracy.

### Apple Music API (Music -- Artist Images)

- Base URL: https://api.music.apple.com/v1/
- Auth: Authorization: Bearer {APPLE_MUSIC_DEVELOPER_TOKEN} (JWT)
- Rate limit: Generous, undocumented
- Used for: Artist images (Last.fm deprecated artist images in ~2020), high-res album art
- Max resolution: Up to 3000x3000 via URL template
- Artwork URL: Replace {w}x{h} in artwork.url with desired dimensions
- Key endpoints:
  - GET /v1/catalog/us/search?types=artists&term={name} -- search artists
  - GET /v1/catalog/us/artists/{id} -- artist detail with artwork
- Gotcha: Requires Apple Developer Program membership ($99/year). User has this.

### Fanart.tv (Music + Movies -- Backgrounds & Extras)

- Base URL: https://webservice.fanart.tv/v3/
- Auth: api_key query parameter (free to obtain)
- Rate limit: Unlimited for most API keys
- Used for: Artist backgrounds (1920x1080), artist thumbnails (1000x1000), HD logos, movie backgrounds, movie logos
- Music endpoints:
  - GET /music/{mbid}?api_key={key} -- artist images (artistthumb, artistbackground, hdmusiclogo, musicbanner)
  - GET /music/albums/{mbid}?api_key={key} -- album-specific art (albumcover, cdart)
- Movie endpoints:
  - GET /movies/{tmdb_id}?api_key={key} -- movie images (movieposter, moviebackground, hdmovielogo, moviedisc, moviebanner)
- Access tiers: Project key (free, 7-day delay), Personal key (free, 2-day delay), VIP (immediate)
- Gotcha: Community-driven coverage. Good for popular content, sparse for obscure releases.

### TMDB (Movies -- Posters)

- Image CDN: https://image.tmdb.org/t/p/{size}/{poster_path}
- Auth: None for images (just need poster_path from TMDB API response)
- Sizes: w92, w154, w185, w342, w500, w780, original (up to 2000x3000)
- Used for: Movie posters, backdrops
- Attribution: Required. TMDB logo + disclaimer text.
- Caching: Can cache up to 6 months per TOS.

### Plex Transcoding Endpoint (Movies -- Fallback)

- URL: {PLEX_URL}/photo/:/transcode?url={thumb_path}&width={w}&height={h}&X-Plex-Token={token}
- Auth: Plex token
- Used for: Movie art when TMDB has no match, or when Plex has custom artwork
- Supports: width, height, blur, opacity, saturation, format (jpeg/png)
- Gotcha: Requires Plex server to be reachable. Not suitable for production CDN -- fetch once and store in R2.

## Source Priority Waterfall

### Music -- Album Art

| Priority | Source            | Match By            | Resolution                        | Notes               |
| -------- | ----------------- | ------------------- | --------------------------------- | ------------------- |
| 1        | Cover Art Archive | MBID                | Up to 1200px thumbnail + original | Free, no auth, open |
| 2        | iTunes Search API | artist + album name | Up to 3000x3000                   | Free, no auth       |
| 3        | Apple Music API   | artist + album name | Up to 3000x3000                   | Requires dev token  |

### Music -- Artist Images

| Priority | Source          | Match By           | Resolution                                | Notes             |
| -------- | --------------- | ------------------ | ----------------------------------------- | ----------------- |
| 1        | Apple Music API | artist name search | Up to 3000x3000                           | Official images   |
| 2        | Fanart.tv       | MBID               | 1000x1000 thumbnail, 1920x1080 background | Community-curated |

### Movie -- Posters & Backdrops

| Priority | Source         | Match By           | Resolution                             | Notes             |
| -------- | -------------- | ------------------ | -------------------------------------- | ----------------- |
| 1        | TMDB           | TMDB ID or IMDB ID | Up to 2000x3000                        | Industry standard |
| 2        | Fanart.tv      | TMDB ID            | 1000x1426 poster, 1920x1080 background | Extra art types   |
| 3        | Plex transcode | Plex thumb path    | Configurable                           | Fallback only     |

### Vinyl/CD Collection -- Cover Art

| Priority | Source            | Match By          | Resolution              | Notes                  |
| -------- | ----------------- | ----------------- | ----------------------- | ---------------------- |
| 1        | Cover Art Archive | MBID (if matched) | Up to 1200px + original | Better quality         |
| 2        | Discogs           | Release ID        | ~500-600px              | Actual release artwork |

## R2 Storage

### Configuration

- Bucket name: rewind-images
- Binding name: IMAGES (in wrangler.toml)
- Custom domain: cdn.rewind.rest

### Key Naming Convention

```text
{domain}/{entity_type}/{entity_id}/original.{ext}
```

Examples:

```text
listening/albums/abc123-mbid/original.jpg
listening/artists/def456-mbid/original.jpg
watching/movies/tmdb-27205/original.jpg
watching/movies/tmdb-27205/backdrop.jpg
collecting/releases/discogs-67890/original.jpg
```

### Object Metadata

Store with each R2 object:

- content-type (image/jpeg, image/png, image/webp)
- x-source (cover-art-archive, itunes, apple-music, fanart-tv, tmdb, plex)
- x-source-url (original source URL)
- x-dimensions ({width}x{height})

### Lifecycle

Images are permanent. No auto-deletion policy. Album art and movie posters do not change.

## Cloudflare Images Transforms

### How It Works

Cloudflare Images provides on-the-fly image transformation via the cf-images binding in Workers or via URL-based transforms on the CDN domain.

### Transform Parameters

| Parameter | Values                                 | Description                                 |
| --------- | -------------------------------------- | ------------------------------------------- |
| width     | number                                 | Target width in pixels                      |
| height    | number                                 | Target height in pixels                     |
| fit       | cover, contain, scale-down, crop       | How to fit image to dimensions              |
| format    | auto, webp, avif, jpeg                 | Output format (auto picks best for browser) |
| quality   | 1-100                                  | Output quality (default 85)                 |
| blur      | 1-250                                  | Blur radius                                 |
| gravity   | auto, center, top, bottom, left, right | Crop anchor point                           |

### Size Presets

| Name      | Dimensions | Fit        | Use Case                        |
| --------- | ---------- | ---------- | ------------------------------- |
| thumbnail | 64x64      | cover      | Inline icons, tiny previews     |
| small     | 150x150    | cover      | List items, compact grids       |
| medium    | 300x300    | cover      | Card views, album grids         |
| large     | 600x600    | cover      | Detail views, hero images       |
| poster    | 342x513    | cover      | Movie poster cards (2:3 ratio)  |
| poster-lg | 500x750    | cover      | Movie poster detail (2:3 ratio) |
| backdrop  | 780x439    | cover      | Movie backdrop (16:9 ratio)     |
| original  | as-is      | scale-down | Full resolution download        |

### CDN URL Pattern

```text
cdn.rewind.rest/{r2_key}?width={w}&height={h}&fit=cover&format=auto&quality=85
```

Or via named variants:

```text
cdn.rewind.rest/{r2_key}/medium
cdn.rewind.rest/{r2_key}/poster
```

### Caching

All images served with: Cache-Control: public, max-age=31536000, immutable

Cloudflare edge caches transformed variants globally. Subsequent requests for the same transform serve from cache.

## ThumbHash and Color Extraction

### Overview

ThumbHash encodes a compact blur placeholder (~30 bytes) for any image. Dominant and accent colors provide quick color context for UI theming. Both are generated at ingest time, stored in D1, and returned in API responses. The client decodes the ThumbHash to a data URL for instant blur-up loading and uses the colors for background tints or accent styling.

### Process

1. Fetch original image from source
2. Decode to raw RGBA pixel data
3. Resize to max 100x100 pixels (ThumbHash input size)
4. Extract dominant and accent colors using k-means clustering or simple histogram analysis on the pixel data
5. Generate ThumbHash binary via thumbhash library
6. Encode ThumbHash as base64 string
7. Store dominant color in `images.dominant_color` and accent color in `images.accent_color` as hex strings (e.g., `#1a2b3c`)
8. Store ThumbHash in `images.thumbhash` column

### Images Table Columns

The images table includes the following image metadata columns:

- `thumbhash TEXT` -- base64-encoded ThumbHash blur placeholder
- `dominant_color TEXT` -- hex string of the most prominent color (e.g., `#1a2b3c`)
- `accent_color TEXT` -- hex string of a secondary/contrasting color (e.g., `#4d5e6f`)
- `is_override INTEGER NOT NULL DEFAULT 0` -- 1 if image was manually set
- `override_at TEXT` -- timestamp when the override was applied
- `image_version INTEGER NOT NULL DEFAULT 1` -- incremented on override, used for CDN cache busting

The images table includes `user_id` for multi-user support (default 1).

### Workers Compatibility

- Cannot use sharp (requires native bindings, no Workers support)
- Cannot use canvas (no DOM in Workers)
- Solution: Pure-JS decoders (`jpeg-js` for JPEG, `fast-png` for PNG) decode to raw RGBA pixel data, then custom downsampling reduces to 100x100 max for ThumbHash generation and k-means color extraction

### Client Usage

```typescript
import { thumbHashToDataURL } from 'thumbhash';

function BlurPlaceholder({ thumbhash }: { thumbhash: string }) {
  const bytes = Uint8Array.from(atob(thumbhash), c => c.charCodeAt(0));
  const dataURL = thumbHashToDataURL(bytes);
  return <img src={dataURL} alt="" aria-hidden />;
}
```

### API Response Pattern

All entity endpoints return a standardized `image` field (or `null` when no image exists):

```json
{
  "image": {
    "cdn_url": "https://cdn.rewind.rest/listening/albums/123/original.jpg?width=300&height=300&v=1",
    "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
    "dominant_color": "#1a2b3c",
    "accent_color": "#4d5e6f"
  }
}
```

The shared `ImageAttachment` type is defined in `src/lib/images.ts` and used by all route handlers via `getImageAttachment()` and `getImageAttachmentBatch()`. No domain-specific image helpers or inline external URLs exist in route handlers.

The client shows the ThumbHash blur while fetching cdn_url, and uses dominant_color/accent_color for UI theming.

## CDN Setup

### Domain Configuration

1. Add cdn.rewind.rest as custom domain for R2 bucket in Cloudflare dashboard
2. Configure SSL/TLS (automatic with Cloudflare)
3. Set CORS headers: Access-Control-Allow-Origin for patdugan.me and localhost:3000

### CORS Configuration (via Worker or Transform Rules)

```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // or restrict to patdugan.me
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
```

### Cache Configuration

- Browser cache: max-age=31536000, immutable
- Cloudflare edge cache: respects Cache-Control headers
- Cache purge: rarely needed (images are permanent), available via Cloudflare API if needed

## Image Route Handler

### Endpoint

All endpoints require `Authorization: Bearer rw_...` header.

```text
GET /v1/images/:domain/:entity_type/:entity_id/:size
```

### Flow

1. Parse domain, entity_type, entity_id, size from URL
2. Look up image in images table by (domain, entity_type, entity_id)
3. If found: redirect to cdn.rewind.rest/{r2_key}?{size_params}&v={image_version}
4. If not found: trigger pipeline
   a. Run source waterfall for the domain
   b. Fetch image from winning source
   c. Upload to R2
   d. Generate ThumbHash
   e. Extract dominant and accent colors
   f. Store metadata in images table
   g. Redirect to CDN URL
5. Return X-ThumbHash, X-Dominant-Color, and X-Accent-Color headers

### Response Headers

```text
Location: https://cdn.rewind.rest/listening/albums/abc123/original.jpg?width=300&height=300&fit=cover&format=auto&v=1
X-ThumbHash: YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==
X-Dominant-Color: #1a2b3c
X-Accent-Color: #4d5e6f
Cache-Control: public, max-age=31536000, immutable
```

## Environment Variables

| Variable                    | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| FANART_TV_API_KEY           | Fanart.tv project API key (free)                     |
| APPLE_MUSIC_DEVELOPER_TOKEN | Apple Music JWT (shared with listening domain)       |
| TMDB_API_KEY                | TMDB read access token (shared with watching domain) |

R2 bucket binding (IMAGES) configured in wrangler.toml.

## Image Overrides

Admin users can manually override any image. This is useful when the automatic pipeline selects a low-quality or incorrect image.

### Override Endpoints

All override endpoints require `Authorization: Bearer rw_admin_...` header.

```text
GET  /v1/admin/images/:domain/:entity_type/:entity_id/alternatives
PUT  /v1/admin/images/:domain/:entity_type/:entity_id
DELETE /v1/admin/images/:domain/:entity_type/:entity_id/override
```

### Browse Alternatives

`GET /v1/admin/images/:domain/:entity_type/:entity_id/alternatives` queries all sources in the waterfall for the given entity and returns available image options without storing anything.

```json
{
  "entity": {
    "domain": "listening",
    "entity_type": "albums",
    "entity_id": "abc123-mbid"
  },
  "current_source": "cover-art-archive",
  "is_override": false,
  "alternatives": [
    {
      "source": "cover-art-archive",
      "url": "https://coverartarchive.org/release/abc123/front",
      "width": 1200,
      "height": 1200
    },
    {
      "source": "itunes",
      "url": "https://is1-ssl.mzstatic.com/image/thumb/Music/.../600x600bb.jpg",
      "width": 600,
      "height": 600
    },
    {
      "source": "apple-music",
      "url": "https://is1-ssl.mzstatic.com/image/thumb/Music/.../3000x3000bb.jpg",
      "width": 3000,
      "height": 3000
    }
  ]
}
```

### Set Override

`PUT /v1/admin/images/:domain/:entity_type/:entity_id` accepts either a `source_url` (JSON body) to fetch from one of the alternatives, or a raw image upload (multipart/form-data).

**Option A -- pick from alternatives (JSON body):**

```json
{
  "source_url": "https://is1-ssl.mzstatic.com/image/thumb/Music/.../3000x3000bb.jpg"
}
```

**Option B -- upload custom image (multipart/form-data):**

```text
Content-Type: multipart/form-data
--boundary
Content-Disposition: form-data; name="image"; filename="custom-cover.jpg"
Content-Type: image/jpeg
(binary data)
--boundary--
```

**Flow:**

1. Receive image from source_url or upload
2. Upload to R2 (overwrites existing key)
3. Regenerate ThumbHash, dominant color, accent color
4. Update images table: `source = 'manual'`, `is_override = 1`, `override_at = now()`, increment `image_version`
5. Return updated image metadata

**Response:**

```json
{
  "domain": "listening",
  "entity_type": "albums",
  "entity_id": "abc123-mbid",
  "image_url": "https://cdn.rewind.rest/listening/albums/abc123-mbid/original.jpg?v=2",
  "source": "manual",
  "is_override": true,
  "image_version": 2,
  "thumbhash": "YJqGPQw7sFlslqhFafSE+Q6oJ1h2iA==",
  "dominant_color": "#2a3b4c",
  "accent_color": "#5e6f80"
}
```

### Revert Override

`DELETE /v1/admin/images/:domain/:entity_type/:entity_id/override` clears the override flag, re-runs the automatic pipeline, and restores the highest-priority source image.

**Flow:**

1. Set `is_override = 0`, `override_at = null`
2. Re-run source waterfall for the entity
3. Fetch, upload, regenerate ThumbHash and colors
4. Increment `image_version` (busts cache for the override)
5. Return updated image metadata

### Sync Protection

During any automatic sync or pipeline run, images with `is_override = 1` are skipped:

```text
Pipeline runs for entity X:
  1. Check images table for (domain, entity_type, entity_id)
  2. If is_override = 1, skip entirely
  3. If is_override = 0 or no row exists, proceed with normal waterfall
```

### Cache Busting

CDN URLs include `?v={image_version}`. Cloudflare treats different query params as different cache keys, so incrementing the version on override or revert causes the new image to be fetched fresh. Old cached versions expire naturally.

## Sync-Time Image Processing

After each domain sync (cron or manual), the system automatically queries for entities without images and processes them in the background via `waitUntil()`.

- `processListeningImages()` -- albums + artists missing images
- `processWatchingImages()` -- movies + shows missing images
- `processCollectingImages()` -- releases missing images

Processing is capped at 50 items per sync run (configurable via `maxItems`) to stay within Worker CPU limits. Unprocessed entities are picked up on the next sync cycle.

Implementation: `src/services/images/sync-images.ts`, wired into cron handler in `src/index.ts`.

## Search Hints

The `images` table includes a `search_hints` column (JSON text) that stores the search parameters used to find an image (e.g., `artistName`, `albumName`, `mbid`, `tmdbId`). This enables:

- Re-processing images on cache miss without requiring the caller to pass search params
- The CDN proxy endpoint to re-run the pipeline for records that have hints but no R2 key

## Image Decoding

ThumbHash and color extraction require decoding images to raw RGBA pixels. In the Workers environment (no sharp/canvas), the pipeline uses:

- `jpeg-js` for JPEG decoding
- `fast-png` for PNG decoding (handles 1/2/3/4 channel images)
- Custom `downsample()` to resize to max 100x100 for ThumbHash spec compliance

Implementation: `src/services/images/decode.ts`

## No-Source Placeholders

When the pipeline cannot find an image from any source, a placeholder row is inserted into the `images` table with `r2_key = ''`, `source = 'none'`, and `image_version = 0`. This prevents the same entity from being retried on every sync cycle or backfill run.

The `getImageAttachment()` and `getImageAttachmentBatch()` utilities in `src/lib/images.ts` filter out placeholder rows (checking `!row.r2Key`), returning `null` so the API returns `"image": null` for these entities.

To query placeholder counts:

```sql
SELECT COUNT(*) FROM images WHERE source = 'none' AND domain = 'listening';
```

## Known Issues

- Cover Art Archive requires MBID -- not all Last.fm tracks have MBIDs
- iTunes Search API rate limit (~20/min) can bottleneck bulk image fetching during initial import
- Discogs image TOS restricts caching > 6 hours -- use CCA/iTunes for album art, Discogs for metadata only
- Apple Music developer token expires every 6 months -- must regenerate
- Fanart.tv has 7-day delay for new images on free project keys
- TMDB requires attribution when using their images
- Last.fm soundtrack albums are split by per-track artist, creating many album entries that will never match image sources
- Backfill batches of 100+ can hit Worker CPU limits (error 1102) -- use 50-item batches with delays
