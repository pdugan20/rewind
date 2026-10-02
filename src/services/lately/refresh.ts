import type { Env } from '../../types/env.js';
import { z } from 'zod';
import { loadFilters } from '../lastfm/filters.js';
import {
  latestMovie,
  latestMusic,
  latelyDb,
  musicCard,
  storedMusic,
} from './candidates.js';
import {
  ARTWORK_WAIT_MS,
  LATELY_OWNER_ID,
  LEASE_MS,
  movieExclusions,
  policyKey,
} from './policy.js';
import {
  LatelySnapshot,
  type MusicCard,
  type MovieCard,
  type Snapshot,
} from './schema.js';

interface Pending {
  music: number | null;
  movie: number | null;
}
interface Stored {
  revision: number;
  snapshot: string | null;
  pending: string | null;
  policy: string;
}

function previousState(row: Stored): {
  snapshot: Snapshot | null;
  pending: Pending;
} {
  let snapshot: Snapshot | null = null;
  let pending: Pending = { music: null, movie: null };
  try {
    if (row.snapshot) snapshot = LatelySnapshot.parse(JSON.parse(row.snapshot));
  } catch {
    console.log('[ERROR] Rebuilding invalid Lately snapshot');
  }
  try {
    if (snapshot && row.pending)
      pending = z
        .object({
          music: z.number().finite().nonnegative().nullable(),
          movie: z.number().finite().nonnegative().nullable(),
        })
        .parse(JSON.parse(row.pending));
  } catch {
    console.log('[ERROR] Resetting invalid Lately artwork wait');
  }
  return { snapshot, pending };
}

function chooseCard<T extends MusicCard | MovieCard>(
  previous: T | null,
  next: T | null,
  pendingSince: number | null,
  now: number
): { card: T | null; pending: number | null } {
  if (
    previous?.image &&
    next &&
    !next.image &&
    previous.event_id !== next.event_id
  ) {
    // Bound the whole artwork wait, even if several short songs arrive during it.
    const since = Math.min(pendingSince ?? now, now);
    if (now - since < ARTWORK_WAIT_MS)
      return { card: previous, pending: since };
  }
  return { card: next, pending: null };
}

/** One writer per owner, fenced even if a slow invocation outlives its lease.
 * No provider fetch, image pipeline, or refresh is invoked by the GET route.
 * Recheck stored movie/artwork data each tick, including artwork that finishes
 * after afterSync hooks. Existing ingestion remains responsible for images.
 */
export async function refreshLately(
  env: Env,
  scheduledTime = Date.now()
): Promise<boolean> {
  const excluded = movieExclusions(env.LATELY_EXCLUDED_MOVIE_IDS);
  const policy = policyKey(excluded);
  const now = Date.now();
  const tick = Math.floor(scheduledTime / 60_000) * 60_000;
  const token = crypto.randomUUID();
  const row = await env.DB.prepare(
    `INSERT INTO lately_snapshots
    (user_id, lease_token, lease_until, last_started_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET lease_token = excluded.lease_token,
      lease_until = excluded.lease_until, last_started_at = excluded.last_started_at
    WHERE lately_snapshots.lease_until <= ? AND lately_snapshots.last_started_at < ?
    RETURNING revision, snapshot, pending, policy`
  )
    .bind(LATELY_OWNER_ID, token, now + LEASE_MS, tick, now, tick)
    .first<Stored>();
  if (!row) return false;
  try {
    await loadFilters(latelyDb(env));
    const { snapshot: old, pending } = previousState(row);

    // Reapply admission rules even during a provider outage. Never retain a
    // newly excluded movie or filtered song merely because it was published.
    const previousMusic = old?.music
      ? await musicCard(env.DB, old.music)
      : null;
    const previousMovie =
      old?.movie && !excluded.includes(old.movie.movie_id) ? old.movie : null;
    const [musicResult, movieResult] = await Promise.allSettled([
      latestMusic(env),
      latestMovie(env.DB, excluded),
    ]);
    let music = previousMusic;
    let musicCheckedAt = old?.music_checked_at ?? null;
    let movie = previousMovie;
    let movieCheckedAt = old?.movie_checked_at ?? null;
    const checkedAt = new Date(now).toISOString();
    if (musicResult.status === 'fulfilled') {
      const candidate = musicResult.value;
      // A stale upstream replica / DB fallback must not move music backwards.
      music =
        candidate &&
        (!previousMusic || candidate.scrobbled_at >= previousMusic.scrobbled_at)
          ? candidate
          : previousMusic;
      musicCheckedAt = checkedAt;
    } else {
      console.log(
        '[ERROR] Lately music refresh failed; retaining last valid item'
      );
      // Bootstrap from local data during a provider outage without claiming
      // the upstream was successfully checked.
      music ??= await storedMusic(env.DB);
    }
    if (movieResult.status === 'fulfilled') {
      movie = movieResult.value;
      movieCheckedAt = checkedAt;
    } else {
      console.log(
        '[ERROR] Lately movie refresh failed; retaining last valid item'
      );
    }
    const selectedMusic = chooseCard(previousMusic, music, pending.music, now);
    const selectedMovie = chooseCard(previousMovie, movie, pending.movie, now);
    const snapshot: Snapshot = LatelySnapshot.parse({
      schema_version: 1,
      version: row.revision + 1,
      as_of: checkedAt,
      music_checked_at: musicCheckedAt,
      movie_checked_at: movieCheckedAt,
      music: selectedMusic.card,
      movie: selectedMovie.card,
    });
    const result = await env.DB.prepare(
      `UPDATE lately_snapshots SET snapshot = ?, pending = ?, revision = revision + 1,
      policy = ?, lease_token = NULL, lease_until = 0
      WHERE user_id = ? AND lease_token = ? AND lease_until > ?`
    )
      .bind(
        JSON.stringify(snapshot),
        JSON.stringify({
          music: selectedMusic.pending,
          movie: selectedMovie.pending,
        }),
        policy,
        LATELY_OWNER_ID,
        token,
        Date.now()
      )
      .run();
    return result.meta.changes === 1;
  } finally {
    // Token condition prevents an expired writer from unlocking its successor.
    await env.DB.prepare(
      `UPDATE lately_snapshots SET lease_token = NULL, lease_until = 0
      WHERE user_id = ? AND lease_token = ?`
    )
      .bind(LATELY_OWNER_ID, token)
      .run();
  }
}
