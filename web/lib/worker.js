import { OPS } from "./compute.js";

self.onmessage = (e) => {
  const { id, op, args } = e.data;
  try {
    if (!Object.hasOwn(OPS, op)) throw new Error("unknown operation");
    const result = OPS[op](args, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err.message || err) });
  } finally {
    if (args && args.master instanceof Uint8Array) args.master.fill(0);
  }
};
