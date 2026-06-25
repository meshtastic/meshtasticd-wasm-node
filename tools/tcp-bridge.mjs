// TCP :4403 bridge: re-exposes the wasm node's PhoneAPI as the standard
// Meshtastic stream-framed TCP protocol, so unmodified clients connect —
// notably the Python CLI:  meshtastic --host localhost --port 4403 --info
//
// The firmware boundary (wasm_api_to_radio / wasm_api_from_radio) is UNFRAMED
// (one protobuf per call). This bridge only adds/strips the 4-byte stream frame
// [0x94][0xC3][len_msb][len_lsb] around each protobuf — framing is a transport
// concern, kept out of the wasm seam.
//
// RE-ENTRANCY: the wasm node only advances inside wasm_loop_once(), which
// suspends via Asyncify across the WebUSB SPI op. A socket 'data' callback can
// fire DURING that suspend, so it must NOT call into wasm. It only queues bytes;
// all wasm_api_* calls happen in pumpBridge(), which the caller invokes BETWEEN
// loop ticks (never mid-suspend).
import net from "node:net";

const START1 = 0x94;
const START2 = 0xc3;
const MAXSZ = 512;

export function startTcpBridge(Module, opts = {}) {
  const port = opts.port || 4403;
  const to_radio = Module.cwrap("wasm_api_to_radio", "number", ["number", "number"]);
  const from_radio = Module.cwrap("wasm_api_from_radio", "number", ["number", "number"]);
  const scratch = Module._malloc(MAXSZ);

  const sockets = new Set();
  const inbound = []; // queued ToRadio payloads, fed to wasm between ticks

  function feedToRadio(payload) {
    const p = Module._malloc(payload.length);
    Module.HEAPU8.set(payload, p);
    to_radio(p, payload.length);
    Module._free(p);
  }

  // Call BETWEEN wasm_loop_once() ticks: feed queued RX, then frame+broadcast TX.
  function pumpBridge() {
    while (inbound.length) feedToRadio(inbound.shift());
    if (sockets.size === 0) {
      // No client: still drain so the queue doesn't back up unbounded.
      while (from_radio(scratch, MAXSZ) > 0) {}
      return;
    }
    let n;
    while ((n = from_radio(scratch, MAXSZ)) > 0) {
      const body = Buffer.from(Module.HEAPU8.subarray(scratch, scratch + n));
      const frame = Buffer.concat([Buffer.from([START1, START2, (n >> 8) & 0xff, n & 0xff]), body]);
      for (const s of sockets) s.write(frame);
    }
  }

  const server = net.createServer((sock) => {
    sock.setNoDelay(true);
    sockets.add(sock);
    console.log(`[tcp] client connected (${sockets.size} total)`);
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        // Resync: drop bytes until the 0x94 0xC3 frame marker.
        while (buf.length >= 2 && !(buf[0] === START1 && buf[1] === START2)) buf = buf.subarray(1);
        if (buf.length < 4) break;
        const len = (buf[2] << 8) | buf[3];
        if (len > MAXSZ) {
          buf = buf.subarray(1); // bad length — resync past this marker
          continue;
        }
        if (buf.length < 4 + len) break; // wait for the whole frame
        inbound.push(Uint8Array.from(buf.subarray(4, 4 + len))); // queue; feed between ticks
        buf = buf.subarray(4 + len);
      }
    });
    const drop = () => {
      sockets.delete(sock);
      console.log(`[tcp] client gone (${sockets.size} total)`);
    };
    sock.on("close", drop);
    sock.on("error", drop);
  });

  server.listen(port, () => {
    console.log(`=== TCP API bridge on :${port} — connect with:  meshtastic --host localhost --port ${port} --info ===`);
  });

  return { pumpBridge, server };
}
