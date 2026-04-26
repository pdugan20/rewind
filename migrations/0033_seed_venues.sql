-- Seed Seattle venues with alias-aware names so the venue resolver
-- catches historical calendar entries (Safeco Field, KeyArena, etc.)
-- without needing user intervention. INSERT OR IGNORE makes re-applying
-- safe; auto-created venues from the resolver won't collide because
-- we use the user_id+name unique constraint.

INSERT OR IGNORE INTO venues (user_id, name, aliases, city, state, country, latitude, longitude, capacity, created_at, updated_at) VALUES
  (1, 'T-Mobile Park', '["Safeco Field"]', 'Seattle', 'WA', 'US', 47.5914, -122.3325, 47929, datetime('now'), datetime('now')),
  (1, 'Climate Pledge Arena', '["KeyArena"]', 'Seattle', 'WA', 'US', 47.6221, -122.3540, 17151, datetime('now'), datetime('now')),
  (1, 'Lumen Field', '["CenturyLink Field","Qwest Field"]', 'Seattle', 'WA', 'US', 47.5952, -122.3316, 68740, datetime('now'), datetime('now')),
  (1, 'Husky Stadium', '["Alaska Airlines Field at Husky Stadium","Alaska Airlines Field"]', 'Seattle', 'WA', 'US', 47.6503, -122.3015, 70083, datetime('now'), datetime('now')),
  (1, 'Alaska Airlines Arena', '["Hec Edmundson Pavilion","Hec Ed Pavilion","Hec Ed"]', 'Seattle', 'WA', 'US', 47.6553, -122.3017, 10000, datetime('now'), datetime('now')),
  (1, 'Showbox SoDo', '[]', 'Seattle', 'WA', 'US', 47.5876, -122.3316, 1800, datetime('now'), datetime('now')),
  (1, 'Showbox at the Market', '[]', 'Seattle', 'WA', 'US', 47.6087, -122.3402, 1100, datetime('now'), datetime('now')),
  (1, 'Paramount Theatre', '[]', 'Seattle', 'WA', 'US', 47.6131, -122.3320, 2807, datetime('now'), datetime('now')),
  (1, 'Moore Theatre', '[]', 'Seattle', 'WA', 'US', 47.6138, -122.3416, 1800, datetime('now'), datetime('now')),
  (1, 'Neptune Theatre', '[]', 'Seattle', 'WA', 'US', 47.6614, -122.3134, 800, datetime('now'), datetime('now')),
  (1, 'Neumos', '[]', 'Seattle', 'WA', 'US', 47.6147, -122.3199, 650, datetime('now'), datetime('now')),
  (1, 'The Crocodile', '["Crocodile Cafe"]', 'Seattle', 'WA', 'US', 47.6131, -122.3404, 500, datetime('now'), datetime('now')),
  (1, 'Sunset Tavern', '[]', 'Seattle', 'WA', 'US', 47.6685, -122.3754, 200, datetime('now'), datetime('now')),
  (1, 'Tractor Tavern', '[]', 'Seattle', 'WA', 'US', 47.6685, -122.3754, 400, datetime('now'), datetime('now'));
