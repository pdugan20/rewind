# Mintlify Setup

Technical reference for migrating from standalone Scalar HTML to Mintlify hosted docs.

## Current State

`docs-scalar/index.html` is a single HTML file that loads Scalar from CDN and points it at the live OpenAPI spec. Deployed to Cloudflare Pages project `rewind-docs` at `docs.rewind.rest`.

## Platform Overview

Mintlify is a hosted docs-as-code platform. Content lives in a Git repo as MDX files, Mintlify auto-deploys on push via a GitHub App. API reference pages are auto-generated from the OpenAPI spec. The free Hobby tier includes custom domains, API playground, and LLM optimizations.

Key differences from current Scalar setup:

| Feature                | Current (Scalar HTML)                    | Target (Mintlify)                |
| ---------------------- | ---------------------------------------- | -------------------------------- |
| Prose content (guides) | None                                     | MDX pages in Git repo            |
| API reference          | Scalar widget, single HTML file          | Auto-generated from OpenAPI spec |
| Search                 | None                                     | Built-in cmd+k                   |
| AI features            | None                                     | "Ask AI" on every page           |
| Sidebar navigation     | Auto from OpenAPI tags only              | Custom: guides + API reference   |
| Deployment             | Manual `npm run docs:deploy` to CF Pages | Auto-deploy on Git push          |
| Custom domain          | Cloudflare Pages CNAME                   | Mintlify CNAME                   |

## Initial Setup Steps

