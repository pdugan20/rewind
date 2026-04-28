import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

export type TopTrackItem = {
  rank: number;
  id: number;
  name: string;
  detail: string;
  album_id?: number | null;
  album_name?: string | null;
  album_apple_music_url?: string | null;
  album_released_year?: number | null;
  album_total_tracks?: number | null;
  playcount: number;
  image: Image;
  url: string;
  apple_music_url: string | null;
  preview_url?: string | null;
};

export type TopTracksPayload = {
  period: string;
  artist_id: number | null;
  data: TopTrackItem[];
};

const THUMB_PX = 44;
const TRANSFORM = `width=${THUMB_PX * 2},height=${THUMB_PX * 2},fit=cover,format=auto,quality=85`;

function buildSrc(image: TopTrackItem['image']) {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = base.includes('?')
    ? `${base.split('?')[0]}?${TRANSFORM}`
    : `${base}?${TRANSFORM}`;
  return {
    src: transformed,
    placeholder: thumbhashToDataUrl(image.thumbhash ?? null),
  };
}

function periodLabel(period: string): string {
  switch (period) {
    case '7day':
      return 'Last 7 days';
    case '1month':
      return 'Last month';
    case '3month':
      return 'Last 3 months';
    case '6month':
      return 'Last 6 months';
    case '12month':
      return 'Last 12 months';
    case 'overall':
      return 'All time';
    default:
      return period;
  }
}

type ViewMode = 'list' | 'album';

// Toggle visual treatment. 'A' is the canonical pick — full-width faint
// pill with active half slightly raised. 'C' is preserved as a fallback
// option (flush-edge bordered button pair) in case we ever decide the
// pill feels too soft in a darker host theme. B (inline text + separator)
// and D (right-aligned chips) were prototyped during the picker pass but
// archived.
export type ToggleVariant = 'A' | 'C';

