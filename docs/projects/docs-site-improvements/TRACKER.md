# Docs Site Improvements -- Task Tracker

## Phase 1: OpenAPI Quality

Fix all 104 Spectral warnings and add response examples before the Mintlify migration, so auto-generated API reference pages are polished from day one.

**1.1 -- Spec Infrastructure**

- [x] **1.1.1** Add `servers` block to `src/lib/openapi.ts`: `[{ url: "https://api.rewind.rest", description: "Production" }]` _(already existed)_
- [x] **1.1.2** Reorder tags: public domains first (Listening, Running, Watching, Collecting), then cross-domain (Feed, Search, Images), then system (System, Admin, Webhooks) _(already correct)_
- [x] **1.1.3** Review and improve the `info.description` markdown -- ensure Quick Start examples are accurate _(already good)_

**1.2 -- operationId on All Endpoints**

- [x] **1.2.1** Define naming convention: `camelCase`, pattern `{verb}{Domain}{Resource}` (e.g., `getListeningRecent`, `listRunningActivities`)
- [x] **1.2.2** Add operationId to `system.ts` routes (2 endpoints)
- [x] **1.2.3** Add operationId to `keys.ts` routes (3 endpoints)
- [x] **1.2.4** Add operationId to `search.ts` routes (1 endpoint)
- [x] **1.2.5** Add operationId to `feed.ts` routes (3 endpoints)
- [x] **1.2.6** Add operationId to `images.ts` routes (5 endpoints)
- [x] **1.2.7** Add operationId to `webhooks.ts` routes (3 endpoints)
- [x] **1.2.8** Add operationId to `listening.ts` routes (21 endpoints)
- [x] **1.2.9** Add operationId to `running.ts` routes (19 endpoints)
- [x] **1.2.10** Add operationId to `watching.ts` routes (19 endpoints)
- [x] **1.2.11** Add operationId to `collecting.ts` routes (22 endpoints)
- [x] **1.2.12** Add operationId to remaining routes (export, admin-sync -- 8 endpoints)
- [x] **1.2.13** Run `npm run lint:api` and verify 0 Spectral errors -- promoted all rules from warn to error in `.spectral.yml`
- [x] **1.2.14** Update OpenAPI snapshot: `npm run spec:update`

**1.3 -- Response Examples**

Add example response bodies to the most-used endpoints so the API reference shows real data shapes.

- [x] **1.3.1** Add response example to `GET /v1/listening/recent` (scrobble list with pagination)
- [x] **1.3.2** Add response example to `GET /v1/listening/top/artists` (top list with images)
- [x] **1.3.3** Add response example to `GET /v1/running/stats` (stats summary)
- [x] **1.3.4** Add response example to `GET /v1/running/activities` (activity list)
- [x] **1.3.5** Add response example to `GET /v1/watching/recent` (recent watches with movie details)
- [x] **1.3.6** Add response example to `GET /v1/watching/movies` (movie list)
- [x] **1.3.7** Add response example to `GET /v1/collecting/collection` (vinyl collection)
- [x] **1.3.8** Add response example to `GET /v1/feed` (cross-domain feed)
- [x] **1.3.9** Add response example to `GET /v1/search` (search results)
- [x] **1.3.10** Add response example to `GET /v1/health` (health check)
- [x] **1.3.11** Update OpenAPI snapshot: `npm run spec:update`

## Phase 2: Mintlify Setup

Migrate from standalone Scalar HTML page to Mintlify hosted docs platform.

**2.1 -- Initialize Mintlify**

- [ ] **2.1.1** Sign up for Mintlify Hobby (free) plan
- [ ] **2.1.2** Initialize Mintlify project (via CLI or dashboard) -- creates `mint.json` config and content directory
- [ ] **2.1.3** Connect GitHub repo for content sync
- [ ] **2.1.4** Configure `mint.json`: project name, logo, colors, favicon, navigation structure

**2.2 -- OpenAPI Integration**

- [ ] **2.2.1** Configure OpenAPI source in `mint.json` pointing to `https://api.rewind.rest/v1/openapi.json`
- [ ] **2.2.2** Configure API playground with Bearer auth pattern
- [ ] **2.2.3** Verify auto-generated API reference pages render correctly with operationIds and examples
- [ ] **2.2.4** Configure tag grouping in sidebar: group by domain (Listening, Running, Watching, Collecting, etc.)

**2.3 -- Theme and Branding**

