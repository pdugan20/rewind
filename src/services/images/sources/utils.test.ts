import { describe, it, expect } from 'vitest';
import {
  cleanArtistName,
  cleanAlbumName,
  artistMatches,
  artistIdentityMatches,
  albumMatches,
  trackMatches,
} from './utils.js';

describe('cleanAlbumName', () => {
  it('retains title disambiguation beside an edition label', () => {
    expect(cleanAlbumName('Synthetic (White Album - Deluxe Edition)')).toBe(
      'Synthetic (White Album)'
    );
    expect(cleanAlbumName('Synthetic (Deep Cuts)')).toBe(
      'Synthetic (Deep Cuts)'
    );
  });
  it('strips deluxe edition parenthetical', () => {
    expect(
      cleanAlbumName('Ill Communication (Deluxe Edition/Remastered)')
    ).toBe('Ill Communication');
  });

  it('strips remastered bracket suffix', () => {
    expect(cleanAlbumName('Hello Nasty [Deluxe Edition/Remastered]')).toBe(
      'Hello Nasty'
    );
  });

  it('strips EP/Single dash suffix', () => {
    expect(cleanAlbumName('Too Many Rappers - Single')).toBe(
      'Too Many Rappers'
    );
  });

  it('preserves normal album names', () => {
    expect(cleanAlbumName('Hot Sauce Committee Part Two')).toBe(
      'Hot Sauce Committee Part Two'
    );
  });

  it('strips anniversary edition', () => {
    expect(
      cleanAlbumName("Paul's Boutique (20th Anniversary Edition / Remastered)")
    ).toBe("Paul's Boutique");
  });

  it('rewrites ampersand to "and" in album titles', () => {
    expect(cleanAlbumName('Hall & Oates Greatest Hits')).toBe(
      'Hall and Oates Greatest Hits'
    );
  });
});

describe('cleanArtistName', () => {
  it('strips feat. suffix', () => {
    expect(cleanArtistName('Gorillaz feat. IDLES')).toBe('Gorillaz');
  });

  it('strips ft. suffix', () => {
    expect(cleanArtistName('Kendrick Lamar ft. SZA')).toBe('Kendrick Lamar');
  });

  it('strips featuring suffix', () => {
    expect(cleanArtistName('Drake featuring Future')).toBe('Drake');
  });

  it('preserves names without featured artists', () => {
    expect(cleanArtistName('The Black Keys')).toBe('The Black Keys');
  });

  it('rewrites ampersand to "and" for upstream search recall', () => {
    expect(cleanArtistName('Simon & Garfunkel')).toBe('Simon and Garfunkel');
    expect(cleanArtistName('Matt & Kim')).toBe('Matt and Kim');
  });
});

describe('artistMatches', () => {
  it('matches exact names', () => {
    expect(artistMatches('Gorillaz', 'Gorillaz')).toBe(true);
  });

  it('matches case-insensitive', () => {
    expect(artistMatches('the black keys', 'The Black Keys')).toBe(true);
  });

  it('matches when returned has extra words (feat)', () => {
    expect(artistMatches('Gorillaz', 'Gorillaz feat. IDLES')).toBe(true);
  });

  it('matches when requested has extra "The" prefix', () => {
    expect(artistMatches('The Black Keys', 'Black Keys')).toBe(true);
  });

  it('rejects completely different artists', () => {
    expect(artistMatches('Gorillaz', 'The Countdown Kids')).toBe(false);
  });

  it('rejects partial word matches', () => {
    expect(artistMatches('Zero 7', 'Imagine Dragons')).toBe(false);
  });

  it('strips feat before comparing', () => {
    expect(artistMatches('Gorillaz feat. Popcaan', 'Gorillaz')).toBe(true);
  });

  // Key regression: "The Animals" must NOT match "Glass Animals"
  it('rejects Glass Animals for The Animals', () => {
    expect(artistMatches('The Animals', 'Glass Animals')).toBe(false);
  });

  it('rejects Buddy for Buddy Holly', () => {
    expect(artistMatches('Buddy Holly', 'Buddy')).toBe(false);
  });

  // Ampersand vs "and" normalization: catalogs sometimes index "Matt & Kim"
  // and sometimes "Matt and Kim". Both forms should match each way.
  it('matches ampersand against spelled-out "and"', () => {
    expect(artistMatches('Matt & Kim', 'Matt and Kim')).toBe(true);
    expect(artistMatches('Matt and Kim', 'Matt & Kim')).toBe(true);
    expect(artistMatches('Simon & Garfunkel', 'Simon and Garfunkel')).toBe(
      true
    );
  });
});

