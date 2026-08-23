// Streams a release APK with chunked transfer -- deliberately no Content-Length.
//
// Builds 1.134-1.136 shipped with a corrupted format string in the update
// dialog: the moment the downloader can compute a percentage, rendering it
// crashes the app, and the crash is IN the updater -- so the phones that need
// the fixed build most are the ones that cannot download it. Their downloader
// (ApkUpdater) only emits progress when the response carries a Content-Length;
// served chunked, the download runs silently to completion, the install prompt
// appears, and the phone is cured. Newer builds lose nothing but the progress
// percentage for this one download.
//
// Deployed with --no-verify-jwt: the app's downloader is a bare
// HttpURLConnection with no auth header, and an APK is not a secret -- the
// same file sits in a public storage bucket.
const STORAGE = "https://newcrgafcptspmapacrx.supabase.co/storage/v1/object/public/releases/";

// Only release files may pass through; anything else would make this an open
// proxy for whatever URL someone appends.
const NAME = /^fenceflow-\d+-[a-f0-9]+\.apk$/;

Deno.serve(async (req: Request) => {
  const f = new URL(req.url).searchParams.get("f") ?? "";
  if (!NAME.test(f)) {
    return new Response("not a release file", { status: 400 });
  }
  const upstream = await fetch(STORAGE + f);
  if (!upstream.ok || !upstream.body) {
    return new Response("release not found", { status: 404 });
  }
  // A fresh header set on purpose: copying upstream's would carry its
  // Content-Length and defeat the whole point.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.android.package-archive",
      "Cache-Control": "no-store",
    },
  });
});
