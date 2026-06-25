// Drive the full meshnode.wasm headlessly against the REAL CH341/MeshToad over
// node-usb's WebUSB layer (reuses wasm/bridge.js + src/ch341.js unchanged), so
// the boot+loop iterate in seconds without a browser. ALWAYS run under an
// OS-level timeout (the wasm can busy-loop and starve the JS event loop):
//   DEBUG_USB=1 perl -e 'alarm 25; exec @ARGV' node tools/run-node.mjs 40 30
//
// Env:
//   MESH_DATA_DIR  NODEFS host dir for persistence (default ./build/meshdata).
//                  Wipe it for a fresh node; give each concurrent node its own.
//   MESH_MAC       Force a MAC (12 hex, e.g. DEAD00C0FFEE) -> deterministic NodeNum.
//   MESH_REGION    Set region after boot (name like EU_868 or a number); goes
//                  through the same validate+reconfigure+persist path as the UI.
//   MESH_TCP       If set, run FOREVER and serve the Meshtastic stream-framed
//                  TCP API on this port (default 4403) instead of the bounded
//                  test loop. Then:  meshtastic --host localhost --port 4403 --info
//                  (run WITHOUT the perl-alarm watchdog — it's a long-lived server).
import { usb } from "usb";
const { default: createMeshNode } = await import("../web/dist/meshnode.mjs");
const { createCH341Bridge } = await import("../wasm/bridge.js");
const { startTcpBridge } = await import("./tcp-bridge.mjs");
const { mountPersistentFS, regionToCode } = await import("../web/fs-setup.js");
const { ADAPTERS, applyAdapter } = await import("../web/adapters.js");

const loopIters = Number(process.argv[2] || 100);
const watchdogSec = Number(process.argv[3] || 30);

const dev = await usb.findDeviceByIds(0x1a86, 0x5512);
if (!dev) {
  console.error("CH341 (1A86:5512) not found — plug in the MeshToad and close Chrome (it claims the device).");
  process.exit(1);
}

// Best-effort in-proc watchdog (the OS-level `perl alarm` wrapper is the real one).
// Skipped in serve mode (MESH_TCP) — that's a long-lived server, not a bounded run.
let phase = "init";
if (!process.env.MESH_TCP) {
  setTimeout(() => {
    console.error(`\n>>> in-proc WATCHDOG ${watchdogSec}s during '${phase}'`);
    process.exit(3);
  }, watchdogSec * 1000).unref?.();
}

const Module = await createMeshNode({
  print: (t) => console.log(t),
  printErr: (t) => console.error("[stderr]", t),
  noInitialRun: true,
});
Module.ch341 = createCH341Bridge(Module, dev);

// Persist to a real host dir (NODEFS) BEFORE boot, so saved state survives across
// runs and we can inspect it. Must happen before wasm_setup()'s loadFromDisk().
const mount = await mountPersistentFS(Module, { nodefsRoot: process.env.MESH_DATA_DIR || "./build/meshdata" });
console.log(`=== FS: ${mount.backend} -> ${mount.root || "(idb)"} ===`);

// Optional adapter override (default = firmware's MeshToad). Must run BEFORE
// wasm_setup, since wasm_config_apply consumes the wasm_set_lora_* values.
const adapterId = process.env.MESH_ADAPTER;
if (adapterId) {
  const a = ADAPTERS[adapterId];
  if (!a) {
    console.error(`MESH_ADAPTER='${adapterId}' unknown. Available: ${Object.keys(ADAPTERS).join(", ")}`);
    process.exit(1);
  }
  applyAdapter(Module, a);
  console.log(`=== adapter: ${a.label} (${adapterId}) ===`);
}

console.log("=== booting node (wasm_setup) ===");
phase = "wasm_setup";
const t0 = Date.now();
await Module.ccall("wasm_setup", null, [], [], { async: true });
console.log(`\n=== wasm_setup() RETURNED in ${Date.now() - t0} ms ===\n`);

// Optional region override (headless equivalent of the browser UI dropdown).
const wantRegion = regionToCode(process.env.MESH_REGION);
if (wantRegion != null) {
  const rc = await Module.ccall("wasm_set_region", "number", ["number"], [wantRegion], { async: true });
  console.log(`=== wasm_set_region(${process.env.MESH_REGION}=${wantRegion}) -> ${rc === 0 ? "OK" : "REJECTED"} ===`);
}

// Serve mode: run forever + bridge the PhoneAPI to TCP :4403 for real clients.
if (process.env.MESH_TCP) {
  const bridge = startTcpBridge(Module, { port: Number(process.env.MESH_TCP) || 4403 });
  phase = "serve";
  for (;;) {
    await Module.ccall("wasm_loop_once", "number", [], [], { async: true });
    bridge.pumpBridge(); // feed queued ToRadio + drain/frame FromRadio — between ticks
    await new Promise((r) => setTimeout(r, 5));
  }
}

console.log("=== pumping loop ===");
phase = "loop";
let i = 0;
while (i++ < loopIters) {
  await Module.ccall("wasm_loop_once", "number", [], [], { async: true });
  await new Promise((r) => setTimeout(r, 5));
}
console.log(`\n=== ran ${i - 1} loop iterations cleanly — node is alive ===`);
// NODEFS writes are already on the host fs; this is a no-op there, real flush in browser.
await Module.ccall("wasm_fs_sync", null, [], [], { async: true });
process.exit(0);
