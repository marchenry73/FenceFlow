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
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
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
/**
 * Whether this request may spend money.
 *
 * The free providers stay open to anybody, because a homeowner opening a
 * quote link holds no login and the whole point of the 3D fence is that it
 * renders for them. The PAID providers are a different matter: an open
 * proxy in front of a metered key is a bill a stranger gets to run up, and
 * a per-IP counter demonstrably does not stop that here.
 *
 * So the guard binds to the thing worth guarding rather than to the door.
 * A caller who presents the project's anon key -- which every real caller
 * already sends, because the office, the app and the quote page all talk to
 * Supabase -- gets the paid chain. A stranger who found the bare URL gets
 * the free chain, and still sees a fence. Nothing breaks today, and the
 * moment GOOGLE_MAPS_TILES_KEY or MAPBOX_TOKEN goes into the environment it
 * is protected by construction rather than by a promise to come back later.
 *
 * This is not a strong secret -- the anon key ships inside the web page --
 * and it is not meant to be. It raises the cost of abuse from "paste a URL"
 * to "read our JavaScript", which is the right amount of friction for a
 * layer whose worst case is imagery quota. A signed short-lived ticket is
 * the stronger version and is described in docs/SATELLITE_IMAGERY.md.
 */
function paidProvidersAllowed(req: Request, url: URL): boolean {
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!anon) return true; // Nothing to check against; fail open rather than break imagery.
  const header = req.headers.get("apikey") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return header === anon || url.searchParams.get("apikey") === anon;
}

function buildProviders(paidAllowed = true): ImageryProvider[] {
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

  const googleKey = paidAllowed ? Deno.env.get("GOOGLE_MAPS_TILES_KEY") : null;
  if (googleKey) {
    providers.push({
      name: "Google",
      maxZoom: GOOGLE_MAX_ZOOM,
      attribution: "Imagery © Google",
      note: "Google Map Tiles API satellite layer.",
      fetchTile: (z, y, x) => googleTile(z, y, x, googleKey),
    });
  }

  const mapboxToken = paidAllowed ? Deno.env.get("MAPBOX_TOKEN") : null;
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

/* ----------------------------------------------------------------- *
 * A ceiling, so that finding this URL is not the same as spending our
 * money.
 *
 * This door is deliberately open: the homeowner looking at a quote holds
 * no login, and requiring one would mean the 3D fence only renders for
 * people with an account. What it must not be is unbounded. Today every
 * provider in the chain is free and keyless, so the worst an abuser could
 * do is waste our compute; the moment a Google or Mapbox key goes into the
 * environment, an open proxy is a bill somebody else gets to run up.
 *
 * Counted per caller IP in this isolate's memory, and MEASURED rather than
 * assumed: 600 requests fired at the deployed function produced not one
 * refusal, because Supabase spreads them across so many isolates that no
 * single counter ever reached its limit. So this is a speed bump against a
 * naive single-threaded scraper and nothing more. It is kept because it
 * costs nothing and catches the laziest case, and it is NOT what protects
 * the money -- `paidProvidersAllowed` below is. Do not raise these numbers
 * expecting them to mean anything, and do not rely on them when adding a
 * key.
 *
 * Tiles are generous because one satellite view is dozens of tiles and a
 * day of caching sits in front of this. Geocoding is tight because it is
 * one call per job, and it is the endpoint that spends somebody else's
 * quota (Census, then Esri) rather than ours.
 */
const WINDOW_MS = 10 * 60 * 1000;
const LIMITS: Record<string, number> = { tile: 1200, geocode: 60, meta: 120 };
const MAX_TRACKED_IPS = 5000;

const seen = new Map<string, { count: number; windowStart: number }>();

function overLimit(ip: string, action: string): boolean {
  const limit = LIMITS[action];
  if (limit === undefined) return false;
  const now = Date.now();
  const key = `${action}:${ip}`;
  const entry = seen.get(key);

  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    // Sweep before growing. Without this the map is a slow memory leak on a
    // long-lived isolate: every IP that ever called stays for ever.
    if (seen.size >= MAX_TRACKED_IPS) {
      for (const [k, v] of seen) {
        if (now - v.windowStart >= WINDOW_MS) seen.delete(k);
      }
      // Still full means the traffic is real and current, not stale entries.
      // Drop the whole thing rather than refuse service to everybody: the
      // limiter forgetting a window is a smaller harm than a map that cannot
      // grow turning into a hard outage.
      if (seen.size >= MAX_TRACKED_IPS) seen.clear();
    }
    seen.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > limit;
}

/** Deno Deploy sets x-forwarded-for; the first hop is the real caller. */
function callerIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0].trim() || req.headers.get("x-real-ip") || "unknown";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // Which bucket this request draws on, decided before anything expensive
  // happens.
  const bucket = url.searchParams.get("meta") === "1"
    ? "meta"
    : (url.searchParams.get("action") ?? "");
  if (overLimit(callerIp(req), bucket)) {
    // Said in words a person could read, because this can reach a homeowner
    // whose kitchen-table wifi shares an address with something noisy.
    return new Response(
      JSON.stringify({ error: "Too many map requests just now. Wait a minute and try again." }),
      {
        status: 429,
        headers: { ...cors, "Content-Type": "application/json", "Retry-After": "60" },
      },
    );
  }

  // Lets the office show "Imagery: Google, up to zoom 20" next to the
  // satellite tool without hard-coding whichever provider happens to be
  // configured -- reports whichever provider would actually serve the next
  // tile request, i.e. the first one in the chain.
  if (url.searchParams.get("meta") === "1") {
    // Reports the chain THIS caller would actually get, so the credit line
    // the page shows matches the tiles it will receive.
    const paidAllowed = paidProvidersAllowed(req, url);
    const primary = buildProviders(paidAllowed)[0];
    return json({
      provider: primary.name,
      max_zoom: primary.maxZoom,
      attribution: primary.attribution,
      imagery_note: primary.note,
      // A handle for checking the money guard the day a metered key goes in:
      // ask ?meta=1 with the product key and without it. Once a key exists,
      // these two answers must differ. While every provider is free they are
      // both false, which is itself the correct answer.
      paid_available: paidAllowed &&
        Boolean(Deno.env.get("GOOGLE_MAPS_TILES_KEY") || Deno.env.get("MAPBOX_TOKEN")),
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

    const providers = buildProviders(paidProvidersAllowed(req, url));
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
