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

## Phase 3.5: Docs Site Polish -- COMPLETE

- [x] **3.5.1** Real response examples on all 72 public endpoints with curated data
- [x] **3.5.2** Tabbed navigation layout (Guides + API Reference)
- [x] **3.5.3** Almond theme, bluish-purple accent (#6874e8), icons on Basics pages, "Get Started" CTA button, "Copy page" contextual menu
- [x] **3.5.4** All sidebar links verified, 44 broken domain overview links fixed
- [x] **3.5.5** Deleted `rewind-docs` CF Pages project and `pdugan20/docs` repo
- [x] **3.5.6** Hidden 32 admin/webhook endpoints with `x-hidden: true`
- [x] **3.5.7** Changelog page with `<Update>` components and tag filters
- [x] **3.5.8** Fixed all broken links in domain overview pages (44 links)

## Phase 4: Landing Site Polish

Bring `rewind.rest` up to professional standards.

**4.1 -- Logo**

- [ ] **4.1.1** Design a Rewind logo (or source one)
- [ ] **4.1.2** Create logo variants: dark background, light background, favicon sizes
- [ ] **4.1.3** Add logo to landing site (`docs-site/`)
- [ ] **4.1.4** Add logo to Mintlify docs (`docs-mintlify/`)

**4.2 -- Favicon and Meta Tags**

- [ ] **4.2.1** Generate favicon from logo (ico + svg + apple-touch-icon)
- [ ] **4.2.2** Add favicon links to `Base.astro` `<head>`
- [ ] **4.2.3** Add Open Graph meta tags: `og:title`, `og:description`, `og:image`, `og:url`, `og:type`
- [ ] **4.2.4** Add Twitter card meta tags: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
- [ ] **4.2.5** Create OG image (1200x630) for link previews

**4.3 -- SEO and Discoverability**

- [ ] **4.3.1** Install `@astrojs/sitemap` and configure in `astro.config.mjs`
- [ ] **4.3.2** Add `<meta name="robots" content="index, follow">` to `Base.astro`
- [ ] **4.3.3** Add canonical URL meta tag

**4.4 -- Theme Alignment**

- [ ] **4.4.1** Align landing site colors with docs site (primary accent, backgrounds, text)
- [ ] **4.4.2** Ensure consistent typography between landing site and docs
- [ ] **4.4.3** Review both sites side-by-side and fix any visual inconsistencies

**4.5 -- Status Page**

- [ ] **4.5.1** Research status page options (simple custom page vs hosted service like Instatus, Openstatus, or custom)
- [ ] **4.5.2** Design status page showing: API health, sync status per domain, uptime
- [ ] **4.5.3** Build and deploy status page (at `rewind.rest/status` or `status.rewind.rest`)
- [ ] **4.5.4** Link from landing site and docs

**4.6 -- Content and Link Cleanup**

- [ ] **4.6.1** Audit footer links on landing site
- [ ] **4.6.2** Remove dead references in `/docs/README.md` (`API.md`, `ROADMAP.md`)
- [ ] **4.6.3** Verify all links on the landing site resolve correctly

## Phase 5: AI Readiness

- [ ] **5.1** `llms.txt` endpoint
- [ ] **5.2** Verify spec is fully valid and publicly accessible
