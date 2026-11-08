import { NETWORKS, verifySolanaInstruction, b58decode, lowLevel } from "@opeq/sdk";

const [, , rpcUrl, signature, network = "mainnet"] = process.argv;
if (!rpcUrl || !signature) throw new Error("usage: node verify.mjs <solana rpc> <transaction signature> [mainnet|devnet]");
const call = async (method, params) => {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const program = NETWORKS[network].program;
const tx = await call("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
if (!tx) throw new Error("transaction not found");
const m = tx.transaction.message, la = tx.meta.loadedAddresses || {};
const keys = [...m.accountKeys, ...(la.writable || []), ...(la.readonly || [])];
const ix = m.instructions.find((x) => keys[x.programIdIndex] === program);
if (!ix) throw new Error("this transaction has no OPEQ instruction");
const accounts = ix.accounts.map((a) => keys[a]);
const state = await call("getAccountInfo", [accounts[0], { encoding: "base64" }]);
if (!state.value || state.value.owner !== program) throw new Error("the first account is not an OPEQ state account");
const st = lowLevel.protocol.unpackState(Uint8Array.from(atob(state.value.data[0]), (c) => c.charCodeAt(0)));
const leaf = verifySolanaInstruction(b58decode(ix.data), accounts, { pubSeed: st.pubSeed, root: st.root, aid: st.id, epoch: st.epoch }, network);
console.log(leaf === null ? "does not verify against the current key tree (it may have been signed before a rekey)" : `valid quantum signature, one-time key #${leaf}`);
