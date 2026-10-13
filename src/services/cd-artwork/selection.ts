import { readPixels } from '../../../scripts/cd-artwork/pixels.mjs';
import type { ArtworkEnv, JobRequest } from './types.js';
import { sha256 } from './types.js';
import { PROCESSOR_HASH } from './processor-version.js';
import {
  ArtworkError,
  providerJson,
  downloadImage,
  resolveEditionCandidates,
  resolveSource,
  catalogIdentityProof,
  type CatalogAlbum,
} from './sources.js';
import { prepareAudioDbArtwork } from './audiodb.js';
import {
  albumMatches,
  artistIdentityMatches,
  trackMatches,
} from '../images/sources/utils.js';

export interface SelectedSource {
  request: JobRequest;
  sourceUrl: string;
  preparedBytes?: Uint8Array;
  preparedMime?: string;
  retailRetryAfter?: number;
  retailRetryKind?: 'capacity';
  sourceKind: 'retail' | 'cover';
  renderRetry?: { attempt: 1; reason: 'geometry' | 'quality' };
  identityType: 'representative_release' | 'reviewed_source';
  selectedImageId: string | null;
  discovery: { outcome: string; [key: string]: unknown };
}
interface Collection {
  collectionId?: number | string;
  collectionName?: string;
  artistName?: string;
  artworkUrl100?: string;
  wrapperType?: string;
  trackName?: string;
  releaseDate?: string;
}
interface AppleResource {
  id: string;
  attributes?: {
    name?: string;
    artistName?: string;
    artwork?: { url: string };
    releaseDate?: string;
  };
  relationships?: { tracks?: { data?: AppleResource[] } };
}
function catalogTrackNear(requested: string, returned: string) {
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = normalize(requested),
    b = normalize(returned);
  const versions = (value: string) =>
    value
      .match(
        /\b(?:live|remix|mix|acoustic|instrumental|demo|radio|edit|session)\b/g
      )
      ?.sort()
      .join(',') ?? '';
  if (
    Math.min(a.length, b.length) < 16 ||
    Math.max(a.length, b.length) > 240 ||
    Math.abs(a.length - b.length) > 2 ||
    versions(a) !== versions(b)
  )
    return false;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        next[j - 1] + 1,
        row[j] + 1,
        row[j - 1] + Number(a[i - 1] !== b[j - 1])
      );
    row = next;
  }
  return row[b.length] <= 2;
}
const appleCollection = (album: AppleResource): Collection => ({
  wrapperType: 'collection',
  collectionId: album.id,
  collectionName: album.attributes?.name,
  artistName: album.attributes?.artistName,
  artworkUrl100: album.attributes?.artwork?.url
    .replace('{w}', '1200')
    .replace('{h}', '1200')
    .replace('{f}', 'jpg'),
  releaseDate: album.attributes?.releaseDate,
});
async function searchCoverCatalog(env: ArtworkEnv, album: CatalogAlbum) {
  const authenticated = !!env.APPLE_MUSIC_DEVELOPER_TOKEN;
  const url = new URL(
    authenticated
      ? 'https://api.music.apple.com/v1/catalog/us/search'
      : 'https://itunes.apple.com/search'
  );
  url.searchParams.set('term', `${album.artist} ${album.name}`);
  url.searchParams.set(
    authenticated ? 'types' : 'entity',
    'album' + (authenticated ? 's' : '')
  );
  url.searchParams.set('limit', '10');
  if (authenticated) {
    const result = await providerJson<{
      results?: { albums?: { data?: AppleResource[] } };
    }>(env, url.href);
    return (result?.results?.albums?.data ?? []).map(appleCollection);
  }
  return (
    (await providerJson<{ results: Collection[] }>(env, url.href))?.results ??
    []
  );
}
async function lookupCoverCatalog(
  env: ArtworkEnv,
  id: string
): Promise<Collection[]> {
  if (!env.APPLE_MUSIC_DEVELOPER_TOKEN)
    return (
      (
        await providerJson<{ results: Collection[] }>(
          env,
          `https://itunes.apple.com/lookup?id=${id}&entity=song&limit=200`
        )
      )?.results ?? []
    );
  const result = await providerJson<{ data?: AppleResource[] }>(
    env,
    `https://api.music.apple.com/v1/catalog/us/albums/${id}?include=tracks`
  );
  const album = result?.data?.find((a) => a.id === id);
  if (!album) return [];
  return [
    appleCollection(album),
    ...(album.relationships?.tracks?.data ?? []).map((song): Collection => ({
      wrapperType: 'track',
      collectionId: id,
      artistName: song.attributes?.artistName,
      trackName: song.attributes?.name,
    })),
  ];
}
/** Two independent checks: exact album/artist metadata and an observed track.
 * Cover-only albums never need a physical-release identifier. Provider errors
 * remain errors; they are not evidence that a CD or cover does not exist.
 */
