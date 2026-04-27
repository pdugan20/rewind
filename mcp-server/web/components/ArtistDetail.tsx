import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { timeAgo } from '../lib/time-ago.js';

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

export type ArtistMeta = {
  id: number;
  name: string;
  mbid: string | null;
  url: string | null;
  apple_music_url: string | null;
  apple_music_id: number | null;
  genre: string | null;
  tags: string[];
  bio_summary: string | null;
  bio_content: string | null;
  image: Image;
};

export type ListeningStats = {
  total_scrobbles: number;
  first_scrobble_at: string | null;
  last_played_at: string | null;
  all_time_rank: number | null;
  distinct_tracks: number;
  distinct_albums: number;
};

export type SparklineSeries = {
  granularity: 'day' | 'week' | 'month' | 'year';
  points: Array<{ at: string; count: number }>;
} | null;

export type TopTrack = {
  rank: number;
  id: number;
  name: string;
  album_id: number | null;
  album_name: string | null;
  scrobble_count: number;
  apple_music_url: string | null;
  preview_url: string | null;
  image: Image;
};

export type TopAlbum = {
  rank: number;
  id: number;
  name: string;
  playcount: number;
  apple_music_url: string | null;
  image: Image;
};

export type SimilarArtist = {
  id: number;
  name: string;
  your_scrobble_count: number;
  similarity_score: number;
  image: Image;
};

export type ArtistPayload = {
  artist: ArtistMeta;
  listening_stats: ListeningStats;
  sparkline: SparklineSeries;
  top_tracks: TopTrack[];
  top_albums: TopAlbum[];
  similar_artists: SimilarArtist[];
};

const HERO_PORTRAIT_PX = 140;
const PORTRAIT_TRANSFORM = `width=${HERO_PORTRAIT_PX * 2},height=${HERO_PORTRAIT_PX * 2},fit=cover,format=auto,quality=85`;
const ALBUM_TILE_PX = 96;
const ALBUM_TRANSFORM = `width=${ALBUM_TILE_PX * 2},height=${ALBUM_TILE_PX * 2},fit=cover,format=auto,quality=85`;
const TRACK_THUMB_PX = 40;
const TRACK_TRANSFORM = `width=${TRACK_THUMB_PX * 2},height=${TRACK_THUMB_PX * 2},fit=cover,format=auto,quality=85`;
const SIMILAR_THUMB_PX = 36;
const SIMILAR_TRANSFORM = `width=${SIMILAR_THUMB_PX * 2},height=${SIMILAR_THUMB_PX * 2},fit=cover,format=auto,quality=85`;

