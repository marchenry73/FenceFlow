/**
 * The ground under the 3D fence: where the house actually is, and what it
 * actually looks like from above.
 *
 *   ?action=geocode&address=...   -> {lat, lon} via the US Census geocoder
 *   ?action=tile&z=&y=&x=         -> an aerial imagery tile, proxied
 *
 * Both upstream services are public and keyless -- the Census Bureau's
 * geocoder and Esri's World Imagery tiles -- which is what keeps this feature
 * free. Proxied rather than fetched from the page because WebGL textures
 * demand CORS-clean images and neither upstream promises the headers; this
 * function guarantees them, adds a day of caching so a quote being shown
 * around a kitchen table doesn't re-download the neighbourhood, and gives us
 * one place to swap providers if either ever changes terms.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
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
    const r = await fetch(
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    );
    if (!r.ok) return json({ error: "No imagery there." }, 404);
    const bytes = await r.arrayBuffer();
    return new Response(bytes, {
      headers: {
        ...cors,
        "Content-Type": r.headers.get("Content-Type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  return json({ error: "Unknown action." }, 400);
});
