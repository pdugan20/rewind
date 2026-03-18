# Landing Site Improvements

Technical reference for upgrading `rewind.rest` (Astro landing site).

## Current State

3-page Astro static site:

- `/` -- hero with marquee, links to docs and API status
- `/privacy/` -- privacy policy (MDX)
- `/terms/` -- terms of service (MDX)

Missing: favicon, OG meta, Twitter cards, sitemap, robots meta.

## Meta Tags

Add to `docs-site/src/layouts/Base.astro` `<head>`:

```html
<!-- Favicon -->
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />

<!-- SEO -->
<meta name="robots" content="index, follow" />
<link rel="canonical" href={`https://rewind.rest${Astro.url.pathname}`} />

<!-- Open Graph -->
<meta property="og:type" content="website" />
<meta property="og:title" content={title} />
<meta property="og:description" content={description} />
<meta property="og:url" content={`https://rewind.rest${Astro.url.pathname}`} />
<meta property="og:image" content="https://rewind.rest/og-image.png" />

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content={title} />
<meta name="twitter:description" content={description} />
<meta name="twitter:image" content="https://rewind.rest/og-image.png" />
```

## Favicon

Options:

- Simple text-based SVG favicon (e.g., "R" in the landing site's font)
- Minimal icon matching the site's dark aesthetic
- Needs: `.svg` (modern browsers), `.ico` (legacy), `.png` at 180x180 (Apple touch icon)

Place in `docs-site/public/` directory.

## OG Image

- Dimensions: 1200x630px
- Dark background (#0a0a0a) with "Rewind" title and tagline
- Can be generated with a simple HTML-to-image tool or designed manually
- Place at `docs-site/public/og-image.png`

## Sitemap

Install and configure `@astrojs/sitemap`:

```bash
cd docs-site && npm install @astrojs/sitemap
```

Update `docs-site/astro.config.mjs`:

```javascript
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://rewind.rest',
  integrations: [mdx(), sitemap()],
  output: 'static',
});
```

## Footer Link Audit

Current footer links in `Base.astro`:

- Home (`/`) -- OK
- Docs (`https://docs.rewind.rest`) -- OK
- Terms (`/terms/`) -- OK
- Privacy (`/privacy/`) -- OK
- GitHub (`https://github.com/pdugan20/rewind`) -- may be private, verify or remove
