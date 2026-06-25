#!/usr/bin/env node
// Assemble the static site (_site/) that GitHub Pages publishes.
//
// What it does:
//   1. Bundles @meshtastic/core (+ browser shims) -> _site/dist/meshtastic-core.js
//   2. Bundles each page module, inlining every ../src and ../wasm import, so the
//      output is self-contained (no path escapes _site/) -> _site/<page>.js
//   3. Copies the HTML (index = the full node) and stages the compiled wasm node
//      (meshnode.{mjs,wasm}) into _site/dist/.
//
// Everything is relative, so the result serves correctly from a project-pages
// subpath (https://<org>.github.io/<repo>/) with no rewriting.
//
//   node tools/build-site.mjs
//
// The compiled wasm node is taken from, in order: $FW/.pio/build/native-wasm,
// a sibling ../firmware checkout, then this repo's web/dist/. Build it first with
// `pio run -e native-wasm` (CI) or `./wasm/build_node.sh` (local).
import * as esbuild from "esbuild";
import { rm, mkdir, copyFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "web");
const SITE = join(ROOT, "_site");
const DIST = join(SITE, "dist");
const shim = (f) => join(WEB, "shims", f);
const exists = (p) => access(p).then(() => true, () => false);

// Locate the compiled wasm node (meshnode.{mjs,wasm}).
async function findWasm() {
  const cands = [
    process.env.FW && join(process.env.FW, ".pio", "build", "native-wasm"),
    join(ROOT, "..", "firmware", ".pio", "build", "native-wasm"),
    join(WEB, "dist"),
  ].filter(Boolean);
  for (const d of cands) {
    if ((await exists(join(d, "meshnode.mjs"))) && (await exists(join(d, "meshnode.wasm")))) return d;
  }
  throw new Error(
    "meshnode.{mjs,wasm} not found. Build the wasm node first:\n" +
      "  CI:    (cd <firmware> && pio run -e native-wasm)  then set FW=<firmware>\n" +
      "  local: ./wasm/build_node.sh",
  );
}

// @meshtastic/core inlines tslog, which reaches for node's util/os/path and the
// process/Buffer globals. Shim the modules and define the globals so the bundle
// runs in a plain browser tab.
const BANNER =
  'globalThis.process ??= { env: {}, argv: [], cwd: () => "/", platform: "browser", version: "", versions: {}, nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };\n' +
  "globalThis.Buffer ??= { isBuffer: () => false };";

// Keep the two runtime-loaded files external: the emscripten loader fetches
// meshnode.wasm relative to its own URL (must not be inlined), and the SDK is its
// own chunk (built just below).
const keepDistExternal = {
  name: "keep-dist-external",
  setup(b) {
    b.onResolve({ filter: /(^|\/)dist\/(meshnode\.mjs|meshtastic-core\.js)$/ }, (a) => ({
      path: a.path,
      external: true,
    }));
  },
};

async function main() {
  const wasmDir = await findWasm();
  await rm(SITE, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // 1) SDK bundle.
  await esbuild.build({
    stdin: { contents: 'export { MeshDevice } from "@meshtastic/core";', resolveDir: ROOT, sourcefile: "sdk-entry.js" },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outfile: join(DIST, "meshtastic-core.js"),
    alias: {
      os: shim("os.js"), "node:os": shim("os.js"),
      path: shim("path.js"), "node:path": shim("path.js"),
      util: shim("util.js"), "node:util": shim("util.js"),
      tslog: shim("tslog.js"),
    },
    banner: { js: BANNER },
    legalComments: "none",
    logLevel: "info",
  });

  // 2) Page bundles (inline ../src + ../wasm; keep dist/* external).
  await esbuild.build({
    entryPoints: [join(WEB, "meshnode.js"), join(WEB, "meshnode-api.js"), join(WEB, "probe.js")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    outdir: SITE,
    plugins: [keepDistExternal],
    // fs-setup.js dynamically imports node:fs in its headless (NODEFS) branch,
    // which never runs in the browser. Keep node builtins external so esbuild
    // doesn't try to bundle them; the dead branch is simply never evaluated.
    external: ["node:*"],
    logLevel: "info",
  });

  // 3) HTML — index = the full node; probe + SDK pages alongside.
  for (const f of ["index.html", "probe.html", "meshnode-api.html"]) {
    await copyFile(join(WEB, f), join(SITE, f));
  }

  // 4) Stage the compiled wasm node.
  await copyFile(join(wasmDir, "meshnode.mjs"), join(DIST, "meshnode.mjs"));
  await copyFile(join(wasmDir, "meshnode.wasm"), join(DIST, "meshnode.wasm"));

  // 5) deploy-pages serves the artifact as-is, but .nojekyll is belt-and-braces.
  await writeFile(join(SITE, ".nojekyll"), "");

  console.log(`built _site/  (wasm node from ${wasmDir})`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
