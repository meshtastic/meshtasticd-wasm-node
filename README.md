# meshtasticd-wasm-node

Run the full Meshtastic node (**meshtasticd**, the portduino build) as
**WebAssembly** — in a browser tab or headless Node — driving a **real LoRa
radio over WebUSB** through a **CH341** USB-to-SPI bridge. The same firmware
`setup()`/`loop()` that runs on desktop Linux, compiled to wasm, talking to an
SX1262 from a Chromium tab with no native code on the machine.

The desktop firmware drives LoRa over a CH341 via a userspace libusb driver
(`libch341-spi-userspace`) wrapped by `Ch341Hal`. This swaps that libusb backend
for **WebUSB** and bridges RadioLib's synchronous SPI to async WebUSB with
Emscripten **Asyncify** — one suspend per SPI transfer.

> Companion to **[meshtastic/firmware](https://github.com/meshtastic/firmware)**:
> the wasm build env + WebUSB backend live there under `src/platform/portduino/wasm/`
> (`ARCH_PORTDUINO_WASM`, built by `bin/build-portduino-wasm.sh`). This repo is the
> web app, JS WebUSB runtime, and dev harness that consume it.

## What works

- Full node **boots in a tab** over WebUSB, inits a real SX1262, joins the mesh —
  **TX / RX / relays** real traffic, AES, builds the node DB with pubkeys + telemetry.
- **Headless** too: the same wasm runs under Node via `node-usb` (no browser).
- **Persistence**: IDBFS in the browser / NODEFS headless — identity, config, and
  nodedb survive a reload.
- **Region** picker (live retune, no reboot) and a **unique per-node MAC**.
- **API control** via the firmware's own `PhoneAPI`, exposed as wasm exports and
  driven by the official **`@meshtastic/core`** SDK over an in-process transport
  (zero network), or by the **Python CLI** through a TCP :4403 bridge.

## Quick start

Prereqs: **Chromium**, a CH341 LoRa adapter (e.g. a MeshToad, E22/SX1262; VID
`0x1A86` PID `0x5512`), a sibling **meshtastic/firmware** checkout, and Node.

```bash
npm install
./tools/setup-emsdk.sh                 # one-time: fetch the Emscripten SDK (~1 GB, into ./emsdk)
( cd ../firmware && pio run -e native-macos )   # one-time: populate firmware libdeps
npm run build:wasm                     # -> web/dist/meshnode.{mjs,wasm}
```

**Browser:**

```bash
npm run serve                          # static server (WebUSB needs a secure context)
# open http://localhost:8080/web/meshnode-api.html  — full node + @meshtastic/core UI
#   or http://localhost:8080/web/meshnode.html       — raw node + region + API proof
#   or http://localhost:8080/web/index.html          — hardware probe (no wasm)
```

Click **Connect & boot**, grant the CH341. The node boots, the SDK configures it,
and the node list + messaging go live.

**Headless / Python CLI:**

```bash
node tools/run-node.mjs                 # boot + run against the CH341 over node-usb
MESH_TCP=4403 node tools/run-node.mjs   # serve the device API on TCP :4403, then:
meshtastic --host localhost --port 4403 --info
```

## Layout

```
web/meshnode-api.html/.js   Full node + official @meshtastic/core SDK (in-process transport)
web/meshnode.html/.js       Raw node: boot, adapter + region picker, dependency-free API proof
web/index.html + probe.js   Hardware probe — SX1262 liveness over WebUSB (no wasm)
web/transport-wasm.js       @meshtastic/core Transport over the wasm_api_* exports
web/fs-setup.js             IDBFS (browser) / NODEFS (headless) persistence mount
web/adapters.js             GENERATED CH341 adapter presets + applyAdapter (npm run gen:adapters)
src/protocol.js             CH341 framing (bit reversal, 0xA8 SPI stream, 0xAB GPIO). Unit-tested.
src/ch341.js                WebUSB CH341 transport
wasm/build_node.sh          wrapper -> firmware's bin/build-portduino-wasm.sh, stages web/dist/
wasm/bridge.js              implements the C backend's webusb_* imports over src/ch341.js
tools/serve.mjs             static dev server (no-store)
tools/run-node.mjs          headless node-usb runner (+ MESH_TCP serve, MESH_ADAPTER, MESH_REGION)
tools/tcp-bridge.mjs        0x94c3 stream-framed TCP :4403 bridge for the Python CLI
tools/gen-adapters.mjs      regenerate web/adapters.js from firmware bin/config.d/lora-*.yaml

The wasm C glue + WebUSB backend live in the firmware repo
(meshtastic/firmware, src/platform/portduino/wasm/, ARCH_PORTDUINO_WASM) as the
single source of truth; wasm/build_node.sh here just invokes that build and
stages the artifacts. The adapter chooser is derived from firmware's canonical
CH341 config YAMLs (bin/config.d/lora-*.yaml) — regenerate with npm run gen:adapters.
```

## How it works

- **Sync → async.** RadioLib calls SPI synchronously; WebUSB is Promise-only.
  `wasm/libpinedio_webusb.c` implements the libpinedio API and uses `EM_ASYNC_JS`
  to `await` the JS transport; linking with **Asyncify** lets those synchronous C
  calls suspend the wasm stack. (`bridge.js` re-reads `Module.HEAPU8` after every
  suspend — the heap can grow.)
- **No pthreads, no interrupts.** RX/TX-done is detected by polling the SX126x IRQ
  flags each loop tick (the firmware's `pollMissedIrqs()` path), not a USB thread.
- **Cooperative loop.** JS calls `wasm_setup()` then pumps `wasm_loop_once()`; the
  loop's blocking delay becomes `emscripten_sleep`.
- **API.** `wasm_api_to_radio` / `wasm_api_from_radio` feed/drain the firmware's
  `PhoneAPI` (unframed `ToRadio`/`FromRadio`); all `wasm_api_*` calls happen between
  loop ticks, never mid-suspend.

## Platform caveats

- **Chromium only** — Safari has no WebUSB.
- **Linux:** the CH341 must not be bound to a kernel driver (WebUSB can't detach
  it); the SPI PID `0x5512` is usually free — add a udev rule for permissions.
- **Windows:** install the WinUSB driver for the device via Zadig.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
