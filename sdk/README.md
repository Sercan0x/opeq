# @opeq/sdk

Quantum-resistant accounts for Solana, Ethereum, Base, Arbitrum and Robinhood Chain.

An OPEQ account is controlled by hash-based one-time keys (WOTS+ in a Merkle tree of 1024 keys) instead of an elliptic-curve key. A quantum computer that breaks Ed25519 or secp256k1 does not break it. This SDK lets you create those accounts, sign with them and verify their signatures from your own code.

It is the same code the OPEQ wallet runs. `src/` is copied byte for byte from the wallet's library by `build_sdk.py`, and the test suite fails if the two ever differ. It has no dependencies.

## Status

**Beta, not yet externally audited.** The audits planned for the wallet will cover this SDK too. Until then, use small amounts.

**Upgrade authority.** The Solana program (`HL598vrersxS5AUUV6NyzHgpSyK31xAmqMsqUhxzeKm8`) can still be upgraded by the OPEQ team. The plan is to give that up after the audits. The program cannot move funds on its own: every transfer needs a one-time signature from the account's own key tree. The EVM account and factory contracts are not upgradeable.

## Install

```
npm install @opeq/sdk
```

Node.js 20 or later, or any current browser. In Node, use `FileStore`; in a browser, `IdbStore`. Both refuse to move a key counter backwards.

## The one rule

**A one-time key must never sign twice.** The SDK enforces this for you:

- Every store refuses to move a key counter backwards.
- `FileStore` locks its folder, so two processes cannot use the same wallet at once.
- Signing jobs inside one process run one at a time.

What the SDK cannot see is a second copy somewhere else. If the same 24 words are used on another device, that device must call `useHere()` first. It moves the account to a fresh key tree, and the old copy stops signing. Never restore a store from a backup to continue signing; recover from the words and call `useHere()` instead.

## Solana

```js
import { Vault } from "@opeq/sdk";
import { FileStore } from "@opeq/sdk/filestore";

const store = await FileStore.open("./opeq-wallet");
const vault = new Vault({ rpcUrl: "https://your-solana-rpc", network: "mainnet", store });

const { id, words } = await vault.create(password);
const acct = await vault.open(id, password);

await acct.feeKey();
await acct.activate();
await acct.send(to, 1_000_000n);
await acct.execute([instruction]);
await acct.rekey();

acct.close();
await store.close();
```

- `acct.address` is the quantum account. Keep funds there.
- `await acct.feeKey()` returns the fee key's address. It only pays Solana network fees, signs with Ed25519 and is not quantum-safe, so keep only a little SOL on it.
- `activate()` writes the account's key root on chain once. The fee key pays for it.
- `execute()` takes web3.js-style instructions (`{ programId, keys, data }`) or `[program, [[key, signer, writable]], data]`. The account signs as the wallet address.
- `status()` reports how many one-time keys are left. Call `rekey()` before they run out; it moves the account to a new tree.
- `recover(words, password)` brings an existing account into a new store. Then call `useHere()` (see the rule above).

## EVM

```js
const acct = await vault.open(id, password);
const base = await acct.evm(8453, { rpcUrl: "https://your-base-rpc", checkUrl: "https://a-second-base-rpc" });

console.log(base.address, base.feeAddress);
await base.setup();
await base.send(to, 10n ** 16n);
await base.execute([{ to: token, value: 0n, data: "0xa9059cbb..." }]);

acct.close();
```

- Chains: 1 (Ethereum), 8453 (Base), 42161 (Arbitrum), 4663 (Robinhood Chain).
- `checkUrl` must be a second, independent RPC. Before signing, the SDK checks the account state on both and refuses if they disagree.
- The same words give the same account address on every chain.
- The fee key (`feeAddress`) pays gas. It is an ordinary secp256k1 key, so keep only gas money on it.
- `setup()` deploys the account contract and moves it to a key tree only this device knows. It needs gas on the fee key.

## Verify without trusting anyone

```js
import { verifySolanaInstruction, verifyEvmExecute } from "@opeq/sdk";

verifySolanaInstruction(data, accountKeys, { pubSeed, root, aid, epoch });
verifyEvmExecute(calldata, { chainId, account, epoch, pubSeed, root });
```

Both return the one-time key index, or `null` if the signature does not match. They make no network calls. `examples/verify.mjs` checks a landed Solana transaction against the account's key root on chain.

## Speed

Building a key tree takes about 2 seconds on Solana and about 10 seconds on EVM in Node on a laptop. Signing takes under a second. EVM `setup()` builds three trees, so it takes about a minute. In a browser, pass `new Vault({ compute })` with a `run(op, args)` that hands the job to a Web Worker running `OPS` from `@opeq/sdk/compute`, so the page does not freeze.

## RPC

Bring your own. `rpc.opeq.io` only serves the OPEQ apps.

## Tests

```
python3 build_sdk.py
node sdk/test/run.mjs
node sdk/test/e2e_anvil.mjs
node sdk/test/e2e_devnet.mjs <funded devnet keypair json>
```

- `run.mjs` checks the JS code against vectors from the Python reference implementation (`sdk/test/gen_vectors.py`): words, key trees, addresses, signatures and the exact signed message. Every result must be byte-identical.
- `e2e_anvil.mjs` runs a full EVM account on a local chain: setup, sends, offline verification, and a takeover from a second device.
- `e2e_devnet.mjs` does the same on Solana devnet: activate, send, verify, rekey.

## License

Apache-2.0
