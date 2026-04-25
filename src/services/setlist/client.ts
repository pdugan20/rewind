// setlist.fm REST client. Free API key via setlist.fm/settings/api;
// 2 req/sec, 1440 req/day rate limits.
//
// Date format gotcha: setlist.fm uses **DD-MM-YYYY**, not ISO. Caller
// passes our canonical YYYY-MM-DD; this client converts.
//
// Returns null if API key is missing — concerts then load without
// setlist data, and we can re-run later once a key is wired up.

const BASE = 'https://api.setlist.fm/rest/1.0';

export interface SetlistMatch {
  setlist_id: string;
  setlist_url: string;
  artist_name: string;
  artist_mbid: string | null;
  venue_name: string;
  venue_city: string | null;
  tour_name: string | null;
  event_date: string; // YYYY-MM-DD
}

interface RawSearchResponse {
  type?: string;
  itemsPerPage?: number;
  page?: number;
  total?: number;
  setlist?: RawSetlist[];
}

interface RawSetlist {
  id: string;
  url: string;
  versionId?: string;
  eventDate: string; // DD-MM-YYYY
  artist: {
    mbid?: string;
    name: string;
  };
  venue: {
    name: string;
    city?: { name?: string; country?: { name?: string } };
  };
  tour?: { name: string };
}

/**
 * Search setlist.fm for setlists matching artist+date. Returns the best
 * match (first result), or null if none found / no API key configured.
 */
export async function searchSetlist(
  apiKey: string | undefined,
  opts: { artistName: string; date: string } // date = YYYY-MM-DD
): Promise<SetlistMatch | null> {
  if (!apiKey) {
    return null; // not configured, skip enrichment silently
  }

  const setlistDate = toSetlistDate(opts.date);
  const params = new URLSearchParams({
    artistName: opts.artistName,
    date: setlistDate,
    p: '1',
  });

  const res = await fetch(`${BASE}/search/setlists?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'x-api-key': apiKey,
    },
  });

  if (res.status === 404) return null; // setlist.fm returns 404 for no-match
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`setlist.fm ${res.status}: ${body}`);
  }

  const data = (await res.json()) as RawSearchResponse;
  const first = data.setlist?.[0];
  if (!first) return null;

  return {
    setlist_id: first.id,
    setlist_url: first.url,
    artist_name: first.artist.name,
    artist_mbid: first.artist.mbid ?? null,
    venue_name: first.venue.name,
    venue_city: first.venue.city?.name ?? null,
    tour_name: first.tour?.name ?? null,
    event_date: opts.date,
  };
}

/**
 * Convert YYYY-MM-DD → DD-MM-YYYY. setlist.fm's API requires the
 * latter; passing ISO format silently returns 0 results.
 */
export function toSetlistDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date format: ${iso} (expected YYYY-MM-DD)`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}
