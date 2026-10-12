import type { ArtworkEnv, Job, JobInput } from './types.js';
import { now, sha256 } from './types.js';
import { ArtworkError, resolveSource } from './sources.js';
import { dispatch, ownedAlbum } from './store.js';
export async function scheduledArtwork(env: ArtworkEnv) {
  const control = await env.DB.prepare(
    'SELECT enabled FROM cd_artwork_control WHERE id=1'
  ).first<{ enabled: number }>();
  if (!control?.enabled) return;
  // Register newly scrobbled owner albums after feature activation. This hooks
  // into existing Last.fm sync state without rewriting the sync worker or
  // backfilling the historical library. Identity/material selection remains a
  // hold; enrollment itself does not submit paid generation.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO cd_artwork_albums(user_id,album_id,release_id,medium_position,next_check,discovery_outcome,discovery_evidence) SELECT a.user_id,a.id,'',1,?,'identity_required','{}' FROM lastfm_scrobbles s JOIN lastfm_tracks t ON t.id=s.track_id AND t.user_id=s.user_id JOIN lastfm_albums a ON a.id=t.album_id AND a.user_id=t.user_id JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id WHERE s.user_id=1 AND s.scrobbled_at>=(SELECT enroll_since FROM cd_artwork_control WHERE id=1) AND t.is_filtered=0 AND a.is_filtered=0 AND NOT EXISTS(SELECT 1 FROM cd_artwork_albums c WHERE c.user_id=a.user_id AND c.album_id=a.id) GROUP BY a.user_id,a.id ORDER BY MAX(s.scrobbled_at) DESC LIMIT 3"
  )
    .bind(new Date(Date.now() + 30 * 86400000).toISOString())
    .run();
  // Only explicitly queued work is dispatched. A library-wide paid backfill is
  // never inferred from the mere existence of an album or discovery result.
  const queued = await env.DB.prepare(
    "SELECT * FROM cd_artwork_jobs WHERE state='queued' ORDER BY created_at LIMIT 2"
  ).all<Job>();
  for (const job of queued.results) {
    try {
      await dispatch(env, job);
    } catch {
      console.log('[ERROR] CD artwork dispatch unavailable');
    }
  }
  const lease = await env.DB.prepare(
    'UPDATE cd_artwork_control SET discovery_lease_until=? WHERE id=1 AND (discovery_lease_until IS NULL OR discovery_lease_until<?) RETURNING id'
  )
    .bind(new Date(Date.now() + 300000).toISOString(), now())
    .first();
  if (!lease) return;
  try {
    const due = await env.DB.prepare(
      "SELECT * FROM cd_artwork_albums WHERE next_check<=? AND release_id<>'' ORDER BY next_check LIMIT 3"
    )
      .bind(now())
      .all<{
        user_id: number;
        album_id: number;
        release_id: string;
        medium_position: number;
        active_job: string | null;
      }>();
    for (const row of due.results) {
      if (!row.release_id) continue;
      let outcome: string, evidence: unknown, delay: number;
      try {
        const album = await ownedAlbum(env, row.album_id, row.user_id);
        const input: JobInput = {
          album_id: row.album_id,
          release_id: row.release_id,
          medium_position: row.medium_position,
          source_kind: 'cover',
        };
        const result = await resolveSource(env, input, album, true);
        outcome = result.discovery.outcome;
        evidence = result.discovery;
        delay =
          30 * 86400000 +
          (parseInt(
            (await sha256(`${row.user_id}:${row.album_id}`)).slice(0, 4),
            16
          ) %
            86400) *
            1000;
      } catch (error) {
        outcome =
          error instanceof ArtworkError &&
          error.code === 'edition_identity_mismatch'
            ? 'identity_required'
            : 'error';
        evidence = {
          outcome,
          code:
            error instanceof ArtworkError ? error.code : 'provider_unavailable',
        };
        delay =
          error instanceof ArtworkError ? error.retryAfter * 1000 : 3600000;
      }
      await env.DB.prepare(
        'UPDATE cd_artwork_albums SET discovery_outcome=?,discovery_evidence=?,next_check=? WHERE user_id=? AND album_id=?'
      )
        .bind(
          outcome,
          JSON.stringify(evidence),
          new Date(Date.now() + delay).toISOString(),
          row.user_id,
          row.album_id
        )
        .run();
    }
  } finally {
    await env.DB.prepare(
      'UPDATE cd_artwork_control SET discovery_lease_until=NULL WHERE id=1'
    ).run();
  }
}
