// Zero-dependency static server for the WebUSB demo + (later) the wasm build.
// WebUSB requires a secure context; http://localhost qualifies.
//
//   node tools/serve.mjs [port]   ->   http://localhost:8080/web/
//
// COOP/COEP are sent so SharedArrayBuffer is available if a future build ever
// needs it; they don't affect WebUSB. Override with COOP_COEP=0 if they get in
// the way (e.g. loading cross-origin assets).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rawPort = process.argv[2] ?? process.env.PORT ?? "8080";
let PORT = Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.warn(`ignoring invalid port "${rawPort}" — falling back to 8080`);
  PORT = 8080;
}
const CROSS_ORIGIN_ISOLATE = process.env.COOP_COEP !== "0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path === "/") path = "/web/index.html";
    // Prevent path traversal outside ROOT.
    const filePath = normalize(join(ROOT, path));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    let target = filePath;
    if ((await stat(target)).isDirectory()) target = join(target, "index.html");

    const body = await readFile(target);
    // Dev server: never cache. We rebuild wasm/JS constantly; a stale cached
    // bundle (e.g. an old meshnode.wasm or meshtastic-core.js) silently serving
    // after a rebuild has bitten us twice. Always serve fresh.
    const headers = {
      "Content-Type": MIME[extname(target)] || "application/octet-stream",
      "Cache-Control": "no-store, must-revalidate",
    };
    if (CROSS_ORIGIN_ISOLATE) {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    res.writeHead(200, headers).end(body);
  } catch (e) {
    if (e.code === "ENOENT") res.writeHead(404).end("not found");
    else {
      res.writeHead(500).end("server error");
      console.error(e);
    }
  }
});

server.listen(PORT, () => {
  console.log(`serving ${ROOT}`);
  console.log(`open  http://localhost:${PORT}/web/   (Chromium, for WebUSB)`);
});
