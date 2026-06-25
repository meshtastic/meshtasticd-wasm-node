// Browser glue for the SX1262 hardware checkpoint.
import { CH341 } from "../src/ch341.js";
import { SX1262Probe, PIN } from "./sx1262.js";

const $ = (id) => document.getElementById(id);
const logEl = $("log");

function log(msg) {
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, cls) {
  const el = $("status");
  el.textContent = text;
  el.className = cls || "";
}

let ch = null;

async function connectAndProbe() {
  try {
    if (!("usb" in navigator)) {
      setStatus("WebUSB unavailable — use Chromium over http://localhost", "err");
      return;
    }
    setStatus("requesting device…");
    ch = await CH341.request();
    log(`selected: ${ch.device.productName || "CH341"} (serial ${ch.device.serialNumber || "?"})`);

    setStatus("opening…");
    await ch.open();
    log(`opened; VID=0x${ch.device.vendorId.toString(16)} PID=0x${ch.device.productId.toString(16)}`);
    log(`pin map: CS=D${PIN.CS} RESET=D${PIN.RESET} BUSY=D${PIN.BUSY} IRQ=D${PIN.IRQ}`);

    setStatus("probing SX1262…");
    const probe = new SX1262Probe(ch, log);

    // Quick per-transfer latency sample (this is THE number that decides how
    // slow lora.begin() will be under wasm — each SPI op is a USB round-trip).
    const tL0 = performance.now();
    const N = 20;
    for (let i = 0; i < N; i++) await ch.digitalRead(PIN.BUSY);
    const perOp = (performance.now() - tL0) / N;
    log(`USB round-trip latency ≈ ${perOp.toFixed(2)} ms/op (${N} samples)`);

    const result = await probe.probe();
    log(`probe finished in ${result.elapsedMs} ms`);

    if (result.ok) {
      setStatus(`SX1262 alive ✓  (status 0x${result.status.toString(16)}, loopback ${result.loopbackOk ? "OK" : "fail"})`, "ok");
    } else {
      setStatus(`radio responded but check failed (status 0x${result.status.toString(16)}, loopback ${result.loopbackOk ? "OK" : "fail"})`, "warn");
      log("If loopback mismatched: most likely the CS (D0) polarity or pin map differs for your adapter.");
    }
  } catch (e) {
    console.error(e);
    setStatus(`error: ${e.message}`, "err");
    log(`ERROR: ${e.message}`);
  }
}

async function disconnect() {
  if (ch) {
    await ch.close();
    log("closed");
    ch = null;
  }
  setStatus("disconnected");
}

// Sweep CS polarity against the real adapter and lock in whatever selects the
// chip. This empirically answers the "MISO reads 0xFF" question without guessing.
async function diagnose() {
  try {
    if (!("usb" in navigator)) {
      setStatus("WebUSB unavailable — use Chromium over http://localhost", "err");
      return;
    }
    if (!ch) {
      setStatus("requesting device…");
      ch = await CH341.request();
      await ch.open();
      log(`opened ${ch.device.productName || "CH341"} for diagnosis`);
    }
    setStatus("sweeping CS polarity…");
    const results = [];
    for (const csActiveLow of [true, false]) {
      ch.csActiveLow = csActiveLow;
      const label = csActiveLow ? "active-low (D0 LOW = select)" : "active-high (D0 HIGH = select)";
      log(`--- CS ${label} ---`);
      try {
        const r = await new SX1262Probe(ch, log).probe();
        results.push({ csActiveLow, ...r });
        log(`    => status=0x${r.status.toString(16)} loopback=${r.loopbackOk ? "OK" : "fail"}`);
      } catch (e) {
        log(`    => error: ${e.message}`);
      }
    }
    const win = results.find((r) => r.loopbackOk) || results.find((r) => r.status !== 0x00 && r.status !== 0xff);
    if (win) {
      ch.csActiveLow = win.csActiveLow;
      setStatus(
        `✓ working: CS ${win.csActiveLow ? "active-low" : "active-high"} (status 0x${win.status.toString(16)}, loopback ${win.loopbackOk ? "OK" : "partial"})`,
        "ok",
      );
      log(`SUCCESS: CS = ${win.csActiveLow ? "active-low" : "active-high"} selects the radio.`);
    } else {
      setStatus("no CS polarity produced a live radio — likely a pin-map difference", "warn");
      log("Neither polarity worked → next suspect is CS/RESET/BUSY pin numbers. Awaiting firmware pin-map check.");
    }
  } catch (e) {
    console.error(e);
    setStatus(`error: ${e.message}`, "err");
    log(`ERROR: ${e.message}`);
  }
}

$("connect").addEventListener("click", connectAndProbe);
$("disconnect").addEventListener("click", disconnect);
$("diagnose").addEventListener("click", diagnose);

// Offer a no-prompt reconnect if the device was already granted this session.
CH341.tryReconnect().then((c) => {
  if (c) log("a previously-granted CH341 is available — click Connect to use it");
});