function buildSrc(
  image: Image,
  transform: string
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = base.includes('?')
    ? `${base.split('?')[0]}?${transform}`
    : `${base}?${transform}`;
  return {
    src: transformed,
    placeholder: thumbhashToDataUrl(image.thumbhash ?? null),
  };
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function yearOf(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(0, 4);
}

export function ArtistDetail({
  payload,
  onOpen,
}: {
  payload: ArtistPayload;
  onOpen?: (url: string) => void;
}) {
  const {
    artist,
    listening_stats,
    sparkline,
    top_tracks,
    top_albums,
    similar_artists,
  } = payload;
  const accent = artist.image?.accent_color ?? 'var(--color-accent, #4c6ef5)';
  const dominant =
    artist.image?.dominant_color ?? 'var(--color-surface, #2a2a2a)';

  return (
    <article style={cardStyle}>
      <Hero artist={artist} accent={accent} dominant={dominant} />

      <StatStrip stats={listening_stats} />

      {sparkline && sparkline.points.length > 1 && (
        <Sparkline sparkline={sparkline} accent={accent} />
      )}

      {top_tracks.length > 0 && (
        <TopTracks tracks={top_tracks} accent={accent} onOpen={onOpen} />
      )}

      {top_albums.length > 0 && (
        <TopAlbums albums={top_albums} dominant={dominant} onOpen={onOpen} />
      )}

      {similar_artists.length > 0 && (
        <SimilarArtists similar={similar_artists} />
      )}

      <Footer artist={artist} accent={accent} onOpen={onOpen} />
    </article>
  );
}

function Hero({
  artist,
  accent,
  dominant,
}: {
  artist: ArtistMeta;
  accent: string;
  dominant: string;
}) {
  const portrait = buildSrc(artist.image, PORTRAIT_TRANSFORM);
  const [loaded, setLoaded] = useState(false);

  return (
    <div style={heroStyle}>
      <div
        style={{
          ...portraitStyle,
          background: `linear-gradient(135deg, ${dominant} 0%, ${accent} 100%)`,
        }}
        aria-hidden
      >
        {portrait && portrait.placeholder && (
          <img
            src={portrait.placeholder}
            alt=""
            aria-hidden
            style={{
              ...portraitImgStyle,
              filter: 'blur(14px)',
              transform: 'scale(1.05)',
              opacity: loaded ? 0 : 1,
              transition: 'opacity 200ms ease',
            }}
          />
        )}
        {portrait && (
          <img
            src={portrait.src}
            alt={artist.name}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            style={{
              ...portraitImgStyle,
              opacity: loaded ? 1 : 0,
              transition: 'opacity 240ms ease',
            }}
          />
        )}
        {!portrait && (
          <span style={portraitMonogramStyle}>
            {artist.name.slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>
      <div style={heroTextColStyle}>
        <h1 style={titleStyle}>{artist.name}</h1>
        <div style={genreRowStyle}>
          {(() => {
            // De-dupe genre against tags (case-insensitive) so we don't
            // render the same chip twice when Last.fm's primary genre is
            // also the top tag.
            const seen = new Set<string>();
            const chips: string[] = [];
            const push = (label: string | null) => {
              if (!label) return;
              const key = label.toLowerCase();
              if (seen.has(key)) return;
              seen.add(key);
              chips.push(label);
            };
            push(artist.genre);
            for (const t of artist.tags) push(t);
            return chips.slice(0, 4).map((c) => (
              <span key={c} style={genrePillStyle}>
                {c}
              </span>
            ));
          })()}
        </div>
        {artist.bio_summary && <p style={bioStyle}>{artist.bio_summary}</p>}
      </div>
    </div>
  );
}

function StatStrip({ stats }: { stats: ListeningStats }) {
  const tiles: Array<{ label: string; value: string }> = [];
  tiles.push({
    label: 'Total plays',
    value: fmt(stats.total_scrobbles),
  });
  if (stats.first_scrobble_at) {
    tiles.push({
      label: 'First played',
      value: yearOf(stats.first_scrobble_at) ?? '—',
    });
  }
  if (stats.last_played_at) {
    tiles.push({
      label: 'Last played',
      value: timeAgo(stats.last_played_at),
    });
  }
  if (stats.all_time_rank) {
    tiles.push({
      label: 'All-time rank',
      value: `#${stats.all_time_rank}`,
    });
  }

  return (
    <div style={statStripStyle}>
      {tiles.map((t, i) => (
        <div key={i} style={statTileStyle}>
          <div style={statValueStyle}>{t.value}</div>
          <div style={statLabelStyle}>{t.label}</div>
        </div>
      ))}
    </div>
  );
}

function Sparkline({
  sparkline,
  accent,
}: {
  sparkline: NonNullable<SparklineSeries>;
  accent: string;
}) {
  const points = sparkline.points;
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.count), 1);
  const W = 600;
  const H = 56;
  const stepX = W / (points.length - 1);

  // Build smooth Catmull-Rom-style cubic path through every point.
  // Each segment's control points are derived from the tangent of the
  // neighboring points scaled by 1/4 — same smoothing approach used by
  // chart libs like Highcharts / Recharts when curve type is "spline".
  const xy = points.map((p, i) => ({
    x: i * stepX,
    y: H - (p.count / max) * (H - 4) - 2,
  }));
  const fmt = (n: number) => n.toFixed(1);
  let path = `M ${fmt(xy[0].x)} ${fmt(xy[0].y)}`;
  for (let i = 1; i < xy.length; i++) {
    const prev = xy[i - 1];
    const curr = xy[i];
    const before = xy[i - 2] ?? prev;
    const after = xy[i + 1] ?? curr;
    const cp1x = prev.x + (curr.x - before.x) / 6;
    const cp1y = prev.y + (curr.y - before.y) / 6;
    const cp2x = curr.x - (after.x - prev.x) / 6;
    const cp2y = curr.y - (after.y - prev.y) / 6;
    path += ` C ${fmt(cp1x)} ${fmt(cp1y)}, ${fmt(cp2x)} ${fmt(cp2y)}, ${fmt(curr.x)} ${fmt(curr.y)}`;
  }
  const areaPath = `${path} L ${fmt(W)} ${H} L 0 ${H} Z`;

  return (
    <div style={sparklineWrapStyle}>
      <div style={sparklineLabelStyle}>Plays per {sparkline.granularity}</div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={sparklineSvgStyle}
        aria-label={`Sparkline showing plays per ${sparkline.granularity} from ${points[0].at.slice(0, 4)} to ${points[points.length - 1].at.slice(0, 4)}`}
      >
        <path d={areaPath} fill={accent} fillOpacity={0.16} />
        <path
          d={path}
          fill="none"
          stroke={accent}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div style={sparklineAxisStyle}>
        <span>{points[0].at.slice(0, 4)}</span>
        <span>{points[points.length - 1].at.slice(0, 4)}</span>
      </div>
    </div>
  );
}

function TopTracks({
  tracks,
  accent,
  onOpen,
}: {
  tracks: TopTrack[];
  accent: string;
  onOpen?: (url: string) => void;
}) {
  return (
    <section style={sectionStyle}>
      <h2 style={sectionHeadingStyle}>Top tracks</h2>
      <ol style={tracksListStyle}>
        {tracks.slice(0, 5).map((t) => (
          <li key={t.id} style={trackRowStyle}>
            <Thumbnail
              image={t.image}
              transform={TRACK_TRANSFORM}
              size={TRACK_THUMB_PX}
              radius={4}
              alt=""
            />
            <div style={trackTextStyle}>
              <div style={trackTitleRowStyle}>
                <button
                  type="button"
                  onClick={() => {
                    const url = t.apple_music_url ?? null;
                    if (url) onOpen?.(url);
                  }}
                  style={{
                    ...trackNameStyle,
                    cursor: t.apple_music_url ? 'pointer' : 'default',
                  }}
                >
                  {t.name}
                </button>
                <span style={trackPlaysStyle}>
                  {fmt(t.scrobble_count)} plays
                </span>
              </div>
              {t.album_name && (
                <div style={trackAlbumStyle}>{t.album_name}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TopAlbums({
  albums,
  dominant,
  onOpen,
}: {
  albums: TopAlbum[];
  dominant: string;
  onOpen?: (url: string) => void;
}) {
  return (
    <section style={sectionStyle}>
      <h2 style={sectionHeadingStyle}>Top albums</h2>
      <div style={albumsGridStyle}>
        {albums.slice(0, 3).map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => a.apple_music_url && onOpen?.(a.apple_music_url)}
            style={{
              ...albumTileStyle,
              cursor: a.apple_music_url ? 'pointer' : 'default',
            }}
            aria-label={`${a.name} — ${fmt(a.playcount)} plays`}
          >
            <Thumbnail
              image={a.image}
              transform={ALBUM_TRANSFORM}
              size={ALBUM_TILE_PX}
              radius={6}
              alt={a.name}
              fallbackBg={dominant}
            />
            <div style={albumMetaStyle}>
              <div style={albumNameStyle}>{a.name}</div>
              <div style={albumPlaysStyle}>{fmt(a.playcount)} plays</div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function SimilarArtists({
  similar,
}: {
  similar: SimilarArtist[];
  // No URL on similar entries today — these are local artist refs without a
  // direct external link. Defer click-to-open until a tool surfaces a URL
  // for them (e.g. the artist's Apple Music page).
}) {
  return (
    <section style={sectionStyle}>
      <h2 style={sectionHeadingStyle}>You also listen to</h2>
      <div style={similarRowStyle}>
        {similar.slice(0, 5).map((s) => (
          <button
            key={s.id}
            type="button"
            // No URL on similar — these are local artist refs. Defer
            // click-to-open until tools surface a URL for them.
            style={similarChipStyle}
            aria-label={`${s.name} — ${fmt(s.your_scrobble_count)} plays`}
          >
            <Thumbnail
              image={s.image}
              transform={SIMILAR_TRANSFORM}
              size={SIMILAR_THUMB_PX}
              radius={999}
              alt={s.name}
            />
            <div style={similarTextStyle}>
              <div style={similarNameStyle}>{s.name}</div>
              <div style={similarCountStyle}>
                {fmt(s.your_scrobble_count)} plays
              </div>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function Footer({
  artist,
  accent,
  onOpen,
}: {
  artist: ArtistMeta;
  accent: string;
  onOpen?: (url: string) => void;
}) {
  return (
    <div style={footerStyle}>
      {artist.apple_music_url && (
        <button
          type="button"
          onClick={() => onOpen?.(artist.apple_music_url!)}
          style={{ ...footerPrimaryStyle, color: accent, borderColor: accent }}
        >
          Apple Music →
        </button>
      )}
      {artist.url && (
        <button
          type="button"
          onClick={() => onOpen?.(artist.url!)}
          style={footerSecondaryStyle}
        >
          Last.fm
        </button>
      )}
    </div>
  );
}

function Thumbnail({
  image,
  transform,
  size,
  radius,
  alt,
  fallbackBg,
}: {
  image: Image;
  transform: string;
  size: number;
  radius: number;
  alt: string;
  fallbackBg?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const src = buildSrc(image, transform);
  const accent = image?.accent_color ?? fallbackBg ?? 'rgba(127,127,127,0.18)';
  const dominant =
    image?.dominant_color ?? fallbackBg ?? 'rgba(127,127,127,0.10)';

  if (!src) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: `linear-gradient(135deg, ${dominant} 0%, ${accent} 100%)`,
          flexShrink: 0,
        }}
        aria-hidden
      />
    );
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        overflow: 'hidden',
        background: dominant,
        flexShrink: 0,
        position: 'relative',
      }}
    >
      {src.placeholder && (
        <img
          src={src.placeholder}
          alt=""
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(8px)',
            transform: 'scale(1.05)',
            opacity: loaded ? 0 : 1,
            transition: 'opacity 180ms ease',
          }}
        />
      )}
      <img
        src={src.src}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          opacity: loaded ? 1 : 0,
          transition: 'opacity 200ms ease',
        }}
      />
    </div>
  );
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  borderRadius: 12,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'var(--color-background-primary, transparent)',
};

const heroStyle: CSSProperties = {
  display: 'flex',
  gap: 18,
  alignItems: 'flex-start',
};

const portraitStyle: CSSProperties = {
  width: HERO_PORTRAIT_PX,
  height: HERO_PORTRAIT_PX,
  borderRadius: '50%',
  flexShrink: 0,
  position: 'relative',
  overflow: 'hidden',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const portraitImgStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

const portraitMonogramStyle: CSSProperties = {
  fontSize: 64,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.85)',
  textShadow: '0 2px 6px rgba(0,0,0,0.25)',
};

const heroTextColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const titleStyle: CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  margin: 0,
  lineHeight: 1.15,
  color: 'var(--color-text-primary, inherit)',
};

const genreRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 2,
};

const genrePillStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.3,
  padding: '3px 8px',
  borderRadius: 999,
  background: 'rgba(127,127,127,0.08)',
  color: 'var(--color-text-secondary, inherit)',
};

const bioStyle: CSSProperties = {
  margin: '4px 0 0',
  fontSize: 14,
  lineHeight: 1.5,
  opacity: 0.85,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 3,
  overflow: 'hidden',
  color: 'var(--color-text-primary, inherit)',
};

const statStripStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
  gap: 10,
  paddingTop: 8,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
};

const statTileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const statValueStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1.2,
  color: 'var(--color-text-primary, inherit)',
};

const statLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  opacity: 0.55,
  color: 'var(--color-text-secondary, inherit)',
};

const sparklineWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const sparklineLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const sparklineSvgStyle: CSSProperties = {
  width: '100%',
  height: 56,
  display: 'block',
};

const sparklineAxisStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 11,
  opacity: 0.5,
};

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingTop: 12,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
};

const sectionHeadingStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  margin: 0,
  opacity: 0.65,
};

const tracksListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const trackRowStyle: CSSProperties = {
  display: 'flex',
  // Top-align so the title + listens line up with the artwork's top edge,
  // and the album name reads as a sub-line beneath them.
  alignItems: 'flex-start',
  gap: 10,
};

const trackTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const trackTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 10,
};

const trackNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  lineHeight: 1.3,
  border: 'none',
  background: 'transparent',
  padding: 0,
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  // flex: 1 + minWidth: 0 lets the title shrink with ellipsis when the
  // listens count is on the same line and the track name is long.
  flex: 1,
  minWidth: 0,
};

const trackAlbumStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const trackPlaysStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
  flexShrink: 0,
};

const albumsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 8,
};

const albumTileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  // Tight gap between art and the name/plays meta block. The meta block
  // itself uses an even tighter gap so name + plays read as one lockup.
  gap: 6,
  padding: 0,
  border: 'none',
  background: 'transparent',
  textAlign: 'left',
  font: 'inherit',
  color: 'inherit',
  borderRadius: 8,
};

const albumMetaStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const albumNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.25,
  // 1-line clamp with ellipsis — long names like "SOUR (Video Version)"
  // and soundtrack titles wrap to 2 lines and offset their tiles, breaking
  // the grid alignment.
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--color-text-primary, inherit)',
};

const albumPlaysStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
  lineHeight: 1.25,
};

const similarRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
};

const similarChipStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 10px 4px 4px',
  borderRadius: 999,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.18))',
  background: 'transparent',
  font: 'inherit',
  color: 'inherit',
  cursor: 'default',
};

const similarTextStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
};

const similarNameStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.2,
};

const similarCountStyle: CSSProperties = {
  fontSize: 10,
  opacity: 0.55,
  lineHeight: 1.2,
};

const footerStyle: CSSProperties = {
  paddingTop: 12,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
};

const footerPrimaryStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
};

const footerSecondaryStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  padding: '8px 14px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
  opacity: 0.7,
  color: 'var(--color-text-secondary, inherit)',
};
