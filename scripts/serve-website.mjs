#!/usr/bin/env node
/**
 * Serves the website folder over http so the pages can actually be opened.
 *
 * Opening dashboard.html straight off the disk does not work: it is an ES
 * module, and browsers refuse to load modules over file://. That is also why
 * a dev copy of the site cannot be checked by double-clicking it.
 *
 * Usage:
 *   node scripts/serve-website.mjs           -> serves website/ on 8080
 *   node scripts/serve-website.mjs dev 8081  -> serves website/dev/ on 8081
 *
 * Nothing but static files, bound to localhost only.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, extname } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const sub = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : "";
const port = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 8080);
const ROOT = join(REPO_ROOT, "website", sub);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path.endsWith("/")) path += "index.html";
    // Refuse anything that climbs out of the served folder.
    const file = resolve(ROOT, "." + path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("no"); return; }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Serving ${ROOT}\n  http://localhost:${port}/index.html`);
});
