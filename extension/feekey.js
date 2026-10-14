import { b58encode, compact, concat } from "./lib/solana.js";

const PKCS8_ED25519 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const TAG = new TextEncoder().encode("opeq/fee/v1");
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function feePayer(master) {
  const input = concat(TAG, master);
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  input.fill(0);
  const pkcs8 = concat(PKCS8_ED25519, seed);
  let key, pub;
  try {
    const probe = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
    pub = unb64url((await crypto.subtle.exportKey("jwk", probe)).x);
    key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    throw new Error("this browser has no Ed25519 support in WebCrypto; update Chrome to version 137 or later");
  } finally {
    seed.fill(0);
    pkcs8.fill(0);
  }
  return {
    address: b58encode(pub),
    key: () => pub,
    async sign(tx) {
      const n = tx[0];
      if (n !== 1) throw new Error("fee key only signs single-signer transactions");
      const message = tx.slice(1 + 64);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message));
      return concat(new Uint8Array(compact(1)), sig, message);
    },
  };
}
