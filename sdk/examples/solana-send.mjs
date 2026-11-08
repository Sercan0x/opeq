import { Vault, NETWORKS } from "@opeq/sdk";
import { FileStore } from "@opeq/sdk/filestore";

const [, , cmd, ...rest] = process.argv;
const network = process.env.OPEQ_NETWORK || "devnet";
const password = process.env.OPEQ_PASSWORD;
if (!password) throw new Error("set OPEQ_PASSWORD");
if (!process.env.OPEQ_RPC) throw new Error(`set OPEQ_RPC to a Solana ${network} RPC URL`);

const store = await FileStore.open(process.env.OPEQ_DIR || "./opeq-wallet");
const vault = new Vault({ rpcUrl: process.env.OPEQ_RPC, network, store });
try {
  if (cmd === "create") {
    const { id, words } = await vault.create(password);
    console.log("wallet", id);
    console.log("write these 24 words down and keep them offline:\n" + words);
  } else {
    const [w] = await vault.list();
    if (!w) throw new Error("no wallet yet, run: create");
    const acct = await vault.open(w.id, password);
    try {
      console.log("wallet", acct.address, "fee key", await acct.feeKey());
      if (cmd === "activate") console.log(await acct.activate());
      else if (cmd === "status") console.log(await acct.status(), "balance", await acct.balance());
      else if (cmd === "send") console.log("signature", await acct.send(rest[0], BigInt(rest[1])));
      else if (cmd === "rekey") console.log(await acct.rekey());
      else console.log("commands: create, activate, status, send <to> <lamports>, rekey");
    } finally { acct.close(); }
  }
} finally { await store.close(); }
console.log("program", NETWORKS[network].program);
