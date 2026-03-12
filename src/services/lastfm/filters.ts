import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { lastfmFilters } from '../../db/schema/lastfm.js';

export interface FilterableItem {
  artistName: string;
  albumName?: string;
  trackName?: string;
}

interface FilterRule {
  filterType: string;
  pattern: string;
  scope: string | null;
}

/**
 * In-memory filter cache loaded from DB at sync start.
 * Avoids per-item DB queries during bulk operations.
 */
let cachedFilters: FilterRule[] | null = null;

/**
 * Load filter rules from DB into memory.
 * Call once at the start of a sync run.
 */
export async function loadFilters(db: Database): Promise<void> {
  const rows = await db
    .select({
      filterType: lastfmFilters.filterType,
      pattern: lastfmFilters.pattern,
      scope: lastfmFilters.scope,
    })
    .from(lastfmFilters)
    .where(eq(lastfmFilters.userId, 1));

  cachedFilters = rows;
}

/**
 * Clear the in-memory filter cache.
 */
export function clearFilterCache(): void {
  cachedFilters = null;
}

/**
 * Seed the in-memory filter cache directly (for testing).
 */
export function seedFilterCache(filters: FilterRule[]): void {
  cachedFilters = filters;
}

function getFilters(): FilterRule[] {
  if (!cachedFilters) {
    throw new Error(
      'Filters not loaded. Call loadFilters(db) before using isFiltered().'
    );
  }
  return cachedFilters;
}

export function isHolidayMusic(item: FilterableItem): boolean {
  const albumLower = (item.albumName ?? '').toLowerCase();
  const trackLower = (item.trackName ?? '').toLowerCase();
  const artistLower = item.artistName.toLowerCase();

  for (const rule of getFilters()) {
    if (rule.filterType !== 'holiday') continue;

    if (rule.scope === 'album' && albumLower.includes(rule.pattern)) {
      return true;
    }
    if (rule.scope === 'track' && trackLower.includes(rule.pattern)) {
      return true;
    }
    if (rule.scope === 'artist_track') {
      const [artist, track] = rule.pattern.split('||');
      if (artistLower.includes(artist) && trackLower === track) {
        return true;
      }
    }
  }

  return false;
}

export function isAudiobook(item: FilterableItem): boolean {
  const artistLower = item.artistName.toLowerCase();
  const trackLower = (item.trackName ?? '').toLowerCase();
  const trackName = item.trackName ?? '';

  for (const rule of getFilters()) {
    if (rule.filterType !== 'audiobook') continue;

    if (rule.scope === 'artist' && artistLower === rule.pattern) {
      return true;
    }
    if (rule.scope === 'track' && trackLower.includes(rule.pattern)) {
      return true;
    }
    if (rule.scope === 'track_regex') {
      try {
        const regex = new RegExp(rule.pattern, 'i');
        if (regex.test(trackName)) return true;
      } catch {
        // Invalid regex pattern, skip
      }
    }
  }

  return false;
}

export function isFiltered(item: FilterableItem): boolean {
  return isHolidayMusic(item) || isAudiobook(item);
}

/**
 * Over-fetch, filter, and re-rank strategy for top lists.
 * Takes the raw (over-fetched) list, filters out matched items,
 * re-ranks the remaining, and returns the desired count.
 */
export function filterAndRerank<T extends FilterableItem>(
  items: T[],
  limit: number
): T[] {
  const filtered = items.filter((item) => !isFiltered(item));
  return filtered.slice(0, limit);
}
