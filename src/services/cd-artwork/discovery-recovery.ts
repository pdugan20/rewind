import type { ArtworkEnv } from './types.js';
import {
  DISCOVERY_POLICY,
  RECOVERABLE_DISCOVERY_CODES,
} from './discovery-policy.js';

// Reuse this predicate for selection AND atomic admission. Recovery operates
// only on failures already admitted by listening, never the album library.
const eligible = `c.user_id=1 AND c.active_job IS NULL AND c.hidden_job IS NULL
  AND c.pinned=0 AND c.review_hold=0
  AND (SELECT enabled=1 AND automatic_enabled=1 FROM cd_artwork_control WHERE id=1)
  AND EXISTS (SELECT 1 FROM lastfm_albums a JOIN lastfm_artists r ON r.id=a.artist_id AND r.user_id=a.user_id
    WHERE a.id=c.album_id AND a.user_id=c.user_id AND a.is_filtered=0 AND r.is_filtered=0
    AND a.identity_conflict=0 AND r.identity_conflict=0)
  AND c.discovery_outcome IN ('identity_required','source_unavailable')
  AND json_extract(c.discovery_evidence,'$.code') IN (${RECOVERABLE_DISCOVERY_CODES.map(() => '?').join(',')})
  AND COALESCE(json_extract(c.discovery_evidence,'$.discovery_policy'),'')<>?
  AND EXISTS (SELECT 1 FROM cd_artwork_checks k WHERE k.user_id=c.user_id AND k.album_id=c.album_id
    AND k.completed_at IS NOT NULL AND k.outcome IN ('identity_required','source_unavailable'))
  AND NOT EXISTS (SELECT 1 FROM cd_artwork_checks k WHERE k.user_id=c.user_id AND k.album_id=c.album_id AND k.completed_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM cd_artwork_jobs j WHERE j.user_id=c.user_id AND j.album_id=c.album_id
    AND (j.state IN ('queued','submitted','provider_unknown','pending')
      OR (j.state='needs_registration' AND COALESCE(j.validation_state,'') IN ('','claimed','passed'))))
  AND NOT EXISTS (SELECT 1 FROM cd_artwork_events e WHERE e.user_id=c.user_id AND e.album_id=c.album_id
    AND e.action='discovery-policy-retry' AND json_extract(e.details,'$.policy')=?)`;
const bindings = [
  ...RECOVERABLE_DISCOVERY_CODES,
  DISCOVERY_POLICY,
  DISCOVERY_POLICY,
];

/** At most two stale source failures per scheduled run, once per policy.
 * The existing unique pending-check index plus a transactional admission/event
 * pair protects concurrent schedulers. No active artwork or history is reset. */
export async function recoverDiscoveryFailures(env: ArtworkEnv) {
  const rows = await env.DB.prepare(
    `SELECT c.album_id FROM cd_artwork_albums c WHERE ${eligible} ORDER BY c.last_checked_at DESC,c.album_id LIMIT 2`
  )
    .bind(...bindings)
    .all<{ album_id: number }>();
  for (const row of rows.results) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO cd_artwork_checks(user_id,album_id,release_id,medium_position)
         SELECT c.user_id,c.album_id,c.release_id,c.medium_position FROM cd_artwork_albums c
         WHERE c.album_id=? AND ${eligible}`
      ).bind(row.album_id, ...bindings),
      env.DB.prepare(
        `INSERT INTO cd_artwork_events(user_id,album_id,job_id,action,reviewer,created_at,details)
         SELECT k.user_id,k.album_id,NULL,'discovery-policy-retry','scheduled-discovery',
           strftime('%Y-%m-%dT%H:%M:%fZ','now'),json_object('policy',?,'checkId',k.id)
         FROM cd_artwork_checks k WHERE changes()=1 AND k.user_id=1 AND k.album_id=? AND k.completed_at IS NULL`
      ).bind(DISCOVERY_POLICY, row.album_id),
    ]);
  }
}
