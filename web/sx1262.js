// Minimal SX126x (SX1262) command helpers over a CH341 transport.
//
// This is NOT a radio driver — it's just enough of the SX126x SPI command set
// to prove, from the browser, that: WebUSB reaches the CH341, the CH341 clocks
// SPI, and the radio responds. The real driver is RadioLib, which the wasm
// build will reuse. Pin map (CH341 D-lines) per firmware
// bin/config.d/lora-usb-meshtoad-e22.yaml (the MeshToad / E22 adapter):
//   CS=D0  RESET=D2  BUSY=D4  IRQ=D6   (RXen=D1; RF switch via DIO2_AS_RF_SWITCH,
// TCXO via DIO3 — none of which are needed for a register-read probe).
// NSS is ACTIVE-LOW: CH341 transport asserts CS by driving D0 LOW.

export const PIN = { CS: 0, RESET: 2, BUSY: 4, IRQ: 6 };

const OP = {
  GET_STATUS: 0xc0,
  WRITE_REGISTER: 0x0d,
  READ_REGISTER: 0x1d,
  SET_STANDBY: 0x80,
  GET_DEVICE_ERRORS: 0x17,
};

// Sync-word registers — safe to write/read for a non-destructive loopback test.
const REG_LORA_SYNC_WORD_MSB = 0x0740;
const SYNC_WORD_PUBLIC = [0x14, 0x24];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SX1262Probe {
  constructor(ch, log = () => {}) {
    this.ch = ch;
    this.log = log;
  }

  async waitBusy(timeoutMs = 1000) {
    const start = performance.now();
    let reads = 0;
    while ((await this.ch.digitalRead(PIN.BUSY)) === 1) {
      reads++;
      if (performance.now() - start > timeoutMs) {
        throw new Error(`BUSY stuck high after ${timeoutMs}ms (${reads} polls) — check wiring/pin map`);
      }
    }
    return reads;
  }

  // Hardware reset via the RESET line (active low), then wait for BUSY to clear.
  async reset() {
    this.ch.setPinMode(PIN.CS, true);
    this.ch.setPinMode(PIN.RESET, true);
    this.ch.setPinMode(PIN.BUSY, false);
    this.ch.setPinMode(PIN.IRQ, false);
    await this.ch.setCS(false); // deselect chip before resetting
    await this.ch.digitalWrite(PIN.RESET, 0); // assert reset
    await sleep(5);
    await this.ch.digitalWrite(PIN.RESET, 1); // release
    await sleep(10);
    await this.waitBusy(2000);
  }

  // Issue a command (opcode + args); returns the full-duplex reply, then waits
  // for BUSY so the chip is ready for the next command.
  async cmd(bytes, { wait = true } = {}) {
    const rx = await this.ch.transceive(Uint8Array.from(bytes));
    if (wait) await this.waitBusy();
    return rx;
  }

  async getStatus() {
    const rx = await this.cmd([OP.GET_STATUS, 0x00], { wait: false });
    return rx[1];
  }

  async getDeviceErrors() {
    const rx = await this.cmd([OP.GET_DEVICE_ERRORS, 0x00, 0x00, 0x00], { wait: false });
    return (rx[2] << 8) | rx[3];
  }

  async setStandby(mode = 0x00) {
    await this.cmd([OP.SET_STANDBY, mode]);
  }

  async writeRegister(addr, data) {
    await this.cmd([OP.WRITE_REGISTER, (addr >> 8) & 0xff, addr & 0xff, ...data]);
  }

  async readRegister(addr, len) {
    // opcode + addrHi + addrLo + 1 status NOP, then `len` data bytes.
    const tx = [OP.READ_REGISTER, (addr >> 8) & 0xff, addr & 0xff, 0x00, ...new Array(len).fill(0x00)];
    const rx = await this.cmd(tx, { wait: false });
    return Array.from(rx.slice(4, 4 + len));
  }

  // Full liveness check. Returns a structured result; throws only on USB/BUSY
  // faults so the caller can render partial state.
  async probe() {
    const t0 = performance.now();
    await this.reset();
    this.log("reset complete, BUSY low");

    const status = await this.getStatus();
    const mode = (status >> 4) & 0x7;
    const cmdStatus = (status >> 1) & 0x7;
    this.log(`GetStatus = 0x${status.toString(16).padStart(2, "0")} (mode=${mode}, cmdStatus=${cmdStatus})`);

    await this.setStandby(0x00); // STDBY_RC
    this.log("SetStandby(STDBY_RC)");

    // Non-destructive read+write loopback through a real radio register.
    const test = [0xde, 0xad];
    await this.writeRegister(REG_LORA_SYNC_WORD_MSB, test);
    const readBack = await this.readRegister(REG_LORA_SYNC_WORD_MSB, 2);
    const loopbackOk = readBack[0] === test[0] && readBack[1] === test[1];
    this.log(`Register loopback: wrote [${hex(test)}] read [${hex(readBack)}] -> ${loopbackOk ? "OK" : "MISMATCH"}`);
    await this.writeRegister(REG_LORA_SYNC_WORD_MSB, SYNC_WORD_PUBLIC); // restore

    const errors = await this.getDeviceErrors();
    this.log(`GetDeviceErrors = 0x${errors.toString(16).padStart(4, "0")}`);

    const elapsed = performance.now() - t0;
    return {
      ok: loopbackOk && status !== 0x00 && status !== 0xff,
      status,
      mode,
      cmdStatus,
      loopbackOk,
      readBack,
      errors,
      elapsedMs: Math.round(elapsed),
    };
  }
}

const hex = (arr) => arr.map((b) => b.toString(16).padStart(2, "0")).join(" ");
