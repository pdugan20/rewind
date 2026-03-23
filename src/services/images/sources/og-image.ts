/**
 * OG Image source client.
 * Extracts og:image meta tags from article URLs for thumbnail images.
 * Used as the primary image source for the reading domain.
 */

import type { ImageResult, SourceClient, SourceSearchParams } from './types.js';

export class OgImageClient implements SourceClient {
  name = 'og-image';

  async search(params: SourceSearchParams): Promise<ImageResult[]> {
    if (params.domain !== 'reading') {
      return [];
    }

    const articleUrl = params.articleUrl;
    if (!articleUrl) {
      console.log(
        `[INFO] OG image search skipped: no article URL for ${params.entityId}`
      );
      return [];
    }

    try {
      const response = await fetch(articleUrl, {
        headers: {
          'User-Agent': 'RewindAPI/1.0',
          Accept: 'text/html',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        console.log(
          `[ERROR] Failed to fetch article page ${articleUrl}: ${response.status}`
        );
        return [];
      }

      const html = await response.text();
      const ogImageUrl = extractOgImage(html, articleUrl);

      if (!ogImageUrl) {
        return [];
      }

      return [
        {
          source: this.name,
          url: ogImageUrl,
          width: null,
          height: null,
        },
      ];
    } catch (error) {
      console.log(
        `[ERROR] OG image extraction failed for ${articleUrl}: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }
}

/**
 * Extract og:image URL from HTML head.
 * Parses meta tags without a full DOM parser -- only scans the <head> section.
 */
function extractOgImage(html: string, baseUrl: string): string | null {
  // Limit parsing to <head> for performance
  const headEnd = html.indexOf('</head>');
  const head = headEnd > -1 ? html.slice(0, headEnd) : html.slice(0, 10000);

  // Match og:image meta tags (both property and name attributes, single and double quotes)
  const patterns = [
    /<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+(?:property|name)\s*=\s*["']og:image["']/i,
  ];

  for (const pattern of patterns) {
    const match = head.match(pattern);
    if (match?.[1]) {
      const imageUrl = match[1].trim();

      // Resolve relative URLs
      if (imageUrl.startsWith('//')) {
        return `https:${imageUrl}`;
      }
      if (imageUrl.startsWith('/')) {
        try {
          const base = new URL(baseUrl);
          return `${base.origin}${imageUrl}`;
        } catch {
          return null;
        }
      }
      if (imageUrl.startsWith('http')) {
        return imageUrl;
      }

      return null;
    }
  }

  return null;
}
