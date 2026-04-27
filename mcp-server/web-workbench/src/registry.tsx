import type { ReactNode } from 'react';

import { PosterGrid } from '../../web/components/PosterGrid';
import { ArticleList } from '../../web/components/ArticleList';
import { AlbumGrid } from '../../web/components/AlbumGrid';
import { ArtistGrid } from '../../web/components/ArtistGrid';
import { SeasonGrid } from '../../web/components/SeasonGrid';
import { GameCard } from '../../web/components/GameCard';
import { ArticleDetail } from '../../web/components/ArticleDetail';
import { ArtistDetail } from '../../web/components/ArtistDetail';
import { AthleteDetail } from '../../web/components/AthleteDetail';
import { TopTracks } from '../../web/components/TopTracks';

import {
  fixtures as recentWatchesFixtures,
  type RecentWatchesPayload,
} from '../../web/recent-watches.fixtures';
import {
  fixtures as recentReadsFixtures,
  type RecentReadsPayload,
} from '../../web/recent-reads.fixtures';
import {
  fixtures as topAlbumsFixtures,
  type TopAlbumsPayload,
} from '../../web/top-albums.fixtures';
import {
  fixtures as topArtistsFixtures,
  type TopArtistsPayload,
} from '../../web/top-artists.fixtures';
import { fixtures as attendedSeasonFixtures } from '../../web/attended-season.fixtures';
import { fixtures as attendedEventFixtures } from '../../web/attended-event.fixtures';
import { fixtures as articleFixtures } from '../../web/article.fixtures';
import { fixtures as artistFixtures } from '../../web/artist.fixtures';
import { fixtures as attendedPlayerFixtures } from '../../web/attended-player.fixtures';
import { fixtures as topTracksFixtures } from '../../web/top-tracks.fixtures';

import type { SeasonPayload } from '../../web/components/SeasonGrid';
import type { EventDetail } from '../../web/components/GameCard';
import type { ArticlePayload } from '../../web/components/ArticleDetail';
import type { ArtistPayload } from '../../web/components/ArtistDetail';
import type { AthletePayload } from '../../web/components/AthleteDetail';
import type { TopTracksPayload } from '../../web/components/TopTracks';

/**
 * Lazy raw-text loaders for each built bundle in web/dist/. The map is empty
 * until `npm run build:web` has produced the dist files; in that case
 * `getBuiltHtml()` returns null and the workbench surfaces a clear message.
 */
