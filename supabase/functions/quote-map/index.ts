/**
 * The ground under the 3D fence: where the house actually is, and what it
 * actually looks like from above.
 *
 *   ?action=geocode&address=...   -> {lat, lon} via the US Census geocoder
 *   ?action=tile&z=&y=&x=         -> an aerial imagery tile, proxied
 *   ?meta=1                       -> {provider, max_zoom, attribution, imagery_note}
 *
 * Geocoding is unchanged: the Census Bureau, then Esri's keyless geocoder for
 * addresses too new for Census. Imagery is now a chain, tried in order and
 * falling through to the next on any error so a bad key or a down provider
 * never breaks the feature:
 *
 *   1. HILLSBOROUGH_ORTHO=1  -> the county's own ArcGIS ImageServer, free and
 *      keyless, flown January 2025 at ~3in/pixel. Covers Hillsborough County
 *      only -- everything outside its extent (or any hiccup) falls through.
 *   2. GOOGLE_MAPS_TILES_KEY -> Google's Map Tiles API 2D satellite layer.
 *      Needs a session token, which Google says is good for two weeks; this
 *      keeps one in memory per warm isolate and refreshes it on a 401/403
 *      rather than on a timer, since an idle isolate never gets recycled on
 *      a schedule anyway.
 *   3. MAPBOX_TOKEN          -> Mapbox's mapbox.satellite raster tileset.
 *   4. Esri World Imagery    -> the original, free, keyless default. Always
 *      present as the last link in the chain so the feature works with zero
 *      configuration, exactly as it always has.
 *
 * Why any of this exists: Esri's mosaic is real satellite imagery and it
 * does get refreshed, but not on any schedule tied to a specific address --
 * a house built in the last year or two can still sit on a vacant lot in
 * Esri's current tile. The research behind this chain, including why the
 * county layer is recommended first, lives in docs/SATELLITE_IMAGERY.md.
 *
 * Every provider here has an attribution requirement, including Esri's
 * (Esri just never had it surfaced before). Rather than bake a credit line
 * into every tile image, the active provider's line ships as an
 * X-Imagery-Attribution response header on every tile and as the
 * `attribution` field on ?meta=1, so a caller can show "Imagery: Google, up
 * to zoom 20" once, near the map, instead of on each of the dozens of tiles
 * that make it up.
 *
 * Proxied rather than fetched from the page because WebGL textures demand
 * CORS-clean images and none of these upstreams promise the headers; this
 * function guarantees them, adds a day of caching so a quote being shown
 * around a kitchen table doesn't re-download the neighbourhood, and keeps
 * every provider key server-side where the page can never see it.
 *
 * Nothing here is sensitive: addresses come from quotes whose token the
 * caller already holds or from the person typing their own address, and the
 * imagery is the same publicly served to any map on the internet.
 */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// A z/x/y request beyond a provider's own resolution gets walked back to the
// closest tile that provider actually has, rather than erroring -- the same
// "one zoom down" idea the 3D quote page already applies client-side when a
// grid fails to fill.
function clampTile(z: number, y: number, x: number, maxZoom: number) {
  if (z <= maxZoom) return { z, y, x };
  const shift = z - maxZoom;
  return { z: maxZoom, y: Math.floor(y / 2 ** shift), x: Math.floor(x / 2 ** shift) };
}

async function esriTile(z: number, y: number, x: number): Promise<Response | null> {
  const r = await fetch(
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  ).catch(() => null);
  return r && r.ok ? r : null;
}

