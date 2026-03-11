-- Seed lastfm_filters with existing hardcoded filter patterns
-- Holiday album patterns (substring match)
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'charlie brown christmas', 'album', 'Holiday album', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'merry christmas', 'album', 'Holiday album', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'white christmas', 'album', 'Holiday album', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'christmas album', 'album', 'Holiday album', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'holiday', 'album', 'Holiday album', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'christmas songs', 'album', 'Holiday album', '2026-03-11T00:00:00.000Z');

-- Holiday track patterns (substring match)
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'jingle bell', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'silent night', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'santa claus', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'deck the hall', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'rudolph', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'frosty the snowman', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'winter wonderland', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'o holy night', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'little drummer boy', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'away in a manger', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'hark the herald', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'o come all ye faithful', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'we wish you a merry', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'sleigh ride', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'silver bells', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'blue christmas', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'last christmas', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'christmas time', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'holly jolly', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'joy to the world', 'track', 'Holiday track', '2026-03-11T00:00:00.000Z');

-- Holiday artist-scoped track matches (artist||track format)
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'vince guaraldi||skating', 'artist_track', 'Charlie Brown Christmas track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'vince guaraldi||greensleeves', 'artist_track', 'Charlie Brown Christmas track', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'holiday', 'vince guaraldi||linus and lucy', 'artist_track', 'Charlie Brown Christmas track', '2026-03-11T00:00:00.000Z');

-- Audiobook artist patterns (exact match)
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', 'stephen king', 'artist', 'Audiobook author', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', 'thomas pynchon', 'artist', 'Audiobook author', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', 'hunter s. thompson', 'artist', 'Audiobook author', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', 'andy weir', 'artist', 'Audiobook author', '2026-03-11T00:00:00.000Z');

-- Audiobook track patterns (substring match)
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', 'libby--open-', 'track', 'Libby app artifact', '2026-03-11T00:00:00.000Z');

-- Audiobook track regex patterns
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', '- Part \\d+', 'track_regex', 'Audiobook part numbering', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', '- Track \\d+', 'track_regex', 'Audiobook track numbering', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', '- \\d{2,3}$', 'track_regex', 'Audiobook chapter numbering', '2026-03-11T00:00:00.000Z');
INSERT INTO lastfm_filters (user_id, filter_type, pattern, scope, reason, created_at) VALUES (1, 'audiobook', ' \\(\\d+\\)$', 'track_regex', 'Audiobook part numbering', '2026-03-11T00:00:00.000Z');
