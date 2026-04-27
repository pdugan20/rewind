import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import type { TopTrackItem, TopTracksPayload } from './TopTracksGrid.js';

export type { TopTrackItem, TopTracksPayload };

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

export function TopTracksList({
  payload,
  onOpen,
}: {
  payload: TopTracksPayload;
  onOpen?: (url: string) => void;
}) {
  const filtered = payload.artist_id !== null && payload.data.length > 0;
  const heading = filtered
    ? `Top ${payload.data[0].detail} tracks`
    : 'Top tracks';
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
        <h1 style={titleStyle}>{heading}</h1>
        <div style={headerRightStyle}>
          {canGroup && <ViewToggle view={view} onChange={setView} />}
          <span style={periodStyle}>{periodLabel(payload.period)}</span>
        </div>
      </header>
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
          {albumGroups.map((g) => (
            <AlbumGroup key={g.albumKey} group={g} onOpen={onOpen} />
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
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div style={toggleWrapStyle} role="tablist" aria-label="View mode">
      <ToggleButton
        label="List"
        active={view === 'list'}
        onClick={() => onChange('list')}
      />
      <ToggleButton
        label="By album"
        active={view === 'album'}
        onClick={() => onChange('album')}
      />
    </div>
  );
}

function ToggleButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        ...toggleButtonStyle,
        ...(active ? toggleButtonActiveStyle : toggleButtonInactiveStyle),
      }}
    >
      {label}
    </button>
  );
}

function AlbumGroup({
  group,
  onOpen,
}: {
  group: AlbumGroupData;
  onOpen?: (url: string) => void;
}) {
  const tracksShown = group.tracks.length;
  const subParts: string[] = [];
  if (group.releasedYear) subParts.push(String(group.releasedYear));
  if (group.totalTracks) {
    subParts.push(`${tracksShown} of ${group.totalTracks} tracks`);
  } else if (tracksShown > 1) {
    subParts.push(`${tracksShown} tracks`);
  }
  subParts.push(`${group.totalPlays.toLocaleString()} plays`);
  const subline = subParts.join(' · ');

  const groupMax = Math.max(...group.tracks.map((t) => t.playcount), 1);

  return (
    <section style={albumGroupSectionStyle}>
      <div style={albumHeaderStyle}>
        <AlbumThumb image={group.albumImage} />
        <div style={albumHeaderTextStyle}>
          <div style={albumNameStyle}>{group.albumName ?? '(no album)'}</div>
          <div style={albumSubStyle}>{subline}</div>
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
                ...nameStyle,
                cursor: t.apple_music_url ? 'pointer' : 'default',
              }}
            >
              {t.name}
            </button>
            <div style={albumTrackCountColStyle}>
              <span style={countStyle}>{t.playcount.toLocaleString()}</span>
              <div style={barTrackStyle}>
                <div
                  style={{
                    ...barFillStyle,
                    width: `${(t.playcount / groupMax) * 100}%`,
                    background:
                      t.image?.accent_color ?? 'var(--color-accent, #4c6ef5)',
                  }}
                />
              </div>
            </div>
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
  const dominant = image?.dominant_color ?? 'rgba(127,127,127,0.10)';
  return (
    <div
      style={{
        width: ALBUM_HEADER_THUMB_PX,
        height: ALBUM_HEADER_THUMB_PX,
        borderRadius: 6,
        overflow: 'hidden',
        flexShrink: 0,
        background: dominant,
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
  const dominant = track.image?.dominant_color ?? 'rgba(127,127,127,0.10)';
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
          background: dominant,
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
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  flexWrap: 'wrap',
};

const headerRightStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const toggleWrapStyle: CSSProperties = {
  display: 'inline-flex',
  padding: 2,
  borderRadius: 999,
  background: 'rgba(127,127,127,0.10)',
  gap: 0,
};

const toggleButtonStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  padding: '4px 12px',
  border: 'none',
  borderRadius: 999,
  font: 'inherit',
  cursor: 'pointer',
  background: 'transparent',
  transition: 'background 120ms ease, color 120ms ease',
};

const toggleButtonActiveStyle: CSSProperties = {
  background: 'var(--color-background-primary, #fff)',
  color: 'var(--color-text-primary, inherit)',
  boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
};

const toggleButtonInactiveStyle: CSSProperties = {
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
  padding: '6px 12px',
  borderRadius: 999,
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.18))',
  background: 'transparent',
  font: 'inherit',
  cursor: 'pointer',
  flexShrink: 0,
};

const albumTrackListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  // Hang tracks under the album cover — indent matches the cover width
  // + the gap from albumHeaderStyle so the track name aligns with the
  // album name above it.
  paddingLeft: ALBUM_HEADER_THUMB_PX + 12,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const albumTrackRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const albumTrackCountColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
  width: 110,
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  margin: 0,
  color: 'var(--color-text-primary, inherit)',
};

const periodStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  opacity: 0.55,
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