export async function verifiedCover(
  env: ArtworkEnv,
  albumId: number,
  userId: number,
  album: CatalogAlbum,
  allowLegacy = false,
  knownRelease?: string
): Promise<SelectedSource> {
  const tracks = await env.DB.prepare(
    'SELECT t.name FROM lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_album_date JOIN lastfm_tracks t NOT INDEXED ON t.id=s.track_id AND t.user_id=s.user_id WHERE s.user_id=? AND s.album_recorded=1 AND s.album_id=? AND t.is_filtered=0 ORDER BY s.scrobbled_at DESC LIMIT 8'
  )
    .bind(userId, albumId)
    .all<{ name: string }>();
  let legacyEvidence = false;
  if (!tracks.results.length && allowLegacy) {
    const legacy = await env.DB.prepare(
      'SELECT t.name FROM lastfm_tracks t INDEXED BY idx_lastfm_tracks_user_album JOIN lastfm_scrobbles s INDEXED BY idx_lastfm_scrobbles_user_track_date ON s.track_id=t.id AND s.user_id=t.user_id WHERE t.user_id=? AND t.album_id=? AND t.is_filtered=0 AND s.album_recorded=0 ORDER BY s.scrobbled_at DESC LIMIT 8'
    )
      .bind(userId, albumId)
      .all<{ name: string }>();
    tracks.results.push(...legacy.results);
    legacyEvidence = legacy.results.length > 0;
  }
  if (!tracks.results.length)
    throw new ArtworkError('cover_identity_unverified');
  let proof: Awaited<ReturnType<typeof catalogIdentityProof>> | undefined;
  const stripLive = (title: string) =>
    title
      .replace(
        /\s*(?:\(live(?:\s+(?:at|from|in|on)\s+[^)]+)?\)|\[live(?:\s+(?:at|from|in|on)\s+[^\]]+)?\]|[-–—]\s*live(?:\s+(?:at|from|in|on)\s+.+)?)$/i,
        ''
      )
      .trim();
  const trackTitle = (title: string, live = false) => {
    const withoutCredit = title
      .replace(/\s*&\s*/g, ' and ')
      .replace(/\s*(?:\(|\[)(?:feat\.?|ft\.?|featuring)\s+[^)\]]+[)\]]$/i, '')
      .replace(/\s+(?:[-–—]\s*)?(?:feat\.?|ft\.?|featuring)\s+.+$/i, '')
      .trim();
    return live ? stripLive(withoutCredit) : withoutCredit;
  };
  const titleMatches = async (title: string) => {
    if (albumMatches(album.name, title, album.artist)) return true;
    if (proof === undefined)
      proof = await catalogIdentityProof(env, album, knownRelease);
    return (
      !!proof &&
      albumMatches(
        proof.title,
        proof.live ? stripLive(title) : title,
        album.artist
      )
    );
  };
  const readCandidate = async (id: string) => {
    const lookup = await lookupCoverCatalog(env, id);
    const collection = lookup.find(
      (c) => c.wrapperType === 'collection' && String(c.collectionId) === id
    );
    if (
      !collection?.artistName ||
      !collection.collectionName ||
      !artistIdentityMatches(album.artist, collection.artistName) ||
      !(await titleMatches(collection.collectionName))
    )
      return { collection: null, trackVerified: false };
    // Album-level artist identity and track membership are authoritative.
    // Song credits may include guest performers without changing its album.
    const songs = lookup.filter(
      (c) => c.wrapperType === 'track' && String(c.collectionId) === id
    );
    const live =
      proof?.live === true ||
      (stripLive(album.name) !== album.name &&
        stripLive(collection.collectionName) !== collection.collectionName);
    const withoutArticle = (title: string) =>
      title.replace(/^(?:a|an|the)\s+/i, '');
    let trackVerified = tracks.results.some((t) => {
      const requested = trackTitle(t.name, live);
      if (
        songs.some(
          (s) =>
            s.trackName &&
            trackMatches(requested, trackTitle(s.trackName, live))
        )
      )
        return true;
      // A scrobble can omit a leading article. Accept only one such member of
      // this proven album, never an arbitrary fuzzy match or duplicate title.
      return (
        songs.filter(
          (s) =>
            s.trackName &&
            trackMatches(
              withoutArticle(requested),
              withoutArticle(trackTitle(s.trackName, live))
            )
        ).length === 1
      );
    });
    let trackProof = trackVerified ? 'catalog_member_title' : null;
    if (!trackVerified) {
      if (proof === undefined)
        proof = await catalogIdentityProof(env, album, knownRelease);
      if (
        proof &&
        albumMatches(
          proof.title,
          proof.live
            ? stripLive(collection.collectionName)
            : collection.collectionName,
          album.artist
        )
      ) {
        // Only an independently proven logical album may tolerate a small
        // scrobble typo, identifying exactly one member. Version qualifiers
        // remain significant; this is not fuzzy album or artist search.
        trackVerified = tracks.results.some(
          (t) =>
            songs.filter(
              (s) =>
                s.trackName &&
                catalogTrackNear(
                  trackTitle(t.name, proof?.live),
                  trackTitle(s.trackName, proof?.live)
                )
            ).length === 1
        );
        if (trackVerified) trackProof = 'catalog_anchored_title_variance';
      }
    }
    return { collection, trackVerified, trackProof };
  };
  let id = album.apple_music_id == null ? null : String(album.apple_music_id);
  const stored = id && /^\d+$/.test(id) ? await readCandidate(id) : null;
  let result = stored;
  let representative = false;
  if (!result?.collection || !result.trackVerified) {
    const candidates: Collection[] = [];
    for (const candidate of await searchCoverCatalog(env, album))
      if (
        candidate.collectionId &&
        candidate.collectionName &&
        candidate.artistName &&
        artistIdentityMatches(album.artist, candidate.artistName) &&
        (await titleMatches(candidate.collectionName))
      )
        candidates.push(candidate);
    const ids = [...new Set(candidates.map((c) => String(c.collectionId)))];
    if (ids.length > 1) {
      if (proof === undefined)
        proof = await catalogIdentityProof(env, album, knownRelease);
      const exactTitle = (title: string) =>
        title.normalize('NFKC').trim().toLowerCase();
      const exactCandidates = candidates.filter(
        (candidate) =>
          candidate.collectionName &&
          exactTitle(candidate.collectionName) === exactTitle(album.name)
      );
      const fullDate = (candidate: Collection) => {
        const date = candidate.releaseDate?.slice(0, 10) ?? '';
        return /^\d{4}-\d{2}-\d{2}$/.test(date) &&
          (!proof?.releaseDate || date.startsWith(proof.releaseDate))
          ? date
          : null;
      };
      const dates = new Set(exactCandidates.map(fullDate));
      const expectedDate =
        proof?.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(proof.releaseDate)
          ? proof.releaseDate
          : dates.size === 1 && !dates.has(null)
            ? [...dates][0]
            : null;
      const representsAlbum = (candidate: Collection) =>
        !!expectedDate &&
        !!candidate.collectionName &&
        exactTitle(candidate.collectionName) === exactTitle(album.name) &&
        candidate.releaseDate?.slice(0, 10) === expectedDate;
      // Clean/explicit and storefront editions can have distinct collection
      // IDs for one logical album. Exact title, a shared release date,
      // artist identity and a fresh observed-track match authorize a
      // representative cover, without claiming an owned edition.
      // A bound catalog date takes precedence over provider equivalence.
      const choices = [
        ...new Set(
          candidates.filter(representsAlbum).map((c) => String(c.collectionId))
        ),
      ].sort();
      for (const choice of choices.slice(0, 3)) {
        const candidate = await readCandidate(choice);
        if (
          candidate.collection &&
          candidate.trackVerified &&
          representsAlbum(candidate.collection)
        ) {
          id = choice;
          result = candidate;
          representative = true;
          break;
        }
      }
      if (!representative) throw new ArtworkError('cover_identity_ambiguous');
    } else if (ids.length !== 1)
      throw new ArtworkError(
        ids.length
          ? 'cover_identity_ambiguous'
          : stored?.collection
            ? 'cover_track_mismatch'
            : id
              ? 'cover_identity_unverified'
              : 'cover_not_found'
      );
    else {
      id = ids[0];
      result = await readCandidate(id);
    }
  }
  if (!id || !result?.collection)
    throw new ArtworkError('cover_identity_unverified');
  if (!result.trackVerified) throw new ArtworkError('cover_track_mismatch');
  const collection = result.collection;
  const artwork = collection.artworkUrl100;
  if (!artwork) throw new ArtworkError('cover_not_found');
  const sourceUrl = artwork.replace(/\d+x\d+bb(?=\.)/, '1200x1200bb');
  const u = new URL(sourceUrl);
  if (
    u.protocol !== 'https:' ||
    !/(^|\.)mzstatic\.com$/.test(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    throw new ArtworkError('source_host_not_allowed');
  return {
    request: {
      album_id: albumId,
      release_id: null,
      medium_position: null,
      source_kind: 'cover',
      cover_url: sourceUrl,
    },
    sourceUrl,
    sourceKind: 'cover',
    identityType: 'reviewed_source',
    selectedImageId: null,
    discovery: {
      outcome: 'cover_found',
      collection_id: id,
      catalog_provider: env.APPLE_MUSIC_DEVELOPER_TOKEN
        ? 'apple_music'
        : 'itunes',
      album_artist_verified: true,
      observed_track_verified: true,
      observed_track_proof: result.trackProof,
      ...(representative
        ? { cover_selection: 'representative_catalog_edition' }
        : {}),
      ...(proof
        ? { catalog_title: proof.title, catalog_alias_proof: proof }
        : {}),
      play_evidence: legacyEvidence
        ? 'legacy_track_association'
        : 'recorded_album',
    },
  };
}
export async function selectAutomaticSource(
  env: ArtworkEnv,
  albumId: number,
  userId: number,
  album: CatalogAlbum,
  releaseId: string,
  mediumPosition: number,
  allowLegacy = false,
  revisitEdition = false
): Promise<SelectedSource> {
  // A failed render does not invalidate its source. Permit one controlled
  // regeneration before moving on; count unique generations, not reprocessing
  // jobs. Provider outages never consume this render retry.
  const failed = await env.DB.prepare(
    "SELECT source_hash,COUNT(DISTINCT COALESCE(json_extract(provenance,'$.generationKey'),id)) AS attempts,MAX(COALESCE(json_extract(provenance,'$.renderRetry.attempt'),0)) AS retried,MAX(error_code) AS reason FROM cd_artwork_jobs WHERE user_id=? AND album_id=? AND automatic=1 AND validation_state='held' AND error_code IN ('automatic_geometry_hold','automatic_quality_hold') AND json_extract(provenance,'$.processorHash')=? GROUP BY source_hash"
  )
    .bind(userId, albumId, PROCESSOR_HASH)
    .all<{
      source_hash: string;
      attempts: number;
      retried: number;
      reason: string;
    }>();
  const failures = new Map(failed.results.map((row) => [row.source_hash, row]));
  const usable = async (bytes: Uint8Array) => {
    const failure = failures.get(await sha256(bytes));
    return !failure || (failure.attempts < 2 && failure.retried === 0);
  };
  const renderRetry = async (
    bytes: Uint8Array
  ): Promise<SelectedSource['renderRetry']> => {
    const failure = failures.get(await sha256(bytes));
    return failure
      ? {
          attempt: 1,
          reason:
            failure.reason === 'automatic_geometry_hold'
              ? 'geometry'
              : 'quality',
        }
      : undefined;
  };
  const fallbackCover = async () => {
    const candidate =
      cover ??
      verified ??
      (await verifiedCover(
        env,
        albumId,
        userId,
        album,
        allowLegacy,
        releaseId || undefined
      ));
    const image =
      candidate.preparedBytes && candidate.preparedMime
        ? { bytes: candidate.preparedBytes, mime: candidate.preparedMime }
        : await downloadImage(candidate.sourceUrl);
    if (!(await usable(image.bytes)))
      throw new ArtworkError('artwork_sources_exhausted', 422);
    return {
      ...candidate,
      preparedBytes: image.bytes,
      preparedMime: image.mime,
      renderRetry: await renderRetry(image.bytes),
    };
  };
  const audioDbGroups = new Set<string>();
  // A stored Apple binding is independent identity evidence, not permission
  // to ignore contradictory metadata when a retail scan happens to exist.
  const verified = album.apple_music_id
    ? await verifiedCover(
        env,
        albumId,
        userId,
        album,
        allowLegacy,
        releaseId || undefined
      )
    : null;
  const retailAlbum = verified?.discovery.catalog_title
    ? { ...album, name: String(verified.discovery.catalog_title) }
    : album;
  // A cover can be published while a proven CD source is waiting or failed.
  // Retain those candidates across retries; a fresh search need not rank the
  // same pressing again. Every remembered candidate is revalidated below.
  const remembered = new Map<
    string,
    { medium_position: number; image_id: string | null }
  >();
  if (revisitEdition) {
    const prior = await env.DB.prepare(
      "SELECT json_extract(input,'$.release_id') AS release_id,json_extract(input,'$.medium_position') AS medium_position,json_extract(input,'$.image_id') AS image_id FROM cd_artwork_jobs WHERE user_id=? AND album_id=? AND automatic=1 AND json_extract(input,'$.source_kind')='retail' AND json_extract(provenance,'$.sourceIdentityEvidence.medium_verified')=1 ORDER BY created_at DESC LIMIT 3"
    )
      .bind(userId, albumId)
      .all<{
        release_id: string;
        medium_position: number;
        image_id: string | null;
      }>();
    for (const candidate of prior.results)
      if (
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
          candidate.release_id
        ) &&
        Number.isSafeInteger(candidate.medium_position) &&
        candidate.medium_position >= 1 &&
        candidate.medium_position <= 10 &&
        !remembered.has(candidate.release_id)
      )
        remembered.set(candidate.release_id, candidate);
  }
  let cover: SelectedSource | null = null;
  try {
    let releases = [
      ...new Set([...(releaseId ? [releaseId] : []), ...remembered.keys()]),
    ].slice(0, 3);
    let searched = false;
    const discoverReleases = async () => {
      const candidates = await resolveEditionCandidates(
        env,
        retailAlbum,
        true,
        releaseId || undefined
      );
      // Multiple pressings of one proven logical album can supply representative
      // art. Different/unknown release groups remain ambiguous. Inspect at most
      // three stable IDs; never claim that a representative scan is owned.
      const groups = new Set(
        candidates.candidates.map((c) => c.release_group_id)
      );
      if (
        groups.size === 1 &&
        !groups.has(null) &&
        (candidates.group_verified || !candidates.results_truncated)
      ) {
        const discovered = candidates.candidates
          .map((c) => c.release_id)
          .sort();
        releases = [...new Set([...releases, ...discovered])].slice(0, 3);
      }
    };
    for (let index = 0; index < 3; index++) {
      if (
        index >= releases.length &&
        !searched &&
        (!releaseId || revisitEdition)
      ) {
        searched = true;
        await discoverReleases();
      }
      const release = releases[index];
      if (!release) break;
      const previous = remembered.get(release);
      const request: JobRequest = {
        album_id: albumId,
        release_id: release,
        medium_position:
          release === releaseId
            ? mediumPosition
            : (previous?.medium_position ?? 1),
        source_kind: 'retail',
      };
      let found;
      try {
        found = await resolveSource(env, request, retailAlbum, true);
      } catch (error) {
        if (previous && error instanceof ArtworkError && error.status === 422)
          continue;
        throw error;
      }
      const images = found.discovery.images.filter((i) => i.approved);
      const selectedImage =
        (previous?.image_id
          ? images.find((image) => image.id === previous.image_id)
          : undefined) ?? (images.length === 1 ? images[0] : undefined);
      if (found.discovery.outcome === 'found' && selectedImage) {
        request.image_id = selectedImage.id;
        const downloaded = await usableSource(selectedImage.url);
        if (downloaded && (await usable(downloaded.bytes)))
          return {
            preparedBytes: downloaded.bytes,
            preparedMime: downloaded.mime,
            renderRetry: await renderRetry(downloaded.bytes),
            ...found,
            sourceUrl: selectedImage.url,
            sourceKind: 'retail',
            identityType: 'representative_release',
            selectedImageId: selectedImage.id,
            request,
          };
      }
      const groupId = found.discovery.release_group_id;
      if (
        found.discovery.medium_verified === true &&
        typeof groupId === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(groupId) &&
        !audioDbGroups.has(groupId)
      ) {
        audioDbGroups.add(groupId);
        let candidate;
        try {
          candidate = await prepareAudioDbArtwork(env, retailAlbum, groupId);
        } catch (error) {
          if (!(error instanceof ArtworkError) || error.status !== 422)
            throw error;
          // Unusable/provider-mismatched artwork is a miss for this source,
          // not a demand for a human to approve an album.
          candidate = null;
        }
        if (candidate && (await usable(candidate.bytes))) {
          const request: JobRequest = {
            album_id: albumId,
            release_id: release,
            medium_position: release === releaseId ? mediumPosition : 1,
            source_kind: 'retail',
          };
          return {
            request,
            sourceUrl: candidate.sourceUrl,
            preparedBytes: candidate.bytes,
            preparedMime: 'image/png',
            renderRetry: await renderRetry(candidate.bytes),
            sourceKind: 'retail',
            identityType: 'representative_release',
            selectedImageId: null,
            discovery: {
              ...found.discovery,
              audiodb: {
                outcome: 'identity_matched_candidate',
                release_group_id: groupId,
                provider_album_id: candidate.providerAlbumId,
                source_url: candidate.sourceUrl,
                source_sha256: candidate.sourceSha256,
                requires_automatic_visual_verification: true,
              },
            },
          };
        }
      }
      if (found.discovery.covers.length === 1) {
        // Keep one verified cover while checking the remaining bounded retail candidates.
        const front = found.discovery.covers[0];
        const downloaded = await usableSource(front.url);
        if (downloaded && (await usable(downloaded.bytes)))
          cover ??= {
            preparedBytes: downloaded.bytes,
            preparedMime: downloaded.mime,
            request: { ...request, source_kind: 'cover', cover_url: front.url },
            sourceUrl: front.url,
            sourceKind: 'cover',
            identityType: 'representative_release',
            selectedImageId: front.id,
            discovery: { ...found.discovery, outcome: 'cover_found' },
          };
      }
    }
    return await fallbackCover();
  } catch (error) {
    if (!(error instanceof ArtworkError) || ![429, 503].includes(error.status))
      throw error;
    // Available cover evidence can produce a design while retail discovery is
    // pending. Retain the outage and retry; never record retail art as absent.
    const fallback = await fallbackCover();
    return {
      ...fallback,
      retailRetryAfter: error.retryAfter,
      ...(error.code === 'discovery_busy'
        ? { retailRetryKind: 'capacity' as const }
        : {}),
      discovery: {
        ...fallback.discovery,
        outcome: 'retail_provider_pending',
        retail_retry_after: error.retryAfter,
        ...(error.code.startsWith('audiodb_')
          ? { audiodb: { outcome: 'provider_pending', code: error.code } }
          : {}),
      },
    };
  }
}

async function usableSource(url: string) {
  try {
    const downloaded = await downloadImage(url);
    let pixels;
    try {
      pixels = readPixels(downloaded.bytes);
    } catch {
      return null;
    }
    return Math.max(pixels.width, pixels.height) >= 660 &&
      pixels.width * pixels.height <= 12000000
      ? downloaded
      : null;
  } catch (error) {
    if (
      error instanceof ArtworkError &&
      error.status === 422 &&
      [
        'source_fetch_failed',
        'source_format_unsupported',
        'source_too_large',
      ].includes(error.code)
    )
      return null;
    throw error;
  }
}
