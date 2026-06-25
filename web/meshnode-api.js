// Full node in the tab + the OFFICIAL @meshtastic/core SDK driving it through an
// in-process transport — zero network. The SDK does all protobuf encode/decode;
// our transport just shuttles unframed ToRadio/FromRadio bytes to the wasm node.
import createMeshNode from "./dist/meshnode.mjs";
import { MeshDevice } from "./dist/meshtastic-core.js";
import { CH341 } from "../src/ch341.js";
import { createCH341Bridge } from "../wasm/bridge.js";
import { mountPersistentFS } from "./fs-setup.js";
import { createWasmTransport } from "./transport-wasm.js";
import { ADAPTERS, applyAdapter } from "./adapters.js";

const $ = (id) => document.getElementById(id);
function log(msg) {
  const d = document.createElement("div");
  d.textContent = msg;
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
}
function setStatus(t, c) {
  const e = $("status");
  e.textContent = t;
  e.className = c || "";
}

const nodes = new Map();
function renderNodes() {
  const ul = $("nodes");
  ul.innerHTML = "";
  for (const [num, n] of nodes) {
    const li = document.createElement("li");
    const name = n.user ? `${n.user.longName} (${n.user.shortName})` : "(awaiting nodeinfo)";
    li.textContent = `!${(num >>> 0).toString(16).padStart(8, "0")} — ${name}`;
    ul.appendChild(li);
  }
  $("nodeCount").textContent = String(nodes.size);
}

let Module = null;
let transport = null;
let device = null;
let running = false;

async function boot() {
  try {
    if (!("usb" in navigator)) {
      setStatus("WebUSB needs Chromium over http://localhost", "err");
      return;
    }
    setStatus("requesting CH341…");
    const dev = (await CH341.request()).device;
    log(`device: ${dev.productName || "CH341"}`);

    setStatus("loading + booting wasm node…");
    Module = await createMeshNode({
      print: (t) => console.log(t), // firmware stdout -> devtools, keep the UI clean
      printErr: (t) => console.error(t),
      noInitialRun: true,
    });
    Module.ch341 = createCH341Bridge(Module, dev);
    const mount = await mountPersistentFS(Module);
    log(`persistence: ${mount.backend}`);
    // Apply the chosen adapter BEFORE boot (default = firmware MeshToad).
    const sel = $("adapter");
    const adapter = sel && sel.value ? ADAPTERS[sel.value] : null;
    applyAdapter(Module, adapter);
    log(`adapter: ${adapter ? adapter.label : "MeshToad (default)"}`);
    await Module.ccall("wasm_setup", null, [], [], { async: true });
    log("node booted — attaching @meshtastic/core over the in-process transport");

    // The official SDK, talking to the in-tab node. No HTTP/serial/BLE.
    transport = createWasmTransport(Module);
    device = new MeshDevice(transport);

    device.events.onDeviceStatus.subscribe((s) => log(`SDK status: ${s}`));
    device.events.onMyNodeInfo.subscribe((mi) => {
      const id = "!" + (mi.myNodeNum >>> 0).toString(16).padStart(8, "0");
      $("myNode").textContent = id;
      log(`my node: ${id}`);
    });
    device.events.onNodeInfoPacket.subscribe((ni) => {
      nodes.set(ni.num, ni);
      renderNodes();
    });
    device.events.onMessagePacket.subscribe((p) => {
      log(`💬 !${(p.from >>> 0).toString(16)} on ch${p.channel}: ${p.data}`);
    });

    running = true;
    pump(); // must be running so the handshake can drain while configure() awaits

    setStatus("configuring (SDK handshake)…", "warn");
    log("device.configure() → want_config_id …");
    await device.configure();
    setStatus("configured — live via @meshtastic/core SDK", "ok");
    log("✅ configured — node list + messages now flow through the official SDK");
    $("send").disabled = false;
    $("msg").disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("error: " + e.message, "err");
    log("ERROR: " + e.message);
  }
}

async function pump() {
  if (!running) return;
  try {
    await Module.ccall("wasm_loop_once", "number", [], [], { async: true });
    transport.pumpBetweenTicks(); // feed queued ToRadio + drain FromRadio — between ticks
    setTimeout(pump, 5);
  } catch (e) {
    console.error(e);
    log("loop error: " + e.message);
    setStatus("loop stopped: " + e.message, "err");
    running = false;
  }
}

// Populate the adapter chooser from the firmware-derived presets (web/adapters.js).
(function populateAdapters() {
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

$("boot").addEventListener("click", () => boot());
$("send").addEventListener("click", async () => {
  const t = $("msg").value.trim();
  if (!t || !device) return;
  try {
    await device.sendText(t);
    log(`→ sent: ${t}`);
    $("msg").value = "";
  } catch (e) {
    log("send failed: " + e.message);
  }
});
$("msg").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("send").click();
});