1. Sign up at [mintlify.com/start](https://mintlify.com/start) (Hobby plan, free)
2. Connect GitHub account, select the `pdugan20/rewind` repo
3. Install the Mintlify GitHub App for auto-deployments
4. Site deploys to a `.mintlify.app` URL initially

### Local Development

```bash
npm i -g mint
# Clone repo, then:
mint dev
# Preview at http://localhost:3000
```

## docs.json Configuration

Mintlify uses `docs.json` (previously `mint.json`) as the central config file. Required fields: `theme`, `name`, `colors.primary`, `navigation`.

```json
{
  "$schema": "https://mintlify.com/schema.json",
  "theme": "maple",
  "name": "Rewind",
  "description": "Personal data aggregation API. Syncs and serves data from the services that track your life.",
  "logo": {
    "dark": "/logo/dark.svg",
    "light": "/logo/light.svg"
  },
  "favicon": "/favicon.svg",
  "appearance": {
    "default": "dark",
    "strict": false
  },
  "colors": {
    "primary": "#e5e5e5",
    "light": "#e5e5e5",
    "dark": "#0a0a0a"
  },
  "background": {
    "color": {
      "dark": "#0a0a0a",
      "light": "#ffffff"
    }
  },
  "navbar": {
    "links": [
      {
        "type": "github",
        "href": "https://github.com/pdugan20/rewind"
      }
    ],
    "primary": {
      "type": "button",
      "label": "API Status",
      "href": "https://api.rewind.rest/v1/health"
    }
  },
  "footer": {
    "socials": {
      "github": "https://github.com/pdugan20/rewind"
    }
  },
  "navigation": {
    "tabs": [
      {
        "tab": "Guides",
        "groups": [
          {
            "group": "Getting Started",
            "pages": ["introduction", "quickstart", "authentication"]
          },
          {
            "group": "Domains",
            "pages": [
              "domains/listening",
              "domains/running",
              "domains/watching",
              "domains/collecting",
              "domains/images"
            ]
          }
        ]
      },
      {
        "tab": "API Reference",
        "openapi": "https://api.rewind.rest/v1/openapi.json",
        "groups": [
          { "group": "Listening" },
          { "group": "Running" },
          { "group": "Watching" },
          { "group": "Collecting" },
          { "group": "Feed" },
          { "group": "Search" },
          { "group": "Images" },
          { "group": "System" }
        ]
      }
    ]
  },
  "api": {
    "playground": {
      "display": "interactive"
    },
    "examples": {
      "languages": ["bash", "javascript", "python"],
      "prefill": true
    }
  },
  "search": {
    "prompt": "Search docs..."
  }
}
```

### Theme Options

Available themes: `mint`, `maple`, `palm`, `willow`, `linden`, `almond`, `aspen`, `sequoia`, `luma`. The `maple` theme is closest to SF Compute's clean layout. Evaluate during setup.

### OpenAPI Integration

The `openapi` field on a navigation tab points to the live spec URL. Mintlify auto-generates API reference pages from it. Requirements:

- OpenAPI 3.0 or 3.1 (we use 3.1)
- `servers` block in the spec (for API playground base URL)
- `operationId` on every endpoint (for clean URL anchors and page titles)
- Only internal `$ref` supported (no external references)

Auto-generated pages use:

- `summary` field as page title
- `description` field as page description
- Parameters, request body, and responses auto-rendered
- Code samples auto-generated in configured languages

Use `x-mint` extension in the OpenAPI spec for per-endpoint customization:

```json
{
  "x-mint": {
    "metadata": { "title": "Custom title" },
    "content": "## Additional context\n\nExtra markdown here."
  }
}
```

Use `x-hidden: true` to exclude endpoints from docs (e.g., internal admin endpoints).

## Custom Domain Setup (Cloudflare)

1. In Mintlify dashboard: Settings > Custom Domain > enter `docs.rewind.rest` > Add domain
2. In Cloudflare DNS: update CNAME record for `docs` to point to `cname.vercel-dns.com`
3. In Cloudflare SSL/TLS settings:
   - Set encryption mode to **Full (strict)**
   - **Disable** "Always Use HTTPS" in Edge Certificates (required for Let's Encrypt validation)
4. Wait for DNS propagation (1-24 hours)
5. Verify site loads at `docs.rewind.rest`

### Decommission Old Setup

After Mintlify is live:

- Delete `rewind-docs` Cloudflare Pages project
- Remove `docs-scalar/` directory from repo
- Remove `docs:deploy` script from `package.json`

## Content Structure

```text
docs-mintlify/                 # New directory in repo (or root, TBD)
  docs.json                    # Mintlify configuration
  introduction.mdx             # Welcome page
  quickstart.mdx               # Getting started guide
  authentication.mdx           # Auth guide (read keys vs admin keys)
  domains/
    listening.mdx              # Listening domain overview
    running.mdx                # Running domain overview
    watching.mdx               # Watching domain overview
    collecting.mdx             # Collecting domain overview
    images.mdx                 # Image pipeline overview
  changelog.mdx                # Changelog
  logo/
    dark.svg                   # Logo for dark mode
    light.svg                  # Logo for light mode
  favicon.svg                  # Favicon
```

API reference pages are NOT in the repo -- they're auto-generated from the OpenAPI spec at build time.

## Content Strategy

### Write Fresh

- **introduction.mdx**: What Rewind is, what data it aggregates, quick links
- **quickstart.mdx**: 5 minutes from zero to first API call (get key, curl, pagination)
- **authentication.mdx**: Read vs admin keys, Bearer token, rate limiting
- **changelog.mdx**: Recent significant API changes

### Adapt from Existing `/docs/`

| Internal doc                 | Mintlify page            | What to keep                                                                   |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `docs/domains/listening.md`  | `domains/listening.mdx`  | Overview, data sources, key patterns. Remove TS interfaces (API ref has them). |
| `docs/domains/running.md`    | `domains/running.mdx`    | Overview, stats/charts explanation, date filtering patterns                    |
| `docs/domains/watching.md`   | `domains/watching.mdx`   | Overview, multi-source (Plex + Letterboxd), ratings/reviews                    |
| `docs/domains/collecting.md` | `domains/collecting.mdx` | Overview, Discogs + Trakt, cross-reference                                     |
| `docs/domains/images.md`     | `domains/images.mdx`     | CDN URL format, presets, thumbhash, color extraction                           |

### Do NOT Migrate

- `docs/ARCHITECTURE.md` -- internal system design
- `docs/projects/` -- internal project tracking
- TypeScript interfaces -- redundant with auto-generated API reference
