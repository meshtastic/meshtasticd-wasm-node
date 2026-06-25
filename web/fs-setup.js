// Mount the right Emscripten FS backend at /meshdata BEFORE wasm_setup(), so the
// firmware's NodeDB.loadFromDisk() sees persisted /prefs on boot and saveToDisk()
// writes survive. One wasm binary; the backend is chosen at runtime:
//   - browser  => IDBFS (IndexedDB) with autoPersist + load-on-boot via syncfs(true)
//   - headless => NODEFS mapped to a real host dir (synchronous, survives restarts,
//                 inspectable with `ls`)
// portduino's VFS mountpoint stays /meshdata, so firmware path /prefs/config.proto
// maps to <backend>/prefs/config.proto.
export async function mountPersistentFS(Module, opts = {}) {
  const FS = Module.FS;
  const isNode = typeof process !== "undefined" && !!process.versions?.node;

  try {
    FS.mkdir("/meshdata");
  } catch (e) {
    /* EEXIST — fine */
  }

  if (isNode) {
    const root = opts.nodefsRoot || "./build/meshdata";
    const fs = await import("node:fs");
    fs.mkdirSync(root, { recursive: true });
    FS.mount(Module.NODEFS, { root }, "/meshdata");
    return { backend: "NODEFS", root };
  }

  // Browser: IDBFS, auto-persisting on each file close, and load any previously
  // persisted tree into memory before the firmware boots.
  FS.mount(Module.IDBFS, { autoPersist: true }, "/meshdata");
  await new Promise((resolve, reject) => FS.syncfs(true, (err) => (err ? reject(err) : resolve())));
  return { backend: "IDBFS" };
}

// RegionCode enum names -> values (meshtastic config.proto). For UI dropdowns and
// the MESH_REGION env override. Pass-through if a number is given.
export const REGION_CODES = {
  UNSET: 0, US: 1, EU_433: 2, EU_868: 3, CN: 4, JP: 5, ANZ: 6, KR: 7, TW: 8, RU: 9,
  IN: 10, NZ_865: 11, TH: 12, LORA_24: 13, UA_433: 14, UA_868: 15, MY_433: 16,
  MY_919: 17, SG_923: 18, PH_433: 19, PH_868: 20, PH_915: 21, ANZ_433: 22,
  KZ_433: 23, KZ_863: 24, NP_865: 25, BR_902: 26,
};

export function regionToCode(r) {
  if (r == null || r === "") return null;
  const n = Number(r);
  if (Number.isFinite(n)) return n;
  return REGION_CODES[String(r).toUpperCase()] ?? null;
}
