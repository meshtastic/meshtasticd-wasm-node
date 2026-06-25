export function formatWithOptions(_opts, ...args) {
  return args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
}
export const types = { isNativeError: (e) => e instanceof Error };
export default { formatWithOptions, types };
