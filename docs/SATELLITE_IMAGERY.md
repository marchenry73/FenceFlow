# Satellite imagery: why it's stale, and what's fresher

The owner's complaint: "I was not able to find a new construction from a
year ago." The `quote-map` function currently proxies **Esri World
Imagery**, keyless and free, which is what makes the whole feature free.
Esri's basemap is real satellite/aerial imagery (mostly Maxar), and it does
get refreshed, but the refresh is a rolling global mosaic project, not a
promise about any one Riverview cul-de-sac. A house that broke ground in the
last 12-18 months can easily sit on a still-vacant lot in Esri's current tile
for that spot.

This file is the research behind the provider switch added to
`supabase/functions/quote-map/index.ts` in the same change. Everything below
is either a direct quote/reading of the cited page, or marked as prior
knowledge where a page didn't spell it out.

## Provider comparison

| Provider | Typical imagery age, suburban Hillsborough Co. | Cost | Key needed | Max useful zoom | Attribution required |
|---|---|---|---|---|---|
| **Esri World Imagery** (current default) | Mosaic of Maxar Vivid (mostly 30cm HD across the US) plus community/aerial contributions; Esri publishes updates continuously but any single parcel's tile can be multiple years old — this is the gap the owner hit. | Free, keyless | None | ~19-20 (server caps some regions lower; client already retries one zoom down on a failed grid) | Esri's own World Imagery service metadata carries a `copyrightText` of "Esri, Maxar, Earthstar Geographics, and the GIS User Community" — knowledge, not fetched from a live response, but this is the standard text Esri ships with this exact service and it isn't currently surfaced anywhere in `quote-map` or the client. |
| **Google Map Tiles API (2D satellite)** | Google's own satellite layer, refreshed on Google's normal Maps cadence — generally the most current of the "global" providers for US suburbs, including recent subdivisions, though not guaranteed for every lot. | First 100,000 tile loads/month free (Essentials tier), then billed per 1,000 beyond that — Google's public pricing table lists the 2D Map Tiles SKU with a per-1,000 rate that steps down at volume; treat the exact number as needing a console check rather than repeating a possibly-stale figure here. Requires a Google Cloud project with an active **billing account** (a card on file) even to stay inside the free tier. | `GOOGLE_MAPS_TILES_KEY` — a Maps Platform API key with the Map Tiles API enabled, from the Google Cloud Console | 21 in well-covered US metro areas (not documented as a hard global cap; the code clamps to a configured value and falls back on a 404) | Yes — Google's terms require a visible attribution/logo when displaying their tiles; since this proxy has no on-screen map chrome, we surface it as an `X-Imagery-Attribution` response header and an `attribution` field so the client can render it near the satellite view. |
| **Mapbox Satellite** (raster, `mapbox.satellite` tileset via the v4 Raster Tiles API) | Blend of Maxar + other commercial sources; Mapbox documents "global coverage to zoom 16, regional coverage to zoom 18, select coverage to zoom 21+" — i.e. it can be as fresh as Google in well-covered metro areas, but Tampa suburbs aren't guaranteed to be in the highest tier. | 750,000 tile requests/month free, then $0.25/1,000 (750k-2M), tapering to $0.15/1,000 above 4M, per Mapbox's published pricing page. | `MAPBOX_TOKEN` — a Mapbox access token (public token is fine for tile requests) | 21 (code clamps to this; falls back below it on a 404) | Yes, Mapbox's ToS require attribution ("© Mapbox © Maxar"); surfaced the same way as Google's. |
| **Azure Maps (Bing aerial imagery)** | Bing's aerial layer; comparable freshness story to Google/Mapbox in principle, not independently verified for this county. | Transaction-based, roughly $0.90-$4.50 per 1,000-5,000 tiles depending on tier, per Azure's pricing page; a free Gen2 tier covers light usage. | An Azure Maps subscription key, plus an Azure account with billing | Not confirmed for the Get Map Tile aerial layer | Yes (Microsoft/Bing attribution) |
| **Apple Maps Server API** | Apple doesn't publish a standalone raw satellite-tile endpoint comparable to the above for third-party embedding the way Google/Mapbox/Azure do — the Server API is scoped around MapKit JS/native map rendering, not a bare tile proxy. Not implemented; would need deeper terms review before treating it as a tile source. | Unclear for this use case | Apple Developer / MapKit JS token | Unknown | Unknown |
| **Hillsborough County orthophotography** (`AerialsNew/Aerials2025_3_inch_MrSid`, ArcGIS ImageServer) | **Flown January 5-25, 2025** at 3-inch (~0.076m) pixel resolution — the newest, sharpest imagery of any source checked for this specific county, and it's a standard ArcGIS tile cache (256x256, Web Mercator, same origin/LOD scheme as the existing Esri call) so it drops into the exact same `/tile/{z}/{y}/{x}` proxy pattern already in this function. Covers Hillsborough County only — outside that bounding box the service has nothing to return. | Free, keyless (public county ArcGIS REST service) | None | ~20 (native pixel size is between Web-Mercator z20 and z21 resolution at this latitude; the cache exposes LOD levels 0-23 but only ~20 is real detail) | The county's own service metadata doesn't carry a `copyrightText` field, but their public-facing viewers credit the imagery to "Pictometry International / Hillsborough County Property Appraiser" — used as the attribution string when this provider serves a tile. |

