import { readFileSync, writeFileSync } from "node:fs";

const art = (n) => JSON.parse(readFileSync(new URL(`./out/${n}.sol/${n}.json`, import.meta.url)));
const f = art("OpeqFactory"), a = art("OpeqAccount");
const strip = (h) => h.replace(/^0x/, "");
const out = `export const FACTORY_INIT = "${strip(f.bytecode.object)}";
export const FACTORY_RUNTIME = "${strip(f.deployedBytecode.object)}";
export const ACCOUNT_INIT = "${strip(a.bytecode.object)}";
export const ACCOUNT_RUNTIME = "${strip(a.deployedBytecode.object)}";
`;
writeFileSync(new URL("../web/lib/evmcode.js", import.meta.url), out);
console.log("evmcode.js", out.length, "bytes");
