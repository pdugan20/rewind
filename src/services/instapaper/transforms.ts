/**
 * Transform Instapaper API responses into reading_items rows.
 */

import type { InstapaperBookmark } from './client.js';

const FINISHED_THRESHOLD = 0.75;
const WORDS_PER_MINUTE = 238;

export interface ReadingItemInsert {
  itemType: 'article';
  source: 'instapaper';
  sourceId: string;
  url: string | null;
  title: string;
  description: string | null;
  domain: string | null;
  status: 'unread' | 'reading' | 'finished' | 'skipped' | 'abandoned';
  progress: number;
  progressUpdatedAt: string | null;
  starred: number;
  folder: string;
  tags: string | null;
  savedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Derive reading status from Instapaper folder and progress.
 */
export function deriveStatus(
  folder: string,
  progress: number
): 'unread' | 'reading' | 'finished' | 'skipped' | 'abandoned' {
  if (progress >= FINISHED_THRESHOLD) return 'finished';
  if (folder === 'archive' && progress === 0) return 'skipped';
  if (folder === 'archive' && progress > 0) return 'abandoned';
  if (progress > 0) return 'reading';
  return 'unread';
}

/**
 * Extract domain from a URL (e.g., "wired.com" from "https://www.wired.com/story/...").
 */
export function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Count words in HTML content and compute estimated read time.
 */
export function computeWordCount(html: string): {
  wordCount: number;
  estimatedReadMin: number;
} {
  // Strip HTML tags
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const wordCount = text ? text.split(' ').length : 0;
  const estimatedReadMin = Math.ceil(wordCount / WORDS_PER_MINUTE);
  return { wordCount, estimatedReadMin };
}

/**
 * Transform an Instapaper bookmark into a reading_items insert.
 */
export function transformBookmark(
  bookmark: InstapaperBookmark,
  folder: string
): ReadingItemInsert {
  const savedAt = new Date(bookmark.time * 1000).toISOString();
  const progressUpdatedAt =
    bookmark.progress_timestamp > 0
      ? new Date(bookmark.progress_timestamp * 1000).toISOString()
      : null;

  const status = deriveStatus(folder, bookmark.progress);

  return {
    itemType: 'article',
    source: 'instapaper',
    sourceId: String(bookmark.bookmark_id),
    url: bookmark.url || null,
    title: bookmark.title || 'Untitled',
    description: bookmark.description || null,
    domain: extractDomain(bookmark.url),
    status,
    progress: bookmark.progress,
    progressUpdatedAt,
    starred: bookmark.starred === '1' ? 1 : 0,
    folder,
    tags:
      bookmark.tags && bookmark.tags.length > 0
        ? JSON.stringify(bookmark.tags.map((t) => t.name))
        : null,
    savedAt,
    startedAt: bookmark.progress > 0 ? progressUpdatedAt : null,
    finishedAt: status === 'finished' ? (progressUpdatedAt ?? savedAt) : null,
  };
}
