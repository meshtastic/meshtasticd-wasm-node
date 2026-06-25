// A custom @meshtastic/core Transport that talks DIRECTLY to the in-tab wasm
// node — no HTTP, no WebSocket, no sockets at all. The official SDK runs in the
// same page and drives our PhoneAPI through the four wasm exports.
//
// The SDK contract (verified against @meshtastic/core/dist):
//   Transport = { toDevice: WritableStream<Uint8Array>, fromDevice:
//                 ReadableStream<DeviceOutput>, disconnect(): Promise<void> }
//   - MeshDevice writes UNFRAMED ToRadio protobufs to toDevice (sendRaw →
//     writer.write(bytes); no 0x94c3 framing — that's a transport concern).
//   - fromDevice must enqueue DeviceOutput: {type:"packet", data:<unframed
//     FromRadio>} | {type:"status", data:{status}} | {type:"debug", data}.
// Our wasm exports are already unframed/one-protobuf-per-call, so there is NO
// framing on this path — toDevice bytes go straight to wasm_api_to_radio, and
// each wasm_api_from_radio result is enqueued as a "packet".
//
// RE-ENTRANCY: the SDK may write to toDevice at any time (its send queue runs on
// the event loop, independent of our loop). A wasm_api_* call landing during a
// wasm_loop_once() Asyncify suspend would re-enter wasm mid-SPI. So toDevice.write
// only QUEUES bytes; all wasm_api_* calls happen in pumpBetweenTicks(), which the
// page calls right after each wasm_loop_once() returns — never mid-suspend.

const DEVICE_CONNECTED = 5; // DeviceStatusEnum.DeviceConnected

export function createWasmTransport(Module) {
  const to_radio = Module.cwrap("wasm_api_to_radio", "number", ["number", "number"]);
  const from_radio = Module.cwrap("wasm_api_from_radio", "number", ["number", "number"]);
  const scratch = Module._malloc(512);

  const outbound = []; // ToRadio protobufs queued by the SDK, fed to wasm between ticks
  let controller = null;
  let closed = false;

  const fromDevice = new ReadableStream({
    start(c) {
      controller = c;
      c.enqueue({ type: "status", data: { status: DEVICE_CONNECTED } });
    },
    cancel() {
      closed = true;
    },
  });

  const toDevice = new WritableStream({
    write(chunk) {
      // chunk = one unframed ToRadio. Queue only — no wasm call here (re-entrancy).
      outbound.push(chunk.slice());
    },
  });

  // Call AFTER each wasm_loop_once(): feed queued ToRadio in, drain FromRadio out.
  function pumpBetweenTicks() {
    if (closed) return;
    while (outbound.length) {
      const chunk = outbound.shift();
      const p = Module._malloc(chunk.length);
      Module.HEAPU8.set(chunk, p);
      to_radio(p, chunk.length);
      Module._free(p);
    }
    let n;
    while ((n = from_radio(scratch, 512)) > 0) {
      // copy out of the heap immediately (it can move on the next Asyncify suspend)
      controller.enqueue({ type: "packet", data: Module.HEAPU8.slice(scratch, scratch + n) });
    }
  }

  return {
    toDevice,
    fromDevice,
    pumpBetweenTicks,
    async disconnect() {
      closed = true;
      try {
        controller.close();
      } catch (_) {}
    },
  };
}
