import { readFileSync, writeFileSync } from "node:fs";

const art = JSON.parse(readFileSync(new URL("./out/OpeqSafeGuard.sol/OpeqSafeGuard.json", import.meta.url)));
const strip = (h) => h.replace(/^0x/, "");
const out = `export const GUARD_INIT = "${strip(art.bytecode.object)}";
export const GUARD_RUNTIME = "${strip(art.deployedBytecode.object)}";
`;
writeFileSync(new URL("../web/lib/safeguardcode.js", import.meta.url), out);
console.log("safeguardcode.js", out.length, "bytes");
