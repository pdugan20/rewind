import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { timeAgo } from '../lib/time-ago.js';
import { cardOuterChrome, CARD_OUTER_CLASSNAME } from '../lib/card-tokens.js';
import { rewriteCdnImageUrl } from '../lib/cdn-image.js';

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
  genre: string | null;
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
// Album tiles render fluid (1fr in a 3-column grid → ~210px at 720px card
// width). Request 480px source so retina 2x stays sharp at the typical
// rendered size; Cloudflare Images caches the transform server-side.
const ALBUM_TRANSFORM = `width=480,height=480,fit=cover,format=auto,quality=85`;
const TRACK_THUMB_PX = 40;
const TRACK_TRANSFORM = `width=${TRACK_THUMB_PX * 2},height=${TRACK_THUMB_PX * 2},fit=cover,format=auto,quality=85`;
const SIMILAR_THUMB_PX = 40;
const SIMILAR_TRANSFORM = `width=${SIMILAR_THUMB_PX * 2},height=${SIMILAR_THUMB_PX * 2},fit=cover,format=auto,quality=85`;

function buildSrc(
  image: Image,
  transform: string
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = rewriteCdnImageUrl(base, transform);
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

  const [tab, setTab] = useState<Tab>('all');

  // Tab → section visibility. "Stats" pairs the stat strip with the
  // sparkline (numbers about your relationship to the artist); "Music"
  // pairs top tracks + top albums (their work, your favorites);
  // "Similar" is the connected-artists rail.
  const showStats = tab === 'all' || tab === 'stats';
  const showMusic = tab === 'all' || tab === 'music';
  const showSimilar = tab === 'all' || tab === 'similar';

  return (
    <article className={CARD_OUTER_CLASSNAME} style={cardStyle}>
      <Hero artist={artist} accent={accent} dominant={dominant} />
      <TabNav active={tab} onChange={setTab} accent={accent} />

      {showStats && <StatStrip stats={listening_stats} accent={accent} />}

      {showStats && sparkline && sparkline.points.length > 1 && (
        <Sparkline sparkline={sparkline} accent={accent} />
      )}

      {showMusic && top_tracks.length > 0 && (
        <TopTracks tracks={top_tracks} accent={accent} onOpen={onOpen} />
      )}

      {showMusic && top_albums.length > 0 && (
        <TopAlbums albums={top_albums} dominant={dominant} onOpen={onOpen} />
      )}

      {showSimilar && similar_artists.length > 0 && (
        <SimilarArtists similar={similar_artists} />
      )}

      <Footer artist={artist} onOpen={onOpen} />
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
            // Cap at 3 — 4 reliably wraps on common name lengths.
            return chips.slice(0, 3).map((c) => (
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

type Tab = 'all' | 'stats' | 'music' | 'similar';

function TabNav({
  active,
  onChange,
  accent,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  accent: string;
}) {
  const tabs: Array<[Tab, string]> = [
    ['all', 'All'],
    ['stats', 'Stats'],
    ['music', 'Music'],
    ['similar', 'Similar'],
  ];
  return (
    <nav style={tabNavStyle}>
      {tabs.map(([id, label]) => {
        const isActive = id === active;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            style={{
              ...tabButtonStyle,
              color: isActive ? accent : 'inherit',
              opacity: isActive ? 1 : 0.55,
              borderBottomColor: isActive ? accent : 'transparent',
            }}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function StatStrip({
  stats,
  accent,
}: {
  stats: ListeningStats;
  accent: string;
}) {
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
          <div style={statLabelStyle}>{t.label}</div>
          <div style={{ ...statValueStyle, color: accent }}>{t.value}</div>
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
            <FluidThumbnail
              image={a.image}
              transform={ALBUM_TRANSFORM}
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
      <h2 style={sectionHeadingStyle}>Similar artists you’ve played</h2>
      <ol style={similarListStyle}>
        {similar.slice(0, 5).map((s) => (
          <li key={s.id} style={similarRowItemStyle}>
            <Thumbnail
              image={s.image}
              transform={SIMILAR_TRANSFORM}
              size={SIMILAR_THUMB_PX}
              radius={999}
              alt={s.name}
            />
            <div style={similarTextColStyle}>
              <div style={similarTitleRowStyle}>
                <div style={similarNameStyle}>{s.name}</div>
                <span style={similarCountStyle}>
                  {fmt(s.your_scrobble_count)} plays
                </span>
              </div>
              {s.genre && <div style={similarGenreStyle}>{s.genre}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Footer({
  artist,
  onOpen,
}: {
  artist: ArtistMeta;
  onOpen?: (url: string) => void;
}) {
  if (!artist.apple_music_url) return null;
  return (
    <div style={footerStyle}>
      <button
        type="button"
        onClick={() => onOpen?.(artist.apple_music_url!)}
        style={appleMusicButtonStyle}
      >
        <span style={appleMusicLabelStyle}>Listen on</span>
        <AppleMusicLogo />
      </button>
    </div>
  );
}

// Apple Music wordmark (white when color is set on the parent button).
// Inlined here so the bundle stays a single self-contained HTML file —
// vite-plugin-singlefile inlines all assets anyway, and a 1.7KB SVG is
// cheaper as inline JSX than as a separately-loaded file.
function AppleMusicLogo() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 84.3 20.7"
      aria-label="Apple Music"
      role="img"
      style={appleMusicLogoStyle}
    >
      <path
        fill="currentColor"
        d="M35.4,20.1V6.6h-0.1l-5.4,13.5h-2.1L22.4,6.6h-0.1v13.5h-2.5V1.8H23l5.8,14.6h0.1l5.8-14.6H38v18.3L35.4,20.1L35.4,20.1z M52.1,20.1h-2.6v-2.3h-0.1c-0.7,1.6-2.1,2.5-4.1,2.5c-2.9,0-4.6-1.9-4.6-5V6.7h2.7v8.1c0,2,1,3.1,2.8,3.1c2,0,3.1-1.4,3.1-3.5V6.7h2.7L52.1,20.1L52.1,20.1z M59.5,6.5c3.1,0,5,1.7,5.1,4.2h-2.5c-0.2-1.3-1.1-2.1-2.6-2.1C58,8.6,57,9.3,57,10.4c0,0.8,0.6,1.4,2,1.7l2.1,0.5c2.7,0.6,3.7,1.7,3.7,3.6c0,2.4-2.2,4.1-5.3,4.1c-3.3,0-5.3-1.6-5.5-4.2h2.7c0.2,1.4,1.2,2.1,2.8,2.1c1.6,0,2.6-0.7,2.6-1.8c0-0.9-0.5-1.4-1.9-1.7l-2.1-0.5c-2.5-0.6-3.7-1.8-3.7-3.8C54.4,8.1,56.4,6.5,59.5,6.5z M66.8,3.2c0-0.9,0.7-1.6,1.6-1.6c0.9,0,1.6,0.7,1.6,1.6c0,0.9-0.7,1.6-1.6,1.6C67.5,4.8,66.8,4.1,66.8,3.2L66.8,3.2z M67,6.7h2.7v13.4H67V6.7z M81.1,11.3c-0.3-1.4-1.3-2.6-3.1-2.6c-2.1,0-3.5,1.8-3.5,4.6c0,2.9,1.4,4.6,3.5,4.6c1.7,0,2.7-0.9,3.1-2.5h2.6c-0.3,2.8-2.5,4.8-5.7,4.8c-3.8,0-6.2-2.6-6.2-6.9c0-4.2,2.4-6.9,6.2-6.9c3.4,0,5.4,2.2,5.7,4.8L81.1,11.3L81.1,11.3z M11.5,3.6C10.8,4.4,9.7,5.1,8.6,5C8.4,3.8,9,2.6,9.6,1.9c0.7-0.9,1.9-1.5,2.9-1.5C12.6,1.5,12.2,2.7,11.5,3.6L11.5,3.6z M12.5,5.2c0.6,0,2.4,0.2,3.6,2c-0.1,0.1-2.1,1.3-2.1,3.8c0,3,2.6,4,2.6,4c0,0.1-0.4,1.4-1.3,2.8c-0.8,1.2-1.7,2.4-3,2.4c-1.3,0-1.7-0.8-3.2-0.8c-1.5,0-2,0.8-3.2,0.8c-1.3,0-2.3-1.3-3.1-2.5c-1.7-2.5-3-7-1.2-10c0.8-1.5,2.4-2.5,4-2.5c1.3,0,2.5,0.9,3.2,0.9C9.5,6.1,10.9,5.1,12.5,5.2L12.5,5.2z"
      />
    </svg>
  );
}

function FluidThumbnail({
  image,
  transform,
  radius,
  alt,
  fallbackBg: _fallbackBg,
}: {
  image: Image;
  transform: string;
  radius: number;
  alt: string;
  fallbackBg?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const src = buildSrc(image, transform);

  // Same canonical border + neutral fill as the other card thumbnails.
  // No brand-color background — neutral until the image loads, then
  // the image covers it.
  const baseStyle: CSSProperties = {
    width: '100%',
    aspectRatio: '1 / 1',
    borderRadius: radius,
    overflow: 'hidden',
    position: 'relative',
    background: 'rgba(127,127,127,0.06)',
    border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
    boxSizing: 'border-box',
  };

  if (!src) {
    return <div style={baseStyle} aria-hidden />;
  }
  return (
    <div style={baseStyle}>
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
          position: 'absolute',
          inset: 0,
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

function Thumbnail({
  image,
  transform,
  size,
  radius,
  alt,
  fallbackBg: _fallbackBg,
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

  // Same canonical border + neutral fill as the other card thumbnails.
  const baseStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    overflow: 'hidden',
    background: 'rgba(127,127,127,0.06)',
    border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
    boxSizing: 'border-box',
    flexShrink: 0,
    position: 'relative',
  };

  if (!src) {
    return <div style={baseStyle} aria-hidden />;
  }
  return (
    <div style={baseStyle}>
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
  // Larger inter-section gap (vs the original 18) since the section
  // dividers were dropped — whitespace is what separates the bands now.
  gap: 28,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  ...cardOuterChrome,
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

// Single line, no wrap, no scroll. Caller caps the chip count at a
// number that's known to fit common name widths — see the slice in
// the renderer.
const genreRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'nowrap',
  gap: 6,
  marginTop: 2,
  overflow: 'hidden',
};

const genrePillStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.3,
  padding: '3px 8px',
  borderRadius: 999,
  background: 'rgba(127,127,127,0.08)',
  color: 'var(--color-text-secondary, inherit)',
  whiteSpace: 'nowrap',
  flexShrink: 0,
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

// Tab nav — bleeds horizontally to the outer card edge so the
// bottom hairline reads as a section divider. Mirrors the athlete
// card's nav. CARD_PADDING_X must match cardStyle's horizontal pad.
const CARD_PADDING_X = 22;

const tabNavStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  marginLeft: -CARD_PADDING_X,
  marginRight: -CARD_PADDING_X,
  paddingLeft: CARD_PADDING_X,
  paddingRight: CARD_PADDING_X,
  borderBottom: '1px solid rgba(127,127,127,0.12)',
  // Pull tighter to the hero block above — the nav reads as a
  // continuation of the header, not its own band.
  marginTop: -7,
};

const tabButtonStyle: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  borderBottom: '2px solid transparent',
  padding: '8px 12px',
  marginBottom: -1,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  cursor: 'pointer',
  fontFamily: 'inherit',
  transition: 'color 120ms ease, opacity 120ms ease',
};

// Boxed treatment — matches HitterStatBlock cells: label on top, value
// big below, faint gray pod, gap-8 between cells. Same visual language
// as the splits/season blocks in the sports cards.
const statStripStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
  gap: 8,
  marginTop: -8,
};

const statTileStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  borderRadius: 10,
  background: 'rgba(127,127,127,0.06)',
};

const statValueStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1.1,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -0.3,
};

const statLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
  color: 'var(--color-text-secondary, inherit)',
};

const sparklineWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
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
  // Inherit host body font first, then override font-size to be 1px
  // smaller than the inherited size. Order matters: `font: inherit` is
  // a shorthand that resets all font longhands, so explicit fontSize
  // must come AFTER it to win.
  font: 'inherit',
  fontSize: 'calc(1em - 1px)',
  lineHeight: 1.3,
  border: 'none',
  background: 'transparent',
  padding: 0,
  textAlign: 'left',
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
  gap: 14,
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

const similarListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const similarRowItemStyle: CSSProperties = {
  display: 'flex',
  // Top-align like top-tracks rows so the name + count line up with the
  // top of the avatar and the genre reads as a sub-line beneath them.
  alignItems: 'flex-start',
  gap: 10,
};

const similarTextColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const similarTitleRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 10,
};

const similarNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  // Inherit body font (family + weight) from the host, then dial size
  // down by 1px relative to whatever Claude Desktop / iOS sets as the
  // body size. calc(1em - 1px) is "inherited size − 1" regardless of
  // host font size.
  font: 'inherit',
  fontSize: 'calc(1em - 1px)',
  lineHeight: 1.3,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--color-text-primary, inherit)',
};

const similarGenreStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const similarCountStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
  flexShrink: 0,
};

const footerStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
  marginTop: -4,
};

const appleMusicButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  width: '100%',
  padding: '12px 16px',
  borderRadius: 999,
  border: 'none',
  // Inverts with theme — black-on-white light, white-on-black dark.
  background: 'var(--color-text-primary, #000)',
  color: 'var(--card-bg, #fff)',
  cursor: 'pointer',
  font: 'inherit',
};

const appleMusicLabelStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 500,
  letterSpacing: 0.1,
  lineHeight: 1,
};

const appleMusicLogoStyle: CSSProperties = {
  height: 16,
  // Width derives from viewBox aspect; height controls the visual size.
  width: 'auto',
  display: 'block',
};