// Standard ArcGIS Online tiling scheme (256px tiles, Web Mercator, same
// origin as every other slippy-map provider here), so it drops into the
// exact same /tile/{z}/{y}/{x} shape as Esri -- just a different host and a
// much newer flight. Only covers Hillsborough County; a tile outside its
// extent 404s from the service itself and falls through like any other error.
const HILLSBOROUGH_MAX_ZOOM = 20;
async function hillsboroughTile(z: number, y: number, x: number): Promise<Response | null> {
  const c = clampTile(z, y, x, HILLSBOROUGH_MAX_ZOOM);
  const r = await fetch(
    "https://maps.hillsboroughcounty.org/arcgis/rest/services/AerialsNew/" +
    `Aerials2025_3_inch_MrSid/ImageServer/tile/${c.z}/${c.y}/${c.x}`,
  ).catch(() => null);
  return r && r.ok ? r : null;
}

// Kept per warm isolate, not per request -- Google says a session token is
// good for about two weeks, so re-minting one on every tile would be all
// cost and no benefit. A 401/403 from the tile endpoint clears it so the
// very next call mints a fresh one instead of wedging on a dead token.
let googleSession: { token: string; expiry: number } | null = null;
async function googleSessionToken(key: string): Promise<string | null> {
  const now = Date.now() / 1000;
  if (googleSession && googleSession.expiry - 60 > now) return googleSession.token;
  const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" }),
  }).catch(() => null);
  const body = await r?.json().catch(() => null);
  if (!r?.ok || !body?.session) return null;
  googleSession = { token: body.session, expiry: Number(body.expiry) || now + 86400 };
  return googleSession.token;
}
const GOOGLE_MAX_ZOOM = 21;
async function googleTile(z: number, y: number, x: number, key: string): Promise<Response | null> {
  const c = clampTile(z, y, x, GOOGLE_MAX_ZOOM);
  const session = await googleSessionToken(key);
  if (!session) return null;
  const r = await fetch(
    `https://tile.googleapis.com/v1/2dtiles/${c.z}/${c.x}/${c.y}?session=${session}&key=${key}`,
  ).catch(() => null);
  if (r && !r.ok && (r.status === 401 || r.status === 403)) googleSession = null;
  return r && r.ok ? r : null;
}

const MAPBOX_MAX_ZOOM = 21;
async function mapboxTile(z: number, y: number, x: number, token: string): Promise<Response | null> {
  const c = clampTile(z, y, x, MAPBOX_MAX_ZOOM);
  const r = await fetch(
    `https://api.mapbox.com/v4/mapbox.satellite/${c.z}/${c.x}/${c.y}.jpg?access_token=${token}`,
  ).catch(() => null);
  return r && r.ok ? r : null;
}

interface ImageryProvider {
  name: string;
  maxZoom: number;
  attribution: string;
  note: string;
  fetchTile: (z: number, y: number, x: number) => Promise<Response | null>;
}

