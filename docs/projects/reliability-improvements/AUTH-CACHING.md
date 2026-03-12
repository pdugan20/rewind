# Auth Caching and Rate Limiting -- Design Notes

## Auth Caching

### Problem

Every API request queries D1 to validate the Bearer token. This is ~1ms on D1 but adds up and is unnecessary for repeated requests with the same key.

### Solution

Use Cloudflare Cache API to store validated key records:

```text
Cache key:    `auth:${sha256(token)}`
Cache value:  JSON { id, scope, rateLimitRpm, expiresAt }
TTL:          60 seconds
```

On key revocation (`DELETE /v1/admin/keys/:id`), purge the cache entry. Since TTL is only 60s, even without explicit purge, a revoked key stops working within a minute.

### Implementation

```text
requireAuth(scope):
  hash = sha256(token)
  cacheKey = `auth:${hash}`

  // Try cache first
  cached = await caches.default.match(cacheKey)
  if cached:
    keyRecord = JSON.parse(cached.body)
  else:
    keyRecord = await db.select().from(api_keys).where(keyHash = hash)
    if keyRecord:
      cache.put(cacheKey, new Response(JSON.stringify(keyRecord)), { ttl: 60 })

  // Validate as before
  check expiry, check scope, update usage stats via waitUntil
```

## Rate Limiting

### Problem

`rateLimitRpm` is stored in `api_keys` but never enforced.

### Solution

Sliding window counter using Cache API:

```text
Cache key:    `ratelimit:${keyId}:${Math.floor(Date.now() / 60000)}`
Cache value:  integer request count
TTL:          120 seconds (covers current + previous minute window)
```

On each request:

```text
currentMinute = Math.floor(Date.now() / 60000)
currentCount = cache.get(`ratelimit:${keyId}:${currentMinute}`) || 0

if currentCount >= rateLimitRpm:
  return 429 with Retry-After: seconds until next minute

cache.put(`ratelimit:${keyId}:${currentMinute}`, currentCount + 1, { ttl: 120 })
```

This is approximate (not perfectly precise sliding window) but sufficient for a personal API with low traffic. The Cache API is free and doesn't add D1 load.
