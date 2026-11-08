import { homedir } from "node:os";
import { join } from "node:path";
import { Vault } from "@opeq/sdk";
import { FileStore } from "@opeq/sdk/filestore";

const [, , cmd, ...rest] = process.argv;
const chainId = Number(process.env.OPEQ_CHAIN || 8453);
const password = process.env.OPEQ_PASSWORD;
const rpcUrl = process.env.OPEQ_EVM_RPC, checkUrl = process.env.OPEQ_EVM_CHECK;
if (!password || !rpcUrl || !checkUrl) throw new Error("set OPEQ_PASSWORD, OPEQ_EVM_RPC and OPEQ_EVM_CHECK (two independent RPCs)");

const store = await FileStore.open(process.env.OPEQ_DIR || join(homedir(), ".opeq-sdk-wallet"));
const vault = new Vault({ rpcUrl: process.env.OPEQ_RPC || "https://api.mainnet-beta.solana.com", checkRpcUrl: process.env.OPEQ_CHECK_RPC || "https://solana-rpc.publicnode.com", network: process.env.OPEQ_NETWORK || "mainnet", store });
try {
  const [w] = await vault.list();
  if (!w) throw new Error("no wallet yet, create one with solana-send.mjs create");
  const acct = await vault.open(w.id, password);
  try {
    const evm = await acct.evm(chainId, { rpcUrl, checkUrl });
    console.log("account", evm.address, "fee key", evm.feeAddress);
    if (cmd === "status") console.log(await evm.status());
    else if (cmd === "setup") console.log(await evm.setup(null, (s) => console.log("-", s)));
    else if (cmd === "send") console.log(await evm.send(rest[0], BigInt(rest[1]), (h) => console.log("tx", h)));
    else if (cmd === "rekey") console.log(await evm.rekey());
    else console.log("commands: status, setup, send <to> <wei>, rekey");
  } finally { acct.close(); }
} finally { await store.close(); }
