// Browser shim for tslog (pulls node's util/os/path otherwise). The SDK only
// uses Logger + getSubLogger + debug/trace/error; route the loud ones to console.
export class Logger {
  constructor(_opts) {}
  getSubLogger(_opts) { return this; }
  silly() {} trace() {} debug() {} info() {}
  warn(...a) { console.warn(...a); }
  error(...a) { console.error(...a); }
  fatal(...a) { console.error(...a); }
}
export default { Logger };
