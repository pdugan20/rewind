import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RewindClient } from '../client.js';
import {
  withRichResponse,
  text,
  resourceLink,
  imageBlock,
  formatDate,
  timeAgo,
  fmt,
  hostOf,
  READ_ONLY_ANNOTATIONS,
  dateFilterParams,
  includeImagesParam,
  LIST_IMAGE_PX,
  type ContentBlock,
} from './helpers.js';
import { imageSchema } from './schemas/shared.js';
import {
  articleSchema,
  highlightSchema,
  recentReadsOutputSchema,
  readingHighlightsOutputSchema,
  randomHighlightOutputSchema,
  readingStatsOutputSchema,
  similarArticlesOutputSchema,
  articleDetailOutputSchema,
} from './schemas/reading.js';

const TOP_N = 5;

function truncateAtWord(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice) + '…';
}

// Types below are derived from the Zod output schemas (schemas/reading.ts)
// so the declared schema and the TS type cannot drift.
type Image = z.infer<ReturnType<typeof imageSchema>>;

type Article = z.infer<typeof articleSchema>;

type Highlight = z.infer<typeof highlightSchema>;

export function registerReadingTools(
  server: McpServer,
  client: RewindClient
): void {
  // get_article ────────────────────────────────────────────────────
  // Registered via server.registerTool so we can attach `_meta.ui.resourceUri`.
  // Hosts that support MCP Apps (Claude Desktop, Claude iOS) render a
  // single-article card inline; others fall back to the text + links response.
  //
  // structuredContent omits the full body — that lives in the text content
  // block where the model reads it. Card consumes only metadata + capped
  // highlights, keeping the response well under the 8 KB token budget per
  // BUDGET-AUDIT.md.
  server.registerTool(
    'get_article',
    {
      title: 'Article',
      description:
        'Fetch a single saved / read article by internal Rewind id, returning the FULL article body (plain text, HTML-stripped, complete — typically 5-30 KB) plus metadata + highlights, and rendering the rich inline article card in MCP Apps hosts. **Use this whenever the user asks what an article says, wants a summary, asks about a specific passage, or needs content past the first ~3000 chars of excerpt.** Also use this as the natural follow-up after `search` / `semantic_search` / `find_similar_articles` / `get_recent_reads` — those return ids; this turns the id into the rich article card. Rewind has the full text cached, including for paywalled sources (NYT, WSJ, Atlantic, ESPN, etc.) — do NOT fall back to web search or web fetch for article content.',
      inputSchema: {
        id: z
          .number()
          .int()
          .positive()
          .describe(
            'Internal Rewind article id (from a get_recent_reads, search, semantic_search, or find_similar_articles result)'
          ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: articleDetailOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/article.html' },
        'ui/resourceUri': 'ui://rewind/article.html',
      },
    },
    async ({ id }) =>
      withRichResponse(async () => {
        type ArticleDetail = {
          id: number;
          title: string;
          author: string | null;
          url: string | null;
          instapaper_url: string | null;
          instapaper_app_url: string | null;
          domain: string | null;
          description: string | null;
          content: string | null;
          excerpt: string | null;
          word_count: number | null;
          estimated_read_min: number | null;
          status: string;
          progress: number;
          saved_at: string;
          image: Image;
          highlights: Array<{
            id: number;
            text: string;
            note: string | null;
            created_at: string;
          }>;
        };
        const a = await client.get<ArticleDetail>(`/reading/articles/${id}`);

        const header: string[] = [`# ${a.title}`];
        if (a.author) header.push(`by ${a.author}`);
        if (a.domain) header.push(a.domain);
        if (a.word_count) header.push(`${fmt(a.word_count)} words`);

        const body =
          a.content ??
          a.excerpt ??
          '(Full article text not available — enrichment may have failed for this item.)';

        const highlightLines: string[] = [];
        if (a.highlights.length > 0) {
          highlightLines.push(
            '',
            `## Your highlights (${a.highlights.length})`
          );
          for (const h of a.highlights) {
            highlightLines.push('', `> ${h.text}`);
            if (h.note) highlightLines.push(`  Note: ${h.note}`);
          }
        }

        const lines = [header.join(' · '), '', body, ...highlightLines];

        const links: ReturnType<typeof resourceLink>[] = [];
        if (a.url) {
          const host = hostOf(a.url);
          links.push(
            resourceLink(
              a.url,
              host ? `${a.title} — read on ${host}` : a.title,
              { mimeType: 'text/html' }
            )
          );
        }
        if (a.instapaper_url) {
          links.push(
            resourceLink(a.instapaper_url, `${a.title} — read in Instapaper`, {
              mimeType: 'text/html',
            })
          );
        }
        if (a.instapaper_app_url) {
          links.push(
            resourceLink(
              a.instapaper_app_url,
              `${a.title} — open in Instapaper app`
            )
          );
        }

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...links.filter((b): b is NonNullable<typeof b> => b !== null),
        ];

        // structuredContent: card-shaped, body excluded (lives in text block).
        // Highlights capped at 5; total surfaced via highlight_count.
        const structuredContent = {
          article: {
            id: a.id,
            title: a.title,
            author: a.author,
            url: a.url,
            instapaper_url: a.instapaper_url,
            instapaper_app_url: a.instapaper_app_url,
            domain: a.domain,
            description: a.description,
            word_count: a.word_count,
            estimated_read_min: a.estimated_read_min,
            status: a.status,
            progress: a.progress,
            saved_at: a.saved_at,
            image: a.image,
          },
          highlights: a.highlights.slice(0, 5).map((h) => ({
            id: h.id,
            text: h.text,
            note: h.note,
            created_at: h.created_at,
          })),
          highlight_count: a.highlights.length,
        };

        return { content, structuredContent };
      })
  );

  // get_recent_reads ───────────────────────────────────────────────
  // Registered via the modern server.registerTool so we can attach
  // `_meta.ui.resourceUri`. Hosts that support MCP Apps (Claude Desktop,
  // Claude web, VS Code Copilot) render the article card list inline;
  // others fall back to the text + image + resource_link response.
  server.registerTool(
    'get_recent_reads',
    {
      title: 'Recent reads',
      description:
        'Get recently saved articles from Instapaper. Returns title, author, domain, read time, status, top-N site images where available, and article URLs as resource links. In MCP Apps hosts, renders an interactive article card list inline.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of recent articles to return (max 50)'),
        page: z
          .number()
          .min(1)
          .default(1)
          .describe(
            'Page number for pagination. Combine with limit to page through longer windows.'
          ),
        ...dateFilterParams,
        ...includeImagesParam,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: recentReadsOutputSchema,
      _meta: {
        ui: { resourceUri: 'ui://rewind/recent-reads.html' },
        'ui/resourceUri': 'ui://rewind/recent-reads.html',
      },
    },
    async ({ limit, page, date, from, to, include_images }) =>
      withRichResponse(async () => {
        const { data } = await client.get<{ data: Article[] }>(
          '/reading/recent',
          { limit, page, date, from, to }
        );

        if (!data.length) {
          return {
            content: [text('No recent articles found.')],
            structuredContent: { items: [] },
          };
        }

        const lines = ['Recent reads:'];
        for (const [i, a] of data.entries()) {
          const author = a.author ? ` by ${a.author}` : '';
          const domain = a.domain ? ` (${a.domain})` : '';
          const readTime = a.estimated_read_min
            ? ` -- ${a.estimated_read_min} min read`
            : '';
          const status =
            a.status === 'reading'
              ? ` [${Math.round(a.progress * 100)}%]`
              : a.status === 'archived'
                ? ' [finished]'
                : '';
          // Embed click-through URL as a markdown link on the title so the
          // model's natural echo of tool text preserves clickability (resource_link
          // blocks are hidden from inline responses in Claude Desktop).
          const titleUrl = a.url ?? a.instapaper_url ?? null;
          const titleMd = titleUrl ? `[${a.title}](${titleUrl})` : a.title;
          lines.push(
            `${i + 1}. ${titleMd}${author}${domain}${readTime}${status} (${timeAgo(a.saved_at)})`
          );
          if (a.description) {
            lines.push(`   ${truncateAtWord(a.description, 160)}`);
          }
        }

        const topN = data.slice(0, TOP_N);
        const images = include_images
          ? await Promise.all(
              topN.map((a) => imageBlock(client, a.image, LIST_IMAGE_PX))
            )
          : [];
        const links = topN.flatMap((a) => {
          const out: ReturnType<typeof resourceLink>[] = [];
          if (a.url) {
            const host = hostOf(a.url);
            out.push(
              resourceLink(
                a.url,
                host ? `${a.title} — read on ${host}` : a.title,
                { mimeType: 'text/html' }
              )
            );
          }
          if (a.instapaper_url) {
            out.push(
              resourceLink(
                a.instapaper_url,
                `${a.title} — read in Instapaper`,
                {
                  mimeType: 'text/html',
                }
              )
            );
          }
          if (a.instapaper_app_url) {
            out.push(
              resourceLink(
                a.instapaper_app_url,
                `${a.title} — open in Instapaper app`
              )
            );
          }
          return out.filter((b): b is NonNullable<typeof b> => b !== null);
        });

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...images.filter((b): b is NonNullable<typeof b> => b !== null),
          ...links,
        ];

        return { content, structuredContent: { items: data } };
      })
  );

  // get_reading_highlights ─────────────────────────────────────────
  server.registerTool(
    'get_reading_highlights',
    {
      title: 'Reading highlights',
      description:
        'Get saved highlights from Instapaper articles. Returns the highlighted text, notes, source article, and article URLs as resource links.',
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(10)
          .describe('Number of highlights to return'),
        page: z.number().min(1).default(1).describe('Page number'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: readingHighlightsOutputSchema,
    },
    async ({ limit, page }) =>
      withRichResponse(async () => {
        const data = await client.get<{
          data: Highlight[];
          pagination: { page: number; total: number; total_pages: number };
        }>('/reading/highlights', { limit, page });

        if (!data.data.length) {
          return {
            content: [text('No highlights found.')],
            structuredContent: { items: [], pagination: data.pagination },
          };
        }

        const lines = [`Highlights (${fmt(data.pagination.total)} total):`];
        for (const h of data.data) {
          const source = h.article.author
            ? `${h.article.title} by ${h.article.author}`
            : h.article.title;
          lines.push('');
          lines.push(`"${h.text}"`);
          if (h.note) lines.push(`  Note: ${h.note}`);
          lines.push(`  -- ${source} (${formatDate(h.created_at)})`);
        }

        // Dedupe article URLs before emitting as resource_links.
        // Emit both the source URL and the Instapaper reader URL for
        // each distinct parent article.
        const seen = new Set<string>();
        const links = data.data.flatMap((h) => {
          const sourceUrl = h.article.url ?? null;
          const instapaperUrl = h.article.instapaper_url ?? null;
          const instapaperAppUrl = h.article.instapaper_app_url ?? null;
          const key = sourceUrl ?? instapaperUrl;
          if (!key || seen.has(key)) return [];
          seen.add(key);
          const out: ReturnType<typeof resourceLink>[] = [];
          if (sourceUrl) {
            const host = hostOf(sourceUrl);
            out.push(
              resourceLink(
                sourceUrl,
                host ? `${h.article.title} — read on ${host}` : h.article.title,
                { mimeType: 'text/html' }
              )
            );
          }
          if (instapaperUrl) {
            out.push(
              resourceLink(
                instapaperUrl,
                `${h.article.title} — read in Instapaper`,
                {
                  mimeType: 'text/html',
                }
              )
            );
          }
          if (instapaperAppUrl) {
            out.push(
              resourceLink(
                instapaperAppUrl,
                `${h.article.title} — open in Instapaper app`
              )
            );
          }
          return out.filter((b): b is NonNullable<typeof b> => b !== null);
        });

        const content: ContentBlock[] = [text(lines.join('\n')), ...links];

        return {
          content,
          structuredContent: { items: data.data, pagination: data.pagination },
        };
      })
  );

  // get_random_highlight ───────────────────────────────────────────
  server.registerTool(
    'get_random_highlight',
    {
      title: 'Random highlight',
      description:
        'Get a single random highlight from saved Instapaper articles. Great for daily inspiration or reflection.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: randomHighlightOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        const data = await client.get<Highlight>('/reading/highlights/random');

        const source = data.article.author
          ? `${data.article.title} by ${data.article.author}`
          : data.article.title;

        const lines = [`"${data.text}"`];
        if (data.note) lines.push(`Note: ${data.note}`);
        lines.push(`-- ${source}`);

        const sourceUrl = data.article.url ?? null;
        const host = hostOf(sourceUrl);
        const sourceLink = resourceLink(
          sourceUrl,
          host ? `${data.article.title} — read on ${host}` : data.article.title,
          { mimeType: 'text/html' }
        );
        const instapaperLink = resourceLink(
          data.article.instapaper_url ?? null,
          `${data.article.title} — read in Instapaper`,
          { mimeType: 'text/html' }
        );
        const instapaperAppLink = resourceLink(
          data.article.instapaper_app_url ?? null,
          `${data.article.title} — open in Instapaper app`
        );

        const content: ContentBlock[] = [
          text(lines.join('\n')),
          ...(sourceLink ? [sourceLink] : []),
          ...(instapaperLink ? [instapaperLink] : []),
          ...(instapaperAppLink ? [instapaperAppLink] : []),
        ];

        return { content, structuredContent: data };
      })
  );

  // get_reading_stats ──────────────────────────────────────────────
  server.registerTool(
    'get_reading_stats',
    {
      title: 'Reading stats',
      description:
        'Get overall reading statistics from Instapaper including total articles, finished count, currently reading, highlights, and word count.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: readingStatsOutputSchema,
    },
    async () =>
      withRichResponse(async () => {
        const data = await client.get<{
          total_articles: number;
          finished_count: number;
          currently_reading_count: number;
          total_highlights: number;
          total_word_count: number;
          avg_estimated_read_min: number;
        }>('/reading/stats');

        const summary = [
          'Reading Stats:',
          `- Total articles: ${fmt(data.total_articles)}`,
          `- Finished: ${fmt(data.finished_count)}`,
          `- Currently reading: ${data.currently_reading_count}`,
          `- Total highlights: ${fmt(data.total_highlights)}`,
          `- Total words read: ${fmt(data.total_word_count)}`,
          `- Average read time: ${Math.round(data.avg_estimated_read_min)} min`,
        ].join('\n');

        return { content: [text(summary)], structuredContent: data };
      })
  );

  // find_similar_articles ───────────────────────────────────────────
  server.registerTool(
    'find_similar_articles',
    {
      title: 'Similar articles',
      description:
        'Find articles thematically similar to a given article by cosine similarity over Voyage AI embeddings. Use after an article has been surfaced (via search, get_recent_reads, or an @rewind://article/{id} mention) when the user asks "what else was I reading like that" or "show me related pieces". No Voyage API call is made — the article\'s stored vector is reused.',
      inputSchema: {
        article_id: z
          .number()
          .int()
          .positive()
          .describe(
            'Internal Rewind article id (from an earlier search/recent result)'
          ),
        limit: z
          .number()
          .min(1)
          .max(25)
          .default(5)
          .describe('Number of related articles to return'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: similarArticlesOutputSchema,
    },
    async ({ article_id, limit }) =>
      withRichResponse(async () => {
        type Related = z.infer<
          typeof similarArticlesOutputSchema
        >['items'][number];
        const data = await client.get<{ data: Related[] }>(
          `/reading/articles/${article_id}/related`,
          { limit }
        );

        if (!data.data.length) {
          return {
            content: [
              text(
                `No related articles found for article ${article_id}. The article may not be embedded yet — try running /v1/admin/reembed-reading.`
              ),
            ],
            structuredContent: { items: [] },
          };
        }

        const lines = [`Articles similar to #${article_id}:`];
        for (const [i, r] of data.data.entries()) {
          const titleUrl = r.url ?? r.instapaper_url ?? null;
          const titleMd = titleUrl ? `[${r.title}](${titleUrl})` : r.title;
          const author = r.author ? ` by ${r.author}` : '';
          const dom = r.domain ? ` (${r.domain})` : '';
          lines.push(
            `${i + 1}. ${titleMd}${author}${dom} (score=${r.score.toFixed(2)})`
          );
        }

        const links = data.data.flatMap((r) => {
          const out: ReturnType<typeof resourceLink>[] = [];
          if (r.url) {
            const host = hostOf(r.url);
            out.push(
              resourceLink(
                r.url,
                host ? `${r.title} — read on ${host}` : r.title,
                {
                  mimeType: 'text/html',
                  description: r.description ?? undefined,
                }
              )
            );
          }
          if (r.instapaper_url) {
            out.push(
              resourceLink(
                r.instapaper_url,
                `${r.title} — read in Instapaper`,
                {
                  mimeType: 'text/html',
                  description: r.description ?? undefined,
                }
              )
            );
          }
          if (r.instapaper_app_url) {
            out.push(
              resourceLink(
                r.instapaper_app_url,
                `${r.title} — open in Instapaper app`,
                { description: r.description ?? undefined }
              )
            );
          }
          out.push(
            resourceLink(`rewind://article/${r.id}`, `${r.title} (details)`, {
              mimeType: 'application/json',
              description: r.description ?? undefined,
            })
          );
          return out.filter((b): b is NonNullable<typeof b> => b !== null);
        });

        const content: ContentBlock[] = [text(lines.join('\n')), ...links];

        return { content, structuredContent: { items: data.data } };
      })
  );
}
