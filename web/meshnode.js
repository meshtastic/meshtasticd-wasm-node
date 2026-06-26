// Boots the full meshtasticd WASM node and drives it over WebUSB (CH341).
import createMeshNode from "./dist/meshnode.mjs";
import { CH341 } from "../src/ch341.js";
import { createCH341Bridge } from "../wasm/bridge.js";
import { mountPersistentFS, regionToCode } from "./fs-setup.js";
import { ADAPTERS, applyAdapter } from "./adapters.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(msg) {
  const d = document.createElement("div");
  d.textContent = msg;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(t, c) {
  const e = $("status");
  e.textContent = t;
  e.className = c || "";
}

let Module = null;
let running = false;
let syncTimer = null;
let apiNonce = 0;
let apiScratch = 0;

// Actions that enter wasm MUST run only BETWEEN loop ticks — never during the
// Asyncify WebUSB suspend that wasm_loop_once() parks in. Calling a wasm_* entry
// point directly from a DOM/timer handler can fire mid-suspend and either abort
// Asyncify ("async operation already in flight") or silently corrupt PhoneAPI
// state. So region changes and ToRadio go through this queue, which pump()
// drains after each tick (the same discipline transport-wasm.js / run-node.mjs use).
const pendingActions = [];
function enqueue(fn) {
  pendingActions.push(fn);
}
function drainPending() {
  while (pendingActions.length) {
    try {
      pendingActions.shift()();
    } catch (e) {
      console.error(e);
      log("action error: " + e.message);
    }
  }
}