export function TopTracks({
  payload,
  onOpen,
  toggleVariant = 'A',
}: {
  payload: TopTracksPayload;
  onOpen?: (url: string) => void;
  toggleVariant?: ToggleVariant;
}) {
  const filtered = payload.artist_id !== null && payload.data.length > 0;
  const title = filtered ? payload.data[0].detail : 'Top tracks';
  const subtitle = filtered
    ? `Top tracks · ${periodLabel(payload.period)}`
    : periodLabel(payload.period);
  const maxPlaycount = Math.max(...payload.data.map((t) => t.playcount), 1);

  // Group + collect distinct album count to gate the toggle. Only show
  // the album-mode option when there's more than one album to group by —
  // otherwise the toggle is meaningless.
  const albumGroups = groupByAlbum(payload.data);
  const distinctAlbumCount = albumGroups.length;
  const canGroup = distinctAlbumCount > 1;

  const [view, setView] = useState<ViewMode>('list');
  const effectiveView = canGroup ? view : 'list';

  return (
    <section style={cardStyle}>
      <header style={headerStyle}>
        <h1 style={titleStyle}>{title}</h1>
        <div style={subtitleStyle}>{subtitle}</div>
      </header>
      {canGroup && (
        <ViewToggle view={view} onChange={setView} variant={toggleVariant} />
      )}
      {effectiveView === 'list' ? (
        <ol style={listStyle}>
          {payload.data.map((t) => (
            <Row
              key={t.id}
              track={t}
              filtered={filtered}
              maxPlaycount={maxPlaycount}
              onOpen={onOpen}
            />
          ))}
        </ol>
      ) : (
        <div style={albumGroupsContainerStyle}>
          {albumGroups.map((g, i) => (
            <AlbumGroup
              key={g.albumKey}
              group={g}
              isFirst={i === 0}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface AlbumGroupData {
  albumKey: string; // composite (id ?? name) so untitled albums still group
  albumId: number | null;
  albumName: string | null;
  albumImage: TopTrackItem['image'];
  albumAppleMusicUrl: string | null;
  releasedYear: number | null;
  totalTracks: number | null;
  totalPlays: number;
  tracks: TopTrackItem[];
}

function groupByAlbum(items: TopTrackItem[]): AlbumGroupData[] {
  const map = new Map<string, AlbumGroupData>();
  for (const t of items) {
    const key =
      t.album_id != null
        ? `id:${t.album_id}`
        : `name:${t.album_name ?? '(no album)'}`;
    let g = map.get(key);
    if (!g) {
      g = {
        albumKey: key,
        albumId: t.album_id ?? null,
        albumName: t.album_name ?? null,
        albumImage: t.image, // first track's image is the album art
        albumAppleMusicUrl: t.album_apple_music_url ?? null,
        releasedYear: t.album_released_year ?? null,
        totalTracks: t.album_total_tracks ?? null,
        totalPlays: 0,
        tracks: [],
      };
      map.set(key, g);
    }
    g.tracks.push(t);
    g.totalPlays += t.playcount;
  }
  // Sort groups by total plays desc; tracks within a group already arrive
  // sorted by playcount desc from the route.
  return [...map.values()].sort((a, b) => b.totalPlays - a.totalPlays);
}

function ViewToggle({
  view,
  onChange,
  variant,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
  variant: ToggleVariant;
}) {
  const items: Array<{ key: ViewMode; label: string }> = [
    { key: 'list', label: 'List' },
    { key: 'album', label: 'By album' },
  ];

  // ── A: faint filled pill, full-width (Spotify Wrapped feel) ──────
  if (variant === 'A') {
    return (
      <div style={pillWrapAStyle} role="tablist" aria-label="View mode">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            role="tab"
            aria-selected={view === it.key}
            onClick={() => onChange(it.key)}
            style={{
              ...pillButtonAStyle,
              ...(view === it.key
                ? pillButtonAActiveStyle
                : pillButtonAInactiveStyle),
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    );
  }

  // ── C: flush-edge bordered button pair (archived fallback) ───────
  return (
    <div style={flushWrapCStyle} role="tablist" aria-label="View mode">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="tab"
          aria-selected={view === it.key}
          onClick={() => onChange(it.key)}
          style={{
            ...flushButtonCStyle,
            ...(view === it.key
              ? flushButtonCActiveStyle
              : flushButtonCInactiveStyle),
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function AlbumGroup({
  group,
  isFirst,
  onOpen,
}: {
  group: AlbumGroupData;
  isFirst: boolean;
  onOpen?: (url: string) => void;
}) {
  const tracksShown = group.tracks.length;

  // Single-line subtitle in user-preferred order: year · plays · tracks-ratio.
  // Tracks shortened to "12 of 20" (no "tracks" word) to keep the line tight
  // while still reading in the album-grouped context.
  const subParts: string[] = [];
  if (group.releasedYear) subParts.push(String(group.releasedYear));
  subParts.push(`${group.totalPlays.toLocaleString()} plays`);
  if (group.totalTracks) {
    subParts.push(`${tracksShown} of ${group.totalTracks}`);
  } else if (tracksShown > 1) {
    subParts.push(`${tracksShown} tracks`);
  }
  const subLine = subParts.join(' · ');

  const groupMax = Math.max(...group.tracks.map((t) => t.playcount), 1);

  return (
    <section style={isFirst ? albumGroupFirstStyle : albumGroupSectionStyle}>
      <div style={albumHeaderStyle}>
        <AlbumThumb image={group.albumImage} />
        <div style={albumHeaderTextStyle}>
          <div style={albumNameStyle}>{group.albumName ?? '(no album)'}</div>
          <div style={albumSubStyle}>{subLine}</div>
        </div>
        {group.albumAppleMusicUrl && (
          <button
            type="button"
            onClick={() => onOpen?.(group.albumAppleMusicUrl!)}
            style={albumCtaStyle}
            aria-label={`Listen to ${group.albumName ?? 'album'} on Apple Music`}
          >
            Listen ↗
          </button>
        )}
      </div>
      <ol style={albumTrackListStyle}>
        {group.tracks.map((t) => (
          <li key={t.id} style={albumTrackRowStyle}>
            <button
              type="button"
              onClick={() => t.apple_music_url && onOpen?.(t.apple_music_url)}
              style={{
                ...albumTrackNameStyle,
                cursor: t.apple_music_url ? 'pointer' : 'default',
              }}
            >
              {t.name}
            </button>
            <div style={albumTrackBarStyle}>
              <div
                style={{
                  ...barFillStyle,
                  width: `${(t.playcount / groupMax) * 100}%`,
                  background:
                    t.image?.accent_color ?? 'var(--color-accent, #4c6ef5)',
                }}
              />
            </div>
            <span style={albumTrackCountStyle}>
              {t.playcount.toLocaleString()}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const ALBUM_HEADER_THUMB_PX = 56;

function AlbumThumb({ image }: { image: TopTrackItem['image'] }) {
  const [loaded, setLoaded] = useState(false);
  const src = buildSrc(image);
  return (
    <div
      style={{
        width: ALBUM_HEADER_THUMB_PX,
        height: ALBUM_HEADER_THUMB_PX,
        borderRadius: 6,
        overflow: 'hidden',
        flexShrink: 0,
        background: 'rgba(127,127,127,0.06)',
        border:
          '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      {src && src.placeholder && (
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
      {src && (
        <img
          src={src.src}
          alt=""
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
      )}
    </div>
  );
}

function Row({
  track,
  filtered,
  maxPlaycount,
  onOpen,
}: {
  track: TopTrackItem;
  filtered: boolean;
  maxPlaycount: number;
  onOpen?: (url: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const src = buildSrc(track.image);
  const accent = track.image?.accent_color ?? 'var(--color-accent, #4c6ef5)';
  const sub = filtered ? track.album_name : track.detail;
  const clickable = Boolean(track.apple_music_url);
  const barPct = (track.playcount / maxPlaycount) * 100;

  return (
    <li style={rowStyle}>
      <div
        style={{
          width: THUMB_PX,
          height: THUMB_PX,
          borderRadius: 4,
          overflow: 'hidden',
          flexShrink: 0,
          background: 'rgba(127,127,127,0.06)',
          border:
            '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
          boxSizing: 'border-box',
          position: 'relative',
        }}
      >
        {src && src.placeholder && (
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
        {src && (
          <img
            src={src.src}
            alt=""
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
        )}
      </div>
      <div style={textColStyle}>
        <button
          type="button"
          onClick={() =>
            track.apple_music_url && onOpen?.(track.apple_music_url)
          }
          style={{
            ...nameStyle,
            cursor: clickable ? 'pointer' : 'default',
          }}
        >
          {track.name}
        </button>
        {sub && <div style={subStyle}>{sub}</div>}
      </div>
      <div style={countColStyle}>
        <span style={countStyle}>{track.playcount.toLocaleString()}</span>
        <div style={barTrackStyle}>
          <div
            style={{
              ...barFillStyle,
              width: `${barPct}%`,
              background: accent,
            }}
          />
        </div>
      </div>
    </li>
  );
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  maxWidth: 720,
  margin: '0 auto',
  padding: '20px 22px 22px',
  borderRadius: 12,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'var(--color-background-primary, transparent)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const subtitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.75,
};

// ─── Variant A: faint filled pill, full-width ───────────────────────
const pillWrapAStyle: CSSProperties = {
  display: 'flex',
  width: '100%',
  padding: 3,
  borderRadius: 999,
  background: 'rgba(127,127,127,0.08)',
  gap: 0,
};

const pillButtonAStyle: CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontWeight: 500,
  padding: '6px 0',
  border: 'none',
  borderRadius: 999,
  background: 'transparent',
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'center',
  transition: 'background 120ms ease, color 120ms ease',
};

const pillButtonAActiveStyle: CSSProperties = {
  background: 'var(--color-background-primary, #fff)',
  color: 'var(--color-text-primary, inherit)',
  boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
};

const pillButtonAInactiveStyle: CSSProperties = {
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
};

// ─── Variant C: flush-edge text buttons with faint active bg ────────
const flushWrapCStyle: CSSProperties = {
  display: 'flex',
  width: '100%',
  borderRadius: 6,
  overflow: 'hidden',
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
};

const flushButtonCStyle: CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontWeight: 500,
  padding: '8px 12px',
  border: 'none',
  background: 'transparent',
  font: 'inherit',
  cursor: 'pointer',
  textAlign: 'center',
  transition: 'background 120ms ease, color 120ms ease',
};

const flushButtonCActiveStyle: CSSProperties = {
  background: 'rgba(127,127,127,0.06)',
  color: 'var(--color-text-primary, inherit)',
};

const flushButtonCInactiveStyle: CSSProperties = {
  background: 'transparent',
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
};

const albumGroupsContainerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
};

const albumGroupSectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingTop: 12,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
};

// First album in the list — same layout, no top divider (the toggle bar
// already sits as the visual seam above it).
const albumGroupFirstStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  paddingTop: 0,
};

const albumHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const albumHeaderTextStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const albumNameStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.25,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--color-text-primary, inherit)',
};

const albumSubStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const albumCtaStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: '6px 14px',
  borderRadius: 999,
  border: 'none',
  background: '#000',
  color: '#fff',
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

const albumTrackListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  // Tracks align flush-left with the album cover's left edge — keeps the
  // group visually anchored. Bar and count sit inline to the right.
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
};

const albumTrackRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const albumTrackNameStyle: CSSProperties = {
  // Name takes the leftover row width — bar + count are fixed-width and
  // right-aligned, so the name absorbs the slack and ellipsises if long.
  flex: 1,
  minWidth: 0,
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
};

// Bar pinned to a fixed width so all rows align vertically — visual scan
// down the column compares plays at a glance.
const albumTrackBarStyle: CSSProperties = {
  width: 80,
  height: 3,
  background: 'rgba(127,127,127,0.18)',
  borderRadius: 2,
  overflow: 'hidden',
  flexShrink: 0,
};

const albumTrackCountStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
  flexShrink: 0,
  // Width sized for ~3-digit counts (covers 99% of plays); 4-digit
  // counts are rare and will just edge slightly past — tabular-nums
  // keeps the digits aligned across rows either way.
  minWidth: 24,
  textAlign: 'right',
};

const titleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  margin: 0,
  color: 'var(--color-text-primary, inherit)',
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 4px',
  borderRadius: 6,
};

const textColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
};

const nameStyle: CSSProperties = {
  // Match artist card track row: inherit body font (family + weight)
  // then dial 1px smaller. Order matters — `font: inherit` is a shorthand
  // that resets fontSize/fontWeight, so the explicit override must come
  // AFTER the shorthand to win.
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
};

const subStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const countColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
  width: 110,
  flexShrink: 0,
};

const countStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--color-text-secondary, inherit)',
  opacity: 0.7,
};

const barTrackStyle: CSSProperties = {
  height: 3,
  width: '100%',
  background: 'rgba(127,127,127,0.18)',
  borderRadius: 2,
  overflow: 'hidden',
};

const barFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  transition: 'width 240ms ease',
};
