# Apple Maps Web Snapshots

Research for generating static route map images from Strava polyline data.

## API

REST endpoint at `https://snapshot.apple-mapkit.com/api/v1/snapshot` that returns a PNG. No JS runtime needed — plain HTTPS GET, fully compatible with Cloudflare Workers.

## Authentication

ECDSA P-256 URL signing. Requires three things from Apple Developer account:

- Team ID
- Key ID (from the .p8 filename)
- Private key (.p8 file) with MapKit JS enabled

The full URL path + query string is signed with the private key, and the base64url-encoded signature is appended as `&signature=`. Workers supports this natively via `crypto.subtle`.

## Polyline Overlay

The `overlays` query parameter accepts a JSON array of overlay objects:

```json
[
  {
    "points": ["47.71,-122.30", "47.72,-122.31", "47.73,-122.30"],
    "strokeColor": "0066ff",
    "lineWidth": 3
  }
]
```

Points are individual `"lat,lng"` strings — not Google-encoded polylines. Combined with a practical URL length limit of ~5,000 characters, routes need to be simplified to ~50-100 points using Douglas-Peucker.

## Other Parameters

| Parameter     | Example         | Description                                    |
| ------------- | --------------- | ---------------------------------------------- |
| `center`      | `47.71,-122.30` | Center coordinate (auto-calculated if omitted) |
| `size`        | `600x400`       | Image dimensions in pixels                     |
| `scale`       | `2`             | 1 or 2 (retina)                                |
| `type`        | `mutedStandard` | standard, satellite, hybrid, mutedStandard     |
| `colorScheme` | `dark`          | light or dark                                  |

## Rate Limits

25,000 unique requests per day, free, per Apple Developer Program membership.

## Proposed Architecture

```text
strava_activities.map_polyline
  -> Decode Google-encoded polyline to lat/lng pairs
  -> Douglas-Peucker simplify to ~50-100 points
  -> Build Apple Maps Snapshot URL with overlay
  -> Sign URL with ECDSA P-256
  -> Fetch PNG from Apple
  -> Store in R2 (running/{activity_id}/map.png)
  -> Serve via cdn.rewind.rest
```

Generate each image once at sync time, not per-request. Store in R2 alongside existing image pipeline.

## Alternative: Mapbox

Mapbox Static Images API accepts Google-encoded polylines directly in the URL path, skipping the decode/simplify step:

```text
https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/path-3+0066ff({encoded_polyline})/auto/600x400
```

50,000 free static images per month. Simpler to implement but different visual style.

## References

- [Maps Web Snapshots docs](https://developer.apple.com/documentation/snapshots/)
- [Overlay parameters](https://developer.apple.com/documentation/snapshots/overlay)
- [URL signing](https://developer.apple.com/documentation/snapshots/generating-a-url-and-signature-to-create-a-maps-web-snapshot)
- [Creating MapKit keys](https://developer.apple.com/documentation/applemapsserverapi/creating-a-maps-identifier-and-a-private-key)