// Priority order: whichever of these has a secret set goes first. The free,
// keyless county layer leads when enabled because -- for the one county this
// app is actually used in today -- it is newer than anything money buys
// here. Esri is always last so the feature never depends on any of these
// being configured at all.
function buildProviders(): ImageryProvider[] {
  const providers: ImageryProvider[] = [];

  if (Deno.env.get("HILLSBOROUGH_ORTHO") === "1") {
    providers.push({
      name: "Hillsborough County GIS",
      maxZoom: HILLSBOROUGH_MAX_ZOOM,
      attribution: "Pictometry International / Hillsborough County Property Appraiser",
      note: "Flown Jan 2025 at roughly 3in/pixel. Hillsborough County coverage only.",
      fetchTile: hillsboroughTile,
    });
  }

  const googleKey = Deno.env.get("GOOGLE_MAPS_TILES_KEY");
  if (googleKey) {
    providers.push({
      name: "Google",
      maxZoom: GOOGLE_MAX_ZOOM,
      attribution: "Imagery © Google",
      note: "Google Map Tiles API satellite layer.",
      fetchTile: (z, y, x) => googleTile(z, y, x, googleKey),
    });
  }

  const mapboxToken = Deno.env.get("MAPBOX_TOKEN");
  if (mapboxToken) {
    providers.push({
      name: "Mapbox",
      maxZoom: MAPBOX_MAX_ZOOM,
      attribution: "© Mapbox © Maxar",
      note: "Mapbox Satellite raster tiles.",
      fetchTile: (z, y, x) => mapboxTile(z, y, x, mapboxToken),
    });
  }

  // Always present, always last -- the original free, keyless default.
  providers.push({
    name: "Esri",
    maxZoom: 20,
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    note: "Esri World Imagery -- free, keyless, refreshed on Esri's own schedule.",
    fetchTile: esriTile,
  });

  return providers;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // Lets the office show "Imagery: Google, up to zoom 20" next to the
  // satellite tool without hard-coding whichever provider happens to be
  // configured -- reports whichever provider would actually serve the next
  // tile request, i.e. the first one in the chain.
  if (url.searchParams.get("meta") === "1") {
    const primary = buildProviders()[0];
    return json({
      provider: primary.name,
      max_zoom: primary.maxZoom,
      attribution: primary.attribution,
      imagery_note: primary.note,
    });
  }

  const action = url.searchParams.get("action") ?? "";

  if (action === "geocode") {
    const address = (url.searchParams.get("address") ?? "").trim().slice(0, 200);
    if (address.length < 8) return json({ error: "Address too short to place." }, 400);
    const r = await fetch(
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
      `?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`,
    );
    const body = await r.json().catch(() => null);
    const m = body?.result?.addressMatches?.[0];
    if (m?.coordinates) {
      return json({ lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress ?? "" });
    }

    // The Census data lags new construction by years, and fence customers
    // disproportionately LIVE in new construction -- the first real address
    // this feature met was a Riverview FL street the Census had never heard
    // of. Esri's public geocoder carries new streets first; anonymous
    // single-line lookups are permitted on this endpoint.
    const e = await fetch(
      "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates" +
      `?f=json&maxLocations=1&countryCode=USA&singleLine=${encodeURIComponent(address)}`,
    ).then((r) => r.json()).catch(() => null);
    const c = e?.candidates?.[0];
    if (c?.location && Number(c.score) >= 80) {
      return json({ lat: c.location.y, lon: c.location.x, matched: c.address ?? "" });
    }

    // A miss usually means the job's address has no city or ZIP -- say so,
    // because "not found" reads as broken while "add the city" is a fix.
    return json({ error: "Could not place that address. It usually needs the city and ZIP." }, 404);
  }

  if (action === "tile") {
    const z = Number(url.searchParams.get("z"));
    const y = Number(url.searchParams.get("y"));
    const x = Number(url.searchParams.get("x"));
    if (![z, y, x].every(Number.isInteger) || z < 12 || z > 20 ||
        y < 0 || x < 0 || y >= 2 ** z || x >= 2 ** z) {
      return json({ error: "Bad tile." }, 400);
    }

    const providers = buildProviders();
    const failed: string[] = [];
    for (const provider of providers) {
      const r = await provider.fetchTile(z, y, x).catch(() => null);
      if (r) {
        // One line, once, for the whole request -- not one per provider
        // tried -- so a bad key doesn't spam the function log per tile.
        if (failed.length) {
          console.error(`quote-map: tile ${z}/${x}/${y} -- ${failed.join(", ")} failed, served by ${provider.name}`);
        }
        const bytes = await r.arrayBuffer();
        return new Response(bytes, {
          headers: {
            ...cors,
            "Content-Type": r.headers.get("Content-Type") ?? "image/jpeg",
            "Cache-Control": "public, max-age=86400",
            "X-Imagery-Attribution": provider.attribution,
            "Access-Control-Expose-Headers": "X-Imagery-Attribution",
          },
        });
      }
      failed.push(provider.name);
    }

    console.error(`quote-map: no imagery for tile ${z}/${x}/${y} -- tried ${failed.join(", ")}`);
    return json({ error: "No imagery there." }, 404);
  }

  return json({ error: "Unknown action." }, 400);
});