const distHtml = import.meta.glob('../../web/dist/*.html', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

function makeBuiltLoader(htmlFile: string): () => Promise<string | null> {
  const key = `../../web/dist/${htmlFile}`;
  return async () => {
    const loader = distHtml[key];
    if (!loader) return null;
    try {
      return await loader();
    } catch {
      return null;
    }
  };
}

/**
 * Default link handler used in workbench mode. In production the host
 * (Claude Desktop / iOS) intercepts `app.openLink({ url })`; here we just
 * open in a new tab and log so the designer can confirm a click fired.
 */
function defaultOpen(url: string): void {
  // eslint-disable-next-line no-console
  console.log('[workbench] openLink', url);
  window.open(url, '_blank', 'noopener,noreferrer');
}

export type ComponentEntry = {
  id: string;
  displayName: string;
  /** Tool that produces this UI in production, for orientation. */
  producedBy: string;
  /** Default suggested viewport when first selecting this component. */
  defaultViewport: 'mobile' | 'desktop';
  /** Hand-curated fixtures keyed by variant name. */
  fixtures: Record<string, unknown>;
  /** Renders the visual portion of the component for a given fixture. */
  render: (fixture: unknown) => ReactNode;
  /** Loads the production-built HTML bundle, or null if not yet built. */
  getBuiltHtml: () => Promise<string | null>;
};

export const COMPONENTS: ComponentEntry[] = [
  {
    id: 'recent-watches',
    displayName: 'Recent watches',
    producedBy: 'get_recent_watches',
    defaultViewport: 'desktop',
    fixtures: recentWatchesFixtures,
    getBuiltHtml: makeBuiltLoader('recent-watches.html'),
    render: (f) => {
      const p = f as RecentWatchesPayload;
      return <PosterGrid items={p.items} onOpen={defaultOpen} />;
    },
  },
  {
    id: 'recent-reads',
    displayName: 'Recent reads',
    producedBy: 'get_recent_reads',
    defaultViewport: 'desktop',
    fixtures: recentReadsFixtures,
    getBuiltHtml: makeBuiltLoader('recent-reads.html'),
    render: (f) => {
      const p = f as RecentReadsPayload;
      return <ArticleList items={p.items} onOpen={defaultOpen} />;
    },
  },
  {
    id: 'top-albums',
    displayName: 'Top albums',
    producedBy: 'get_top_albums',
    defaultViewport: 'desktop',
    fixtures: topAlbumsFixtures,
    getBuiltHtml: makeBuiltLoader('top-albums.html'),
    render: (f) => {
      const p = f as TopAlbumsPayload;
      return <AlbumGrid items={p.data} onOpen={defaultOpen} />;
    },
  },
  {
    id: 'top-artists',
    displayName: 'Top artists',
    producedBy: 'get_top_artists',
    defaultViewport: 'desktop',
    fixtures: topArtistsFixtures,
    getBuiltHtml: makeBuiltLoader('top-artists.html'),
    render: (f) => {
      const p = f as TopArtistsPayload;
      return <ArtistGrid items={p.data} onOpen={defaultOpen} />;
    },
  },
  {
    id: 'attended-season',
    displayName: 'Attended season',
    producedBy: 'get_attended_season',
    defaultViewport: 'desktop',
    fixtures: attendedSeasonFixtures,
    getBuiltHtml: makeBuiltLoader('attended-season.html'),
    render: (f) => <SeasonGrid payload={f as SeasonPayload} />,
  },
  {
    id: 'attended-event',
    displayName: 'Attended event',
    producedBy: 'get_attended_event',
    defaultViewport: 'desktop',
    fixtures: attendedEventFixtures,
    getBuiltHtml: makeBuiltLoader('attended-event.html'),
    render: (f) => <GameCard event={f as EventDetail} />,
  },
  {
    id: 'article',
    displayName: 'Article (single)',
    producedBy: 'get_article',
    defaultViewport: 'desktop',
    fixtures: articleFixtures,
    getBuiltHtml: makeBuiltLoader('article.html'),
    render: (f) => (
      <ArticleDetail payload={f as ArticlePayload} onOpen={defaultOpen} />
    ),
  },
  {
    id: 'artist',
    displayName: 'Artist (single)',
    producedBy: 'get_artist_details',
    defaultViewport: 'desktop',
    fixtures: artistFixtures,
    getBuiltHtml: makeBuiltLoader('artist.html'),
    render: (f) => (
      <ArtistDetail payload={f as ArtistPayload} onOpen={defaultOpen} />
    ),
  },
  {
    id: 'attended-player',
    displayName: 'Attended player (athlete)',
    producedBy: 'get_attended_player',
    defaultViewport: 'desktop',
    fixtures: attendedPlayerFixtures,
    getBuiltHtml: makeBuiltLoader('attended-player.html'),
    render: (f) => (
      <AthleteDetail payload={f as AthletePayload} onOpen={defaultOpen} />
    ),
  },
  {
    id: 'top-tracks',
    displayName: 'Top tracks',
    producedBy: 'get_top_tracks (artist filter)',
    defaultViewport: 'desktop',
    fixtures: topTracksFixtures,
    getBuiltHtml: makeBuiltLoader('top-tracks.html'),
    render: (f) => (
      <TopTracks payload={f as TopTracksPayload} onOpen={defaultOpen} />
    ),
  },
];
