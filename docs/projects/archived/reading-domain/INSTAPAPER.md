# Instapaper Integration

Technical reference for the Instapaper API integration.

## Authentication

Instapaper uses OAuth 1.0a with xAuth for token exchange. Unlike standard OAuth, there's no browser redirect flow -- you exchange username/password directly for an access token.

### Token Exchange (one-time setup)

```
POST https://www.instapaper.com/api/1/oauth/access_token
Content-Type: application/x-www-form-urlencoded

x_auth_username=user@example.com
x_auth_password=password
x_auth_mode=client_auth
```

Returns `oauth_token` and `oauth_token_secret`. These are permanent -- no refresh needed.

### Required Secrets

| Secret                           | Description                                              |
| -------------------------------- | -------------------------------------------------------- |
| `INSTAPAPER_CONSUMER_KEY`        | API consumer key (from Instapaper developer application) |
| `INSTAPAPER_CONSUMER_SECRET`     | API consumer secret                                      |
| `INSTAPAPER_ACCESS_TOKEN`        | OAuth access token (from xAuth exchange)                 |
| `INSTAPAPER_ACCESS_TOKEN_SECRET` | OAuth token secret (from xAuth exchange)                 |

Store in `.dev.vars` for local development, Cloudflare Workers secrets for production.

### Setup Script

A one-time script (`scripts/tools/instapaper-auth.ts`) will:

1. Read consumer key/secret and credentials from env
2. Perform xAuth token exchange
3. Output the access token and secret to add to Cloudflare secrets

## API Endpoints Used

### Bookmarks

```
POST /api/1/bookmarks/list
  folder_id: 'unread' | 'starred' | 'archive' | folder_id
  limit: 1-500 (default 25)
  have: comma-separated bookmark_ids to exclude

Returns: array of bookmark objects
```

### Bookmark Text (for word count)

```
POST /api/1/bookmarks/{bookmark_id}/get_text

Returns: processed HTML of article content
```

### Folders

```
POST /api/1/folders/list

Returns: array of folder objects
```

### Highlights

```
POST /api/1.1/bookmarks/{bookmark_id}/highlights

Returns: array of highlight objects
```

## Sync Strategy

### Incremental Sync (cron, every 6 hours)

1. Fetch bookmarks from `unread` folder (limit 500)
2. Fetch bookmarks from `starred` folder (limit 500)
3. Fetch bookmarks from `archive` folder (limit 100, most recent only)
4. For each bookmark:
   a. Upsert into `reading_items`
   b. Derive `status` from folder + progress (see SCHEMA.md)
   c. Set `started_at` if progress > 0 and not already set
   d. Set `finished_at` if folder is archive and not already set
5. For each new bookmark:
   a. Fetch `get_text` to count words, compute `estimated_read_min`
   b. Fetch article URL for OG metadata (image, author, site_name)
   c. Trigger image pipeline for OG image
6. For each bookmark with highlights:
   a. Fetch highlights from `/api/1.1/bookmarks/{id}/highlights`
   b. Upsert into `reading_highlights`
7. Post-sync: update feed, search index, reading stats

### Hash-based Change Detection

Instapaper's `hash` field changes when URL, title, description, or progress changes. We store the last-seen hash per bookmark and skip unchanged items.

### Rate Limit Handling

Instapaper doesn't document specific limits. Strategy:

- 200ms delay between API calls during sync
- 500ms delay between `get_text` calls (heavier endpoint)
- If 429/1040 error, back off exponentially
- Sync run records success/failure for retry logic (existing `sync-retry.ts`)

## OG Metadata Extraction

For each new article URL, fetch the HTML `<head>` and extract:

| OG tag                            | Maps to                                     |
| --------------------------------- | ------------------------------------------- |
| `og:image`                        | Image pipeline source URL                   |
| `og:site_name`                    | `site_name` field                           |
| `article:author` or `author` meta | `author` field                              |
| `og:description`                  | Fallback if Instapaper description is empty |

Use a lightweight fetch with `Accept: text/html` and parse only the `<head>` section (stop reading at `</head>` to avoid downloading full page body).

## Word Count Estimation

```
estimated_read_min = ceil(word_count / 238)
```

238 WPM is the average adult reading speed. This matches Instapaper's own estimates.

## Historical Backfill

Initial import script (`scripts/imports/import-instapaper.ts`):

1. Fetch all bookmarks from all folders (paginated, 500 per call)
2. Insert into `reading_items` with appropriate status
3. Batch `get_text` calls with 500ms delays for word count
4. Batch OG metadata fetches with 200ms delays
5. Batch highlight fetches
6. Run image pipeline for all articles with OG images
7. Log progress every 50 articles

Estimate: if you have ~1000 bookmarks, this would take roughly 15-20 minutes accounting for rate limit delays.
