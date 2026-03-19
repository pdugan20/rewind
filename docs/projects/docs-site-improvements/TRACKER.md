# Docs Site Improvements -- Task Tracker

## Phase 1: OpenAPI Quality -- COMPLETE

- [x] **1.1** Spec infrastructure (servers block, tag ordering, info.description -- all already in place)
- [x] **1.2** operationId on all 106 endpoints, Spectral rules promoted from warn to error
- [x] **1.3** Response examples on 10 key endpoints (initial pass)

## Phase 2: Mintlify Setup -- COMPLETE

- [x] **2.1** Sign up, connect repo, configure monorepo mode (`docs-mintlify`)
- [x] **2.2** OpenAPI integration with generated MDX endpoint pages via `@mintlify/scraping`
- [x] **2.3** Theme and branding (initial -- needs iteration)
- [x] **2.4** Custom domain `docs.rewind.rest` live, old Scalar decommissioned

## Phase 3: Content -- COMPLETE

- [x] **3.1** Getting started pages (introduction, quickstart, authentication)
- [x] **3.2** Domain overviews (listening, running, watching, collecting, images)

## Phase 3.5: Docs Site Polish -- IN PROGRESS

**3.5.1 -- Real response examples on all public endpoints -- COMPLETE**

- [x] **3.5.1.1** Add curated examples to all Listening endpoints (Nirvana, Olivia Rodrigo, Sabrina Carpenter, Beastie Boys, Taylor Swift)
- [x] **3.5.1.2** Add curated examples to all Running endpoints
- [x] **3.5.1.3** Add curated examples to all Watching endpoints (Ferris Bueller's, Interstellar, The Great Escape, Band of Brothers, Mad Men, Fallout)
- [x] **3.5.1.4** Add curated examples to all Collecting endpoints (Nirvana vinyl, Top Gun/Great Escape/Interstellar physical media)
- [x] **3.5.1.5** Add curated examples to Feed, Search, System endpoints
- [x] **3.5.1.6** Hide 32 admin/webhook endpoints with `x-hidden: true`
- [x] **3.5.1.7** Fix 44 schema mismatches (examples now match actual Zod schemas)
- [x] **3.5.1.8** Update old Phase 1 examples to use curated picks instead of stale data
- [x] **3.5.1.9** Spectral: 0 errors, spec regenerated, docs-mintlify/openapi.json updated

**3.5.2 -- Navigation layout -- COMPLETE**

- [x] **3.5.2.1** Tabs layout: Guides tab (Getting Started + Basics) and API Reference tab (collapsed endpoint groups)
- [x] **3.5.2.2** Verified on localhost:3002

**3.5.3 -- Theme and visual polish -- COMPLETE**

- [x] **3.5.3.1** Selected `palm` theme
- [x] **3.5.3.2** Set bluish-purple primary color (`#6874e8`)
- [x] **3.5.3.3** Dark mode default with toggle available
- [x] **3.5.3.4** Added icons to all guide pages (book-open, rocket, key, headphones, person-running, film, record-vinyl, image)

**3.5.4 -- Verify all sidebar links**

- [ ] **3.5.4.1** Click every sidebar link on localhost:3002 and verify no 404s
- [ ] **3.5.4.2** Fix any navigation/file mismatches

**3.5.5 -- Cleanup**

- [ ] **3.5.5.1** Delete `rewind-docs` Cloudflare Pages project from dashboard
- [ ] **3.5.5.2** Delete `pdugan20/docs` starter repo from GitHub

**3.5.6 -- Changelog**

- [ ] **3.5.6.1** Create changelog page with recent significant changes
- [ ] **3.5.6.2** Document process for updating changelog

## Phase 4: Landing Site Polish

- [ ] **4.1** Favicon, OG meta, Twitter cards, OG image
- [ ] **4.2** Sitemap, robots meta, canonical URLs
- [ ] **4.3** Footer link audit, dead reference cleanup

## Phase 5: AI Readiness

- [ ] **5.1** `llms.txt` endpoint
- [ ] **5.2** Verify spec is fully valid and publicly accessible
