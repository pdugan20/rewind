# Disambiguation Reference

## TMDb Fallback Search

When the add-media endpoint returns a wrong match or the ambiguous candidates don't include the expected film, search TMDb directly:

```bash
curl -s "https://api.themoviedb.org/3/search/movie?query=<title>&language=en-US" \
  -H "Authorization: Bearer <TMDB_API_KEY>"
```

To narrow results, add `&year=<year>` -- but note that TMDb's year filter can miss films whose release_date doesn't match the expected year. If filtering by year returns no results or wrong results, retry without the year parameter and match manually.

Extract `tmdb_id` from the correct result, then re-call the add-media endpoint with `tmdb_id` instead of `title`.

## Discogs Fallback Search

When the add-vinyl endpoint returns ambiguous results, review the candidates by format and country. Discogs often returns many pressings of the same album. The user typically wants the pressing that matches their purchase (check format, country, year).

If the candidates don't include the right pressing, search Discogs directly:

```bash
curl -s "https://api.discogs.com/database/search?q=<query>&type=release&artist=<artist>&per_page=10" \
  -H "Authorization: Discogs token=<DISCOGS_PERSONAL_TOKEN>" \
  -H "User-Agent: RewindAPI/1.0"
```

Extract `discogs_id` from the correct result, then re-call with `discogs_id`.

## Movie Media Type Values

| User Input                        | `media_type` Value |
| --------------------------------- | ------------------ |
| Blu-ray                           | `bluray`           |
| 4K UHD, UHD, 4K UHD+Blu-ray Combo | `uhd_bluray`       |
| DVD                               | `dvd`              |
| HD-DVD                            | `hddvd`            |
| Digital                           | `digital`          |

## Movie Optional Metadata

### Resolution

`uhd_4k`, `hd_1080p`, `hd_720p`, `sd_480p`

### HDR

`dolby_vision`, `hdr10`, `hdr10_plus`, `hlg`

### Audio

`dolby_atmos`, `dts_x`, `dolby_truehd`, `dts_hd_ma`, `lpcm`

### Audio Channels

`7_1`, `5_1`, `2_0`
