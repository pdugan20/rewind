# Scalar Setup and Cloudflare Pages Deployment

Configuration details for the docs site.

## Scalar Options

There are two ways to deploy Scalar:

### Option A: Static HTML Page (Recommended for Start)

A single `index.html` that loads Scalar from CDN and points to the live spec. Zero build step, zero dependencies.

```html
<!doctype html>
<html>
  <head>
    <title>Rewind API Docs</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script
      id="api-reference"
      data-url="https://api.rewind.rest/v1/openapi.json"
      data-configuration='{
        "theme": "kepler",
        "layout": "modern",
        "hideModels": false,
        "hideDownloadButton": false,
        "authentication": {
          "preferredSecurityScheme": "bearerAuth"
        }
      }'
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
```

**Pros**: Simplest possible setup, no build step, updates instantly when the spec changes.

**Cons**: No custom pages beyond the API reference, limited branding.

### Option B: Scalar with Astro/Vite (Future)

If you later want guides, tutorials, or a changelog alongside the API reference, wrap Scalar in a static site generator. Not needed for launch.

## Cloudflare Pages Setup

### Initial Setup

```bash
# Create the docs site directory
mkdir docs-site
# Add the index.html from Option A

# Create a Cloudflare Pages project via dashboard or CLI:
npx wrangler pages project create rewind-docs

# Deploy
npx wrangler pages deploy docs-site --project-name rewind-docs
```

### Custom Domain

1. In Cloudflare dashboard > Pages > rewind-docs > Custom domains
2. Add `docs.rewind.rest`
3. Cloudflare automatically provisions SSL and creates the CNAME record (since the domain is already on Cloudflare)

### Auto-Deploy

Configure Cloudflare Pages to deploy from the `main` branch:

- Build command: (none -- static files)
- Build output directory: `docs-site/`
- Root directory: `/` (project root)

Any push to `main` that changes `docs-site/` will trigger a redeploy.

## Scalar Configuration Options

### Theme

Scalar ships several themes. `kepler` is clean and modern. Other options: `default`, `moon`, `purple`, `saturn`, `bluePlanet`, `deepSpace`, `alternate`, `solarized`.

Preview themes before choosing by visiting the Scalar docs.

### Authentication

The spec should define a security scheme:

```json
{
  "components": {
    "securitySchemes": {
      "bearerAuth": {
        "type": "http",
        "scheme": "bearer",
        "description": "API key (rw_live_... for read access, rw_admin_... for full access)"
      }
    }
  },
  "security": [{ "bearerAuth": [] }]
}
```

Scalar will render an authentication panel where users can enter their API key to test endpoints directly.

### Custom CSS

If you want to adjust colors to match Rewind branding:

```html
<style>
  .scalar-app {
    --scalar-color-1: #your-primary;
    --scalar-color-accent: #your-accent;
  }
</style>
```

## CORS Considerations

The Scalar "Try It" feature makes requests from the browser directly to `api.rewind.rest`. The API must allow `docs.rewind.rest` as a CORS origin.

Add `docs.rewind.rest` to the `ALLOWED_ORIGINS` env var in `wrangler.toml` or Cloudflare dashboard.

## Package.json Scripts

Add these to `package.json`:

```json
{
  "scripts": {
    "docs:dev": "npx serve docs-site",
    "docs:deploy": "npx wrangler pages deploy docs-site --project-name rewind-docs"
  }
}
```

## Directory Structure

```text
docs-site/
  index.html          -- Scalar single-page app
  favicon.ico         -- (optional) Rewind favicon
```