## Recommendation

**Primary: Hillsborough County's 2025 ortho layer, opt-in via `HILLSBOROUGH_ORTHO=1`,
tried first when enabled.** It is free, needs no key, and at a January 2025
flight it is very likely the freshest imagery available for any Riverview/
Tampa job specifically — closer to "a year old" than "however old Esri's
mosaic happens to be at that pixel," which is exactly the owner's complaint.
Its only real limitation is geographic: it has nothing outside Hillsborough
County, so every tile request outside its extent (or any request when the
service is down) must fall through to the next provider rather than error.

**Fallback chain: Google Map Tiles API, then Mapbox Satellite, then the
existing Esri World Imagery.** Google is offered first among the paid
options because its coverage is closest to Google Earth's own freshness for
US suburbs and the free 100k tiles/month likely covers this app's real
traffic; Mapbox is the second paid option (generous free tier, no billing
account required — just an access token) for a company that would rather not
set up Google Cloud billing; Esri remains the always-available, no-config
fallback so the feature never breaks when no keys are set.

Practically: turn on `HILLSBOROUGH_ORTHO=1` immediately (it's free and
directly answers the "new construction" complaint for anything inside the
county), and treat the Google/Mapbox keys as an optional upgrade for jobs
outside Hillsborough County or for the rare in-county tile the 2025 flight
missed.

## What wasn't verified

- The exact current per-1,000-tile dollar rate for the Google Map Tiles API
  2D SKU beyond the 100k free tier — Google's pricing pages describe the
  billing model and the free quota clearly, but the specific dollar figure
  is one a small extraction pass returned inconsistently across fetches; get
  it live from the Google Cloud Console pricing table before budgeting.
- Whether Mapbox's "select coverage to zoom 21+" tier actually includes
  Riverview/Tampa specifically, versus stopping at the "regional, zoom 18"
  tier there — Mapbox doesn't publish a per-region coverage map at that
  granularity.
- Azure Maps' aerial-imagery freshness for this county — not independently
  checked; included in the table for completeness since the owner may ask
  about it, but not wired into the code.
- Apple Maps Server API as a tile source at all — their docs describe a
  server API for things like geocoding/ETA/place search tied to MapKit
  rendering, not an obviously-licensable bare satellite tile endpoint; would
  need a real terms-of-service read before ever proxying it.
- Whether the Hillsborough ImageServer's `copyrightText` is truly empty by
  design (no attribution required) or just not populated in that particular
  metadata response — the code errs toward crediting Pictometry/the Property
  Appraiser's office anyway, since their own public map viewers do.

## Sources

- Google Map Tiles API: usage & billing (`developers.google.com/maps/documentation/tile/usage-and-billing`), satellite tiles reference (`.../tile/satellite`), session tokens (`.../tile/session_tokens`), pricing list (`developers.google.com/maps/billing-and-pricing/pricing`)
- Mapbox: Raster Tiles API reference (`docs.mapbox.com/api/maps/raster-tiles/`), Mapbox Satellite tileset reference (`docs.mapbox.com/data/tilesets/reference/mapbox-satellite/`), pricing (`mapbox.com/pricing`)
- Esri: "What's New in World Imagery" (esri.com/arcgis-blog, July 2025) for the Maxar Vivid sourcing/refresh-cadence description
- Azure Maps pricing (`azure.microsoft.com/en-us/pricing/details/azure-maps/`) and the Bing-to-Azure imagery migration note (`learn.microsoft.com/.../migrate-get-imagery-metadata`)
- Apple Maps Server API docs (`developer.apple.com/documentation/applemapsserverapi`) and Apple Maps terms of use
- Hillsborough County ArcGIS REST services directory (`maps.hillsboroughcounty.org/arcgis/rest/services/Aerials` and `.../AerialsNew/Aerials2025_3_inch_MrSid/ImageServer?f=json`) for the live service metadata (capture window, pixel size, tiling scheme, capabilities), cross-checked against the county's public ArcGIS Online items (Aerial Imagery Viewer / "1938-2025 Aerial Imagery" web map) for the January 2025 flight date
