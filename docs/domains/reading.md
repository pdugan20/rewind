# Reading Domain

Instapaper articles, reading progress, highlights, and enrichment metadata.

## Data Sources

- **Instapaper** — bookmarks, reading progress, folders, tags, highlights, article text

## Tables

- `reading_items` — articles (future: books), with status, progress, OG metadata, word count, content
- `reading_highlights` — highlighted passages linked to articles

## Sync

- Cron: every 6 hours (alongside Letterboxd)
- Fetches unread, starred, and archive folders
- Enriches new articles with OG metadata (author, site_name, published_at, og_image_url) and word count via get_text
- Syncs highlights per article, removes deleted highlights
- Processes article thumbnail images via image pipeline

## Status Derivation

| Instapaper state                        | Rewind status |
| --------------------------------------- | ------------- |
| progress == 0, folder unread            | `unread`      |
| progress > 0 and < 0.75, folder unread  | `reading`     |
| progress >= 0.75, any folder            | `finished`    |
| progress == 0, folder archive           | `skipped`     |
| progress > 0 and < 0.75, folder archive | `abandoned`   |

## Endpoints

### Public (13)

- `GET /reading/recent` — recently saved or finished
- `GET /reading/currently-reading` — articles in progress
- `GET /reading/articles` — browse with filters (status, domain, tag, starred)
- `GET /reading/articles/{id}` — detail with embedded highlights
- `GET /reading/archive` — finished articles
- `GET /reading/highlights` — all highlights with article context
- `GET /reading/highlights/random` — random highlight
- `GET /reading/stats` — aggregate statistics
- `GET /reading/calendar` — daily reading activity
- `GET /reading/streaks` — current and longest reading streaks
- `GET /reading/tags` — tag breakdown
- `GET /reading/domains` — top source domains
- `GET /reading/year/{year}` — year in review

### Admin (hidden)

- `POST /admin/sync/reading` — trigger Instapaper sync
- `POST /reading/admin/backfill-images` — process missing article thumbnails

## Enrichment

Each article is enriched with metadata from two sources:

**OG metadata** (from article URL HTML head):

- `og:image` → `og_image_url` (used by image pipeline for thumbnails)
- `og:site_name` → `site_name` ("Wired", "The New York Times")
- `article:author` → `author`
- `article:published_time` → `published_at`
- `og:description` → `og_description` (fallback for empty descriptions)
- `article:section` + `article:tag` → `article_tags`

**Instapaper get_text** (processed article HTML):

- Full HTML → `content` (for future full-text search)
- Word count → `word_count`
- Estimated read time → `estimated_read_min` (238 WPM)

Enrichment status tracked per article: `pending`, `completed`, `failed` with error reason.

## Known Limitations

- Paywalled sites (NYT, WSJ, Bloomberg) block OG metadata scraping (~490 of 1047 articles)
- Instapaper API returns max 500 bookmarks per folder per call
- Article thumbnails depend on `og:image` being present on the source page