// --- Minimal protobuf helpers for the dependency-free API proof. The real
// client uses @meshtastic/js to encode/decode; here we hand-build the one
// ToRadio we need (want_config_id) and read just the FIRST field tag of each
// FromRadio to label the handshake sequence. -----------------------------------
function varint(n) {
  const b = [];
  n = n >>> 0;
  do {
    let x = n & 0x7f;
    n >>>= 7;
    if (n) x |= 0x80;
    b.push(x);
  } while (n);
  return b;
}
function readVarint(buf, off) {
  let shift = 0, res = 0, b;
  do {
    b = buf[off++];
    res |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return [res >>> 0, off];
}
// FromRadio oneof field number -> name (mesh.proto)
const FROMRADIO = {
  1: "packet", 3: "my_info", 4: "node_info", 5: "config", 6: "log_record",
  7: "config_complete_id", 8: "rebooted", 9: "moduleConfig", 10: "channel",
  11: "queueStatus", 12: "xmodemPacket", 13: "metadata", 14: "mqttClientProxyMessage",
  15: "fileInfo", 16: "clientNotification", 17: "deviceuiConfig",
};

// Kick the config handshake: send ToRadio{want_config_id=nonce} (field 3, varint).
function apiRequestConfig() {
  apiNonce = 0x1234abcd;
  const msg = Uint8Array.from([0x18, ...varint(apiNonce)]); // tag (3<<3)|0 = 0x18
  const p = Module._malloc(msg.length);
  Module.HEAPU8.set(msg, p);
  const ok = Module.ccall("wasm_api_to_radio", "number", ["number", "number"], [p, msg.length]);
  Module._free(p);
  log(`API → want_config_id=0x${apiNonce.toString(16)} (accepted=${ok})`);
}

// Drain FromRadio AFTER each loop tick (never during the Asyncify SPI suspend).
function drainApi() {
  if (!apiScratch) apiScratch = Module._malloc(512);
  let n;
  while ((n = Module.ccall("wasm_api_from_radio", "number", ["number", "number"], [apiScratch, 512])) > 0) {
    const bytes = Module.HEAPU8.slice(apiScratch, apiScratch + n);
    const [tag] = readVarint(bytes, 0);
    const field = tag >>> 3;
    const name = FROMRADIO[field] || `field#${field}`;
    let extra = "";
    if (field === 7) {
      const [v] = readVarint(bytes, 1);
      extra = ` = 0x${v.toString(16)}${v === apiNonce ? "  ✓ config complete (nonce matches)" : ""}`;
    }
    log(`API ← ${name} (${n}B)${extra}`);
  }
}

// Wire the region <select> to the firmware's live region-set path. A change goes
// through validate -> reconfigure (radio retunes) -> saveToDisk -> IDBFS, no reboot.
function setupRegionUi() {
  const sel = $("region");
  if (!sel) return;
  sel.disabled = false;
  sel.addEventListener("change", () => {
    const code = regionToCode(sel.value);
    if (code == null) return;
    // Capture the selection now; apply between ticks (wasm_set_region retunes the
    // radio = a WebUSB SPI op, which must not start mid-suspend).
    const label = sel.options[sel.selectedIndex].text;
    const value = sel.value;
    enqueue(() => {
      const rc = Module.ccall("wasm_set_region", "number", ["number"], [code]);
      if (rc === 0) {
        log(`region -> ${label} (radio retuned, persisted)`);
        setStatus(`region set: ${label}`, "ok");
      } else if (rc === -2) {
        // Shouldn't happen — queued actions already run between ticks. Defensive.
        log(`region ${value} skipped: node busy (mid-tick)`);
      } else {
        log(`region ${value} REJECTED by firmware validation`);
        setStatus("region rejected (validation failed)", "err");
      }
    });
  });
}

async function boot() {
  try {
    if (!("usb" in navigator)) {
      setStatus("WebUSB unavailable — use Chromium over http://localhost", "err");
      return;
    }
    setStatus("requesting device…");
    const dev = (await CH341.request()).device;
    log(`device: ${dev.productName || "CH341"} (VID 0x${dev.vendorId.toString(16)} PID 0x${dev.productId.toString(16)})`);

    setStatus("loading wasm node…");
    Module = await createMeshNode({
      print: (t) => log(t),
      printErr: (t) => log("[stderr] " + t),
      noInitialRun: true,
    });
    // Wire the WebUSB bridge BEFORE booting: portduinoSetup() opens the CH341 through it.
    Module.ch341 = createCH341Bridge(Module, dev);

    // Mount IDBFS at /meshdata and load any persisted state BEFORE boot, so the
    // node keeps its identity, config (region) and nodedb across page reloads.
    const mount = await mountPersistentFS(Module);
    log(`persistence: ${mount.backend} (IndexedDB) — node state survives reload`);

    // Apply the chosen adapter BEFORE boot (default = firmware MeshToad).
    const aSel = $("adapter");
    const adapter = aSel && aSel.value ? ADAPTERS[aSel.value] : null;
    applyAdapter(Module, adapter);
    log(`adapter: ${adapter ? adapter.label : "MeshToad (default)"}`);

    setStatus("booting node — wasm_setup()…");
    const t0 = performance.now();
    await Module.ccall("wasm_setup", null, [], [], { async: true });
    log(`>>> wasm_setup() completed in ${Math.round(performance.now() - t0)} ms`);

    setStatus("node running — pumping loop()", "ok");
    running = true;
    setupRegionUi();
    // Persist IDBFS periodically and on tab close (autoPersist can drop the last
    // batch + doesn't catch the SafeFile rename; an explicit syncfs(false) does).
    syncTimer = setInterval(() => Module.ccall("wasm_fs_sync", null, [], []), 5000);
    window.addEventListener("beforeunload", () => Module.ccall("wasm_fs_sync", null, [], []));
    pump();
  } catch (e) {
    console.error(e);
    setStatus(`error: ${e.message}`, "err");
    log("ERROR: " + e.message);
  }
}

// Drive the firmware's cooperative scheduler: each wasm_loop_once() runs one
// loop() iteration (may suspend on WebUSB via Asyncify) and returns the ms until
// it next wants to run.
async function pump() {
  if (!running) return;
  try {
    const delay = await Module.ccall("wasm_loop_once", "number", [], [], { async: true });
    // Between ticks only (never during the Asyncify SPI suspend): run queued UI/API
    // actions, then drain any FromRadio the client API produced.
    drainPending();
    drainApi();
    setTimeout(pump, Math.min(Math.max(delay || 5, 5), 100));
  } catch (e) {
    console.error(e);
    log("loop() error: " + e.message);
    setStatus("loop stopped: " + e.message, "err");
    running = false;
  }
}

// Populate the adapter chooser from the firmware-derived presets (web/adapters.js).
(function () {
  const sel = $("adapter");
  if (!sel) return;
  sel.innerHTML = '<option value="">MeshToad (default)</option>';
  for (const [id, a] of Object.entries(ADAPTERS)) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id + (a.support === "official" ? "" : ` (${a.support})`);
    sel.appendChild(o);
  }
})();

$("boot").addEventListener("click", boot);
$("stop").addEventListener("click", () => {
  running = false;
  setStatus("loop stopped (node still loaded)", "warn");
});
const apiBtn = $("apiConfig");
if (apiBtn)
  apiBtn.addEventListener("click", () =>
    // Enqueue: apiRequestConfig() calls wasm_api_to_radio, which must run between
    // ticks (re-entering mid-suspend corrupts PhoneAPI state).
    running ? enqueue(apiRequestConfig) : log("boot the node first")
  );
