const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// This local runner is serial. Do not run parallel CLI instances against MB;
// a deployed worker would require a shared provider-rate coordinator.
let nextRequest = 0;
async function get(url, fetcher) {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, nextRequest - Date.now()))
  );
  nextRequest = Date.now() + 1100;
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent':
        'Rewind-CD-Artwork-Evaluation/1.0 (https://github.com/pdugan20/rewind)',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return { absent: true };
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    return {
      failure: response.status,
      retryAfterSeconds: retry
        ? Number.isFinite(Number(retry))
          ? Number(retry)
          : Math.max(0, (Date.parse(retry) - Date.now()) / 1000)
        : 0,
    };
  }
  return { data: await response.json() };
}
export async function discover(identity, { fetcher = fetch } = {}) {
  if (!identity?.releaseId || !UUID.test(identity.releaseId))
    return {
      outcome: 'identity_required',
      reason:
        'A verified MusicBrainz release identity is required; title matching is not automatic.',
    };
  try {
    const release = await get(
      `https://musicbrainz.org/ws/2/release/${identity.releaseId}?inc=recordings&fmt=json`,
      fetcher
    );
    if (release.failure)
      return { outcome: 'error', provider: 'musicbrainz', ...release };
    if (release.absent) return { outcome: 'invalid_release' };
    const media = release.data.media;
    if (!Array.isArray(media))
      return {
        outcome: 'error',
        provider: 'musicbrainz',
        reason: 'Malformed release response',
      };
    const cd = media.filter((m) => ['CD', 'HDCD'].includes(m.format));
    if (!cd.length)
      return {
        outcome: 'invalid_release',
        reason: 'Release does not contain a CD',
      };
    const archive = await get(
      `https://coverartarchive.org/release/${identity.releaseId}`,
      fetcher
    );
    if (archive.failure)
      return { outcome: 'error', provider: 'cover-art-archive', ...archive };
    if (archive.absent)
      return {
        outcome: 'not_found',
        releaseId: identity.releaseId,
        scope: 'this release only',
      };
    if (!Array.isArray(archive.data.images))
      return {
        outcome: 'error',
        provider: 'cover-art-archive',
        reason: 'Malformed image response',
      };
    const images = archive.data.images
      .filter((i) => i.types?.includes('Medium'))
      .map((i) => ({
        id: String(i.id),
        source: i.image,
        comment: i.comment ?? '',
        archiveApproved: !!i.approved,
      }));
    // Mixed-media and multi-disc releases need explicit image-to-medium review.
    const ambiguous =
      media.length !== 1 ||
      cd.length !== 1 ||
      (identity.mediumPosition && identity.mediumPosition !== cd[0].position);
    return {
      outcome: images.length
        ? ambiguous
          ? 'ambiguous'
          : 'found'
        : 'not_found',
      releaseId: identity.releaseId,
      images,
      review: 'candidate discovery only; never changes the active artwork',
      scope: 'this verified release only',
    };
  } catch (e) {
    return {
      outcome: 'error',
      reason:
        e.name === 'TimeoutError'
          ? 'Provider timeout'
          : 'Provider request/parse failed',
    };
  }
}
