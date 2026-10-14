-- Verified CD artwork WebP variants by storage ETag. The artwork manifest
-- advertises a variant without re-downloading it while its object is
-- unchanged since its bytes were last hashed; a replaced object has a new
-- ETag and is verified again before it is advertised.
CREATE TABLE cd_artwork_variant_checks (
  variant_sha256 TEXT PRIMARY KEY NOT NULL,
  canonical_hash TEXT NOT NULL,
  etag TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  verified_at TEXT NOT NULL
);