describe('artistIdentityMatches', () => {
  it('folds stylized accents that catalogs add to plain names', () => {
    expect(artistIdentityMatches('JAY-Z', 'JAŸ-Z')).toBe(true);
    expect(artistIdentityMatches('Bjork', 'Björk')).toBe(true);
    expect(artistMatches('JAY-Z', 'JAŸ-Z')).toBe(true);
  });
  it('still requires the same artist', () => {
    expect(artistIdentityMatches('JAY-Z', 'Jay Rock')).toBe(false);
    expect(artistIdentityMatches('JAY-Z', 'JAŸ-Z & Kanye West')).toBe(false);
  });
});

describe('albumMatches', () => {
  it('rejects an unqualified self-title and conflicting album qualifiers', () => {
    expect(albumMatches('Synthetic', 'Synthetic (Black Album)')).toBe(false);
    expect(
      albumMatches(
        'Synthetic (White Album - Deluxe Edition)',
        'Synthetic (Green Album)'
      )
    ).toBe(false);
    expect(
      albumMatches(
        'Synthetic (White Album - Deluxe Edition)',
        'Synthetic (White Album)'
      )
    ).toBe(true);
  });
  it('rejects arbitrary title extensions, types, and alternate performances', () => {
    expect(albumMatches('Gold', 'Gold Greatest Hits')).toBe(false);
    expect(albumMatches('Synthetic', 'Synthetic - Single')).toBe(false);
    expect(albumMatches('Synthetic', 'Synthetic (Live)')).toBe(false);
    expect(albumMatches('Synthetic', 'Synthetic (Special)')).toBe(false);
    expect(albumMatches('Synthetic', 'Synthetic (Bonus)')).toBe(false);
  });
  it('retains non-Latin identity and rejects different non-Latin titles', () => {
    expect(albumMatches('夜の音', '夜の音 (Deluxe Edition)')).toBe(true);
    expect(albumMatches('夜の音', '朝の音')).toBe(false);
  });
  it('matches exact names', () => {
    expect(albumMatches('Blue', 'Blue')).toBe(true);
  });

  it('matches deluxe variants', () => {
    expect(albumMatches('GUTS', 'GUTS (Deluxe)')).toBe(true);
  });

  it('matches when returned is superset with extra words', () => {
    expect(albumMatches('The Mountain', 'The Mountain (Deluxe Edition)')).toBe(
      true
    );
  });

  it('rejects completely different albums', () => {
    expect(albumMatches('The Mountain', '30 Toddler Songs, Vol. 2')).toBe(
      false
    );
  });

  it('rejects wrong album same word', () => {
    expect(albumMatches('The Misfits', 'Famous Monsters')).toBe(false);
  });

  // Key regression: "Gold" must NOT match "20 Golden Greats"
  it('rejects Gold matching Golden Greats', () => {
    expect(albumMatches('Gold', '20 Golden Greats')).toBe(false);
  });

  it('rejects Gold matching Hollyhood', () => {
    expect(albumMatches('Gold', 'Hollyhood (feat. Kent Jamz)')).toBe(false);
  });

  // Soundtrack edge case
  it('matches exact soundtrack title', () => {
    expect(
      albumMatches(
        'Garden State: Music from the Motion Picture',
        'Garden State (Music from the Motion Picture)'
      )
    ).toBe(true);
  });

  // Artist-name-as-prefix: Last.fm sometimes stores "Artist Album" while sources return "Album"
  it('matches when requested has artist name prefix', () => {
    expect(
      albumMatches(
        'Beastie Boys Anthology: The Sounds of Science',
        'Anthology: The Sounds Of Science',
        'Beastie Boys'
      )
    ).toBe(true);
  });

  it('does not false-match with artist prefix on different album', () => {
    expect(
      albumMatches(
        'Beastie Boys Anthology: The Sounds of Science',
        'Licensed to Ill',
        'Beastie Boys'
      )
    ).toBe(false);
  });

  // Apostrophe normalization: straight vs curly quotes
  it('matches apostrophe variants', () => {
    expect(albumMatches("Paul's Boutique", 'Paul\u2019s Boutique')).toBe(true);
  });

  // Number word and part/pt normalization
  it('matches "Part Two" with "Pt. 2"', () => {
    expect(
      albumMatches(
        'Hot Sauce Committee Part Two',
        'Hot Sauce Committee (Pt. 2)'
      )
    ).toBe(true);
  });

  it('matches "Vol. 1" with "Volume One"', () => {
    expect(
      albumMatches('Greatest Hits Vol. 1', 'Greatest Hits Volume One')
    ).toBe(true);
  });
});

describe('trackMatches', () => {
  it('allows punctuation and remaster labels but rejects a different song or performance', () => {
    expect(
      trackMatches('Synthetic Song', 'Synthetic Song (2011 Remaster)')
    ).toBe(true);
    expect(trackMatches('Synthetic Song', 'Synthetic Song Two')).toBe(false);
    expect(trackMatches('Synthetic Song', 'Synthetic Song (Live)')).toBe(false);
    expect(trackMatches('', '')).toBe(false);
  });
});
