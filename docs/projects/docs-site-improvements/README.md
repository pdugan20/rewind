# Project: Docs Site Improvements

Migrate the documentation site at `docs.rewind.rest` from a standalone Scalar HTML page to Mintlify, matching the SF Compute docs experience. Improve OpenAPI spec quality and landing site polish alongside the migration.

## Motivation

The original public-api-docs project shipped a working Scalar reference and landing page, but left gaps:

- 104 Spectral warnings (missing `operationId` on every endpoint)
- Zero response examples in the OpenAPI spec
- Standalone Scalar HTML page with no prose content (no guides, getting started, or domain overviews)
- Landing site has no OG/favicon/sitemap
- Internal docs in `/docs/` are comprehensive but unpublished
- No `llms.txt` for AI agent consumption

## Design Reference

SF Compute docs ([docs.sfcompute.com](https://docs.sfcompute.com/current/introduction)) demonstrate the target experience. Their stack is **Mintlify** (hosted docs platform) with Scalar embedded for API reference pages. Key features:

- Getting Started / Quick Start guides in left sidebar alongside API Reference
- Clean tri-column layout (sidebar, content, on-this-page nav)
- `cmd+k` search with AI-powered "Ask a question" input
- Code blocks with copy buttons
- Organized by concept (Getting Started, Basics, API Reference)
- API reference pages show interactive "Try it" with multi-language code samples

## Architecture

### Current

```text
rewind.rest          -> Astro static site (3 pages: hero, privacy, terms)
docs.rewind.rest     -> Standalone Scalar HTML page (single file, CDN-loaded)
api.rewind.rest      -> Hono API serving /v1/openapi.json
```

### Target

```text
rewind.rest          -> Astro static site (hero, privacy, terms + OG/favicon/sitemap)
docs.rewind.rest     -> Mintlify (guides + API reference in one site)
                          +-- Getting Started / Quick Start
                          +-- Domain overviews (Listening, Running, Watching, Collecting)
                          +-- API Reference (auto-generated from OpenAPI spec)
                          +-- Changelog
api.rewind.rest      -> Hono API serving /v1/openapi.json (with operationIds + examples)
```

## Platform Choice: Mintlify

| Consideration   | Detail                                                                          |
| --------------- | ------------------------------------------------------------------------------- |
| Free tier       | Hobby plan: custom domain, API playground, custom components, LLM optimizations |
| OpenAPI support | Native OpenAPI 3.0+ integration, auto-generates API reference pages with Scalar |
| Content format  | MDX files in a Git repo, synced via GitHub                                      |
| Search          | Built-in cmd+k search                                                           |
| AI features     | "Ask AI" on free tier (LLM optimizations)                                       |
| Custom domain   | Supported on free tier                                                          |
| Hosting         | Fully managed SaaS (no infra to maintain)                                       |
| Migration from  | Replaces `docs-scalar/index.html` (single Scalar HTML file)                     |

## Documents

| File                                     | Purpose                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| [TRACKER.md](TRACKER.md)                 | Master task tracker with phases and discrete tasks        |
| [MINTLIFY-SETUP.md](MINTLIFY-SETUP.md)   | Mintlify setup, configuration, and content structure      |
| [OPENAPI-QUALITY.md](OPENAPI-QUALITY.md) | operationId strategy, response examples, and spec quality |
| [LANDING-SITE.md](LANDING-SITE.md)       | Landing site SEO, meta tags, and content improvements     |

## Phase Summary

| Phase | Focus               | Scope                                                                     |
| ----- | ------------------- | ------------------------------------------------------------------------- |
| 1     | OpenAPI quality     | Add operationId to all 104 endpoints, response examples, servers block    |
| 2     | Mintlify setup      | Initialize Mintlify project, configure OpenAPI integration, custom domain |
| 3     | Content migration   | Getting started guide, domain overviews, changelog                        |
| 4     | Landing site polish | Favicon, OG meta, sitemap, clean up dead links                            |
| 5     | AI readiness        | `llms.txt` endpoint, machine-readable documentation                       |

## Sequencing Notes

- Phase 1 (OpenAPI quality) comes first because Mintlify auto-generates API reference from the spec -- better spec = better docs out of the box
- Phase 2 (Mintlify setup) depends on Phase 1 for operationIds (clean URL anchors) and examples (rich reference pages)
- Phase 3 (content) can start as soon as Mintlify is live with the API reference
- Phase 4 (landing site) is independent and can be done in parallel
- Phase 5 (AI readiness) builds on the completed docs site