- [ ] **2.3.1** Configure color scheme to match landing site dark palette (`#0a0a0a` background, `#e5e5e5` text)
- [ ] **2.3.2** Add Rewind logo/favicon
- [ ] **2.3.3** Configure light/dark mode toggle (or dark-only if supported)
- [ ] **2.3.4** Review typography and spacing against SF Compute reference

**2.4 -- Custom Domain and Deployment**

- [ ] **2.4.1** Configure custom domain `docs.rewind.rest` in Mintlify dashboard
- [ ] **2.4.2** Update DNS CNAME to point to Mintlify
- [ ] **2.4.3** Verify site loads at `docs.rewind.rest`
- [ ] **2.4.4** Decommission old `docs-scalar/index.html` and `rewind-docs` Cloudflare Pages project
- [ ] **2.4.5** Update `docs:deploy` script in `package.json` (may no longer be needed if Mintlify auto-deploys from Git)

## Phase 3: Content Migration

Add getting-started guides and domain overviews so developers have a guided onboarding path.

**3.1 -- Getting Started**

- [ ] **3.1.1** Write Introduction page: what Rewind is, what data it aggregates, link to API reference
- [ ] **3.1.2** Write Quick Start guide: obtain API key, make first request, understand pagination, understand date filtering
- [ ] **3.1.3** Write Authentication guide: read keys vs admin keys, how to pass Bearer token, rate limiting

**3.2 -- Domain Overviews**

- [ ] **3.2.1** Write Listening overview: what it tracks (Last.fm + Apple Music), key endpoints, common patterns
- [ ] **3.2.2** Write Running overview: what it tracks (Strava), key endpoints, stats and charts
- [ ] **3.2.3** Write Watching overview: what it tracks (Plex + Letterboxd), key endpoints, ratings/reviews
- [ ] **3.2.4** Write Collecting overview: what it tracks (Discogs + Trakt), key endpoints, wantlist
- [ ] **3.2.5** Write Images overview: how the image pipeline works, CDN URLs, thumbhash, color extraction

**3.3 -- Navigation Structure**

- [ ] **3.3.1** Configure sidebar in `mint.json` with sections: Getting Started, Domains, API Reference
- [ ] **3.3.2** Add "On this page" table of contents for longer guides
- [ ] **3.3.3** Verify navigation flow from introduction -> quick start -> domain guides -> API reference

**3.4 -- Changelog**

- [ ] **3.4.1** Create changelog page with recent significant changes
- [ ] **3.4.2** Document process for updating changelog with future changes

## Phase 4: Landing Site Polish

Bring `rewind.rest` up to professional standards with proper meta tags and SEO.

**4.1 -- Meta Tags and Favicon**

- [ ] **4.1.1** Create or source a Rewind favicon (ico + svg + apple-touch-icon)
- [ ] **4.1.2** Add favicon links to `Base.astro` `<head>`
- [ ] **4.1.3** Add Open Graph meta tags: `og:title`, `og:description`, `og:image`, `og:url`, `og:type`
- [ ] **4.1.4** Add Twitter card meta tags: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
- [ ] **4.1.5** Create or source an OG image (1200x630) for link previews

**4.2 -- SEO and Discoverability**

- [ ] **4.2.1** Install `@astrojs/sitemap` and configure in `astro.config.mjs`
- [ ] **4.2.2** Add `<meta name="robots" content="index, follow">` to `Base.astro`
- [ ] **4.2.3** Add canonical URL meta tag

**4.3 -- Content and Link Cleanup**

- [ ] **4.3.1** Audit footer link to GitHub repo -- if repo is private, remove or link to docs instead
- [ ] **4.3.2** Remove dead references in `/docs/README.md` (`API.md`, `ROADMAP.md`)
- [ ] **4.3.3** Verify all links on the landing site resolve correctly

## Phase 5: AI Readiness

Make the API discoverable and usable by AI coding assistants and agents.

**5.1 -- llms.txt**

- [ ] **5.1.1** Research `llms.txt` format and best practices for API documentation
- [ ] **5.1.2** Create a `GET /llms.txt` or `GET /v1/llms.txt` endpoint that returns a machine-readable API summary
- [ ] **5.1.3** Include: base URL, auth pattern, domain overview, top endpoints with example curl commands
- [ ] **5.1.4** Test with AI coding assistants to validate usefulness

**5.2 -- Machine-Readable Schema**

- [ ] **5.2.1** Ensure OpenAPI spec is fully valid (0 errors, 0 warnings from Spectral)
- [ ] **5.2.2** Verify spec is accessible at a stable, public URL with proper CORS and cache headers
