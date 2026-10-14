export const CHAIN = "solana:devnet";

export function discoverWallets(onChange) {
  const wallets = [];
  const api = {
    register(...ws) {
      for (const w of ws) {
        const f = w.features || {};
        if (!wallets.includes(w) && f["standard:connect"] && f["solana:signTransaction"]) wallets.push(w);
      }
      onChange([...wallets]);
      return () => {};
    },
  };
  window.addEventListener("wallet-standard:register-wallet", (e) => {
    try { e.detail(api); } catch {}
  });
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  return wallets;
}

export async function connect(wallet) {
  const res = await wallet.features["standard:connect"].connect();
  const accounts = (res && res.accounts) || wallet.accounts;
  if (!accounts || !accounts.length) throw new Error("the wallet did not share an account");
  const account = accounts[0];
  return {
    name: wallet.name,
    icon: wallet.icon,
    address: account.address,
    key: () => new Uint8Array(account.publicKey),
    async sign(tx) {
      const out = await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: tx, chain: CHAIN });
      return new Uint8Array(out[0].signedTransaction);
    },
    async disconnect() {
      const d = wallet.features["standard:disconnect"];
      if (d) await d.disconnect();
    },
  };
}
