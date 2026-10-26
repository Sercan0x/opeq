<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
  <img alt="opeq" src="assets/logo-light.png" width="480">
</picture>

# opeq

Solana wallets built to resist quantum computers, usable with any Solana program.

Every Solana wallet today is protected by Ed25519. A large enough quantum computer running Shor's algorithm recovers an Ed25519 private key from its public key, and on Solana the address *is* the public key. opeq replaces that signature with a hash-based one whose security rests only on SHA-256, without any change to the Solana protocol.

> **Status: mainnet beta.** The program and the wallet have been through repeated internal adversarial reviews and a full test suite, but no external audit yet. The program can still be upgraded by a single admin opeq wallet with no timelock (see below). Start with small amounts.

## What it does

- **A normal Solana address.** Your opeq wallet is a program-derived address with no Ed25519 private key behind it. The only secret is your 24 recovery words, which produce hash-based keys. It receives SOL, holds SPL and Token-2022 tokens, and other programs see it as an ordinary signer.
- **Any program, one signature.** One hash-based signature authorizes a list of instructions to any programs. Tested: SOL transfers, SPL Token, Token-2022, Memo, Associated Token Account creation, Raydium CPMM swaps on devnet, and Jupiter swaps on mainnet.
- **Stable address.** One key tree signs 688 wallet transactions (the program accepts up to 1008; the wallet keeps the rest for safe rekeys and device takeovers). A rekey moves the wallet to a fresh tree; the address and balances stay the same.
- **24 recovery words.** Every tree is derived from one 256-bit master seed shown as standard BIP39 words. The words never change, even after many rekeys, and restore the wallet with no files.
- **Quantum-safe upgrades.** The program's upgrade authority is itself an opeq wallet, so a broken Ed25519 key cannot change the code. On mainnet that authority is `6KX8M2fwCGyMTFodAL2HE1gbhwM5vYzfia2rsjhuHPU8`, the wallet of an admin opeq vault held by the developer on the immutable governance program `2UpwhLHUUS1Uqij7KVdXxLRWjt8yCssdFjB2QG4saRAj`. The developer can upgrade the program and there is no timelock yet.

## Browser extension

**OPEQ Wallet** (mainnet) and **OPEQ Wallet (Devnet)** are Chrome extensions. The source is in `extension/` and shares `web/lib` with the opeq.io web wallet.

- Toolbar popup and a full-tab view, two permissions: `storage` (encrypted vault in IndexedDB, unlocked session in memory, activity log and RPC setting in local storage) and `alarms` (locks an idle session after 10 minutes)
- Mainnet swaps go through Jupiter; the wallet checks every returned instruction against the quote and a pinned pool list, and simulates the signed transaction before sending it
- Network fees are paid by a small Ed25519 fee key derived from the same 24 words. It has no power over the wallet; the wallet tops it up from inside its own signed transactions
- One active copy per wallet: a recovered copy must choose *Use on this device* (a rekey) before it signs, and any other copy then stops signing. This prevents two installs from ever signing the same one-time key
- Build: `python3 build_extension.py` (output in `build/extension`, `--zip` for the store package)

Install the mainnet wallet from the [Chrome Web Store](https://chromewebstore.google.com/detail/opeq-wallet/ppddghgloaomicpgkpodjenaogmhhijj), or build the extension yourself and load `build/extension-mainnet` with *Load unpacked* on `chrome://extensions`. A mainnet build checks the program, its governance and the admin vault on chain:

```
python3 build_extension.py --net mainnet --version 1.0.0 \
  --program HL598vrersxS5AUUV6NyzHgpSyK31xAmqMsqUhxzeKm8 \
  --authority 6KX8M2fwCGyMTFodAL2HE1gbhwM5vYzfia2rsjhuHPU8 \
  --gov 2UpwhLHUUS1Uqij7KVdXxLRWjt8yCssdFjB2QG4saRAj \
  --admin-state 3AMt6BShy2aigE8hRAAnrHsPR4kedNjbtGo2tCxKuJTp \
  --rpc https://api.mainnet-beta.solana.com
```

The build is reproducible: with `--rpc https://rpc.opeq.io` instead, `build/extension-mainnet` matches the package submitted to the store (version 1.0.0) file for file. To compare it with your own install, Chrome keeps the store copy in its profile folder under `Extensions/ppddghgloaomicpgkpodjenaogmhhijj/1.0.0_0` (on Windows `%LOCALAPPDATA%\Google\Chrome\User Data\Default\Extensions\...`). The store adds its own `_metadata` signature folder, adds store fields such as `update_url` to `manifest.json`, and re-encodes the icon images, so leave those out:

```
diff -r --exclude=_metadata --exclude=manifest.json --exclude=icons build/extension-mainnet <installed folder>
```

A self-built copy has its own extension id, and `rpc.opeq.io` will only serve the store build. Set your own mainnet RPC in the Keys tab (the wallet checks that it really is mainnet). The words, the vault and every signature stay on your machine either way.

## USB edition (beta)

The USB edition runs straight from a USB stick on Windows: plug it in, double-click `OPEQ`, and the wallet opens in its own Chrome or Edge window. Nothing is installed and the store extension is not involved. It is built from the mainnet extension by `build_usb.py`:

- `OPEQ.cmd` starts `app/opeq.ps1` with PowerShell. Windows blocks downloaded scripts by default, so the launcher passes `-ExecutionPolicy Bypass` for that one run; it changes no system setting.
- `opeq.ps1` listens on `127.0.0.1:47821` only. It serves the wallet files and reads and writes `data/opeq-wallet.json` on the stick. Every launch makes a random token that the page must send; requests with another `Host` or `Origin` are refused before any body is read, each connection gets 2 seconds in total, and writes go to a temporary file that replaces the wallet file in one step (a half-written save is recovered on the next start).
- The browser opens with `--app` and a throwaway profile in `%TEMP%` with password saving off, deleted when the window closes. Pulling the stick out closes the window.
- The vault, the one-time key counter, the activity log and settings all live in that one file. There is no "stay unlocked" copy, the wallet locks after 3 minutes without activity or 2 minutes in the background, the vault password is stretched with 2,000,000 PBKDF2 rounds, and a custom RPC is kept for the session only.
- `OPEQ.cmd` and `opeq.ps1` notice when they run from inside the zip and say to extract it first. The page warns when the folder sits on the computer's own drive instead of a stick, and the activation screen checks the activation address every few seconds and says when the SOL has arrived.
- A one-time key whose transaction expired is burned on chain, so a wallet file that is later copied or rolled back cannot sign with it again. The wallet file also remembers the stick's volume serial and warns when it shows up on a different stick.

### Code check

The stick carries code as well as the wallet, so a computer with malware could change the code on the stick. At every start `opeq.ps1` hashes every file it ships with and compares them with `https://opeq.io/usb/<version>.json`, which `build_usb.py` writes to `web/usb/` and the site deploy publishes. If any file differs, or an extra file appears, the wallet refuses to open and lists the files. This catches untargeted changes; it runs from the stick itself, so a careful attacker can change the check too. The README on the stick tells users to plug it only into trusted computers and recommends a stick with a write-protect switch.

The key is still opened on the computer for the moment of signing, so this protects a wallet at rest, not against malware running on the computer while you sign. A hardware signer is a separate, later step.

```
python3 build_usb.py --zip
```

This writes `build/OPEQ-USB/` (`OPEQ.cmd`, `app/`, an empty `data/` and `README.txt` with the steps), `build/OPEQ-USB.zip` and `web/usb/<version>.json`. The zip is reproducible: the same commit always gives the same SHA-256.

## How it works

| Piece | Choice |
|---|---|
| One-time signature | WOTS+ with n = 16 bytes, w = 256 (16 message + 2 checksum chains, 288-byte signature) |
| Many-time key | Merkle tree of height 10 over 1024 one-time keys (160-byte auth path), last 16 leaves reserved for rekey |
| Hashing | SHA-256 truncated to 16 bytes, tweaked with a per-account public seed and an address field, in the style of SPHINCS+ / SLH-DSA |
| Security target | about 128-bit classical and 64-bit quantum per one-time key, the same category as SLH-DSA-128 |
| Signed message | randomizer, domain tag, program id, account id, epoch, leaf, expiry slot, every inner instruction (program, accounts, flags, data), salt |
| Cost | the client grinds a 32-bit salt so verification needs about 1275 hash steps: roughly 160k compute units for a transfer, 200k for a Raydium swap |

On chain there are two addresses per wallet:

- a **state** account owned by the program (Merkle root, public seed, next leaf, epoch), and
- the **wallet** itself, a data-less PDA that the program signs for with `invoke_signed` after a valid signature.

The program checks the expiry slot, refuses any leaf below the on-chain counter, recomputes the message digest from the instruction it received, verifies the WOTS+ chains and the Merkle path, advances the counter, and only then performs the CPIs.

Transaction fees are still paid by an ordinary Ed25519 account. Breaking that key costs its owner the fee balance, never the opeq wallet.

## Built from scratch

There is no Rust, LLVM or Solana CLI in this repository. Everything is plain Python 3:

| File | Purpose |
|---|---|
| `wots.py` | WOTS+ and the Merkle tree |
| `protocol.py` | wire format, digests, state layout |
| `asm.py` | sBPF v3 assembler and strict ELF writer |
| `program.py` | the on-chain program, written in assembly through `asm.py` |
| `emu.py` | an sBPF interpreter with Solana syscalls, CPI checks and compute-unit accounting |
| `refmodel.py` | reference model of the program, used as a test oracle |
| `test_emu.py` | program tests and differential fuzzing against the reference model |
| `test_client.py` | client tests against a fake chain that runs the real program in the emulator |
| `deploy.py` | upgradeable loader deploy and upgrade |
| `v0.py` | versioned transactions and address lookup tables |
| `keystore.py` | scrypt + AES-256-GCM key storage with a whole-file HMAC |
| `mnemonic.py`, `wordlist.py` | 24-word recovery phrase (BIP39 English list) and per-epoch tree derivation |
| `opeq.py` | command line client |
| `token_demo.py`, `swap_demo.py` | token and Raydium demos |

The emulator's compute-unit count matched devnet within 0.05%.

## Quick start (devnet)

Requirements: Python 3.10+ and the `cryptography` package.

```
python3 test_emu.py          # program tests + fuzzing
python3 test_client.py       # client tests on a simulated chain

python3 deploy.py newkey                 # fee payer, fund it from faucet.solana.com
python3 program.py build/opeq.elf
python3 deploy.py deploy --elf build/opeq.elf --program-key opeq-program.json

python3 opeq.py keygen --program <PROGRAM_ID>      # shows 24 words, then asks for a password
python3 opeq.py init
python3 opeq.py status
python3 opeq.py send --to <ADDRESS> --sol 0.01
python3 opeq.py rekey
python3 opeq.py backup                               # show the 24 words again
python3 opeq.py recover --program <PROGRAM_ID> --vault restored.json
```

The vault file holds the encrypted master seed. Keep one copy in use at a time: two machines signing from the same file can reuse a one-time key. `recover` reads the on-chain counter and skips 64 keys, and `restore` does the same for an older copy of a vault file.

## Mainnet deployment

| | Address |
|---|---|
| Program | `HL598vrersxS5AUUV6NyzHgpSyK31xAmqMsqUhxzeKm8` |
| Upgrade authority (an opeq wallet) | `6KX8M2fwCGyMTFodAL2HE1gbhwM5vYzfia2rsjhuHPU8` |
| Governance program (immutable) | `2UpwhLHUUS1Uqij7KVdXxLRWjt8yCssdFjB2QG4saRAj` |
| Admin vault state | `3AMt6BShy2aigE8hRAAnrHsPR4kedNjbtGo2tCxKuJTp` |
| Swap lookup table (frozen) | `FqmZkMZWoA3Z5c5epD9M1PSDts44iBojrqGyxE6xcJEq` |
| Program code sha256 | `b16442593877287bd4078207ef663a79cc1f3e555f957db39d547db5750e7893` |

The code is reproducible: `python3 -c "import program, hashlib; print(hashlib.sha256(program.build().elf()).hexdigest())"` prints the hash above, and the on-chain program data matches it byte for byte.

## Devnet deployment

| | Address |
|---|---|
| Program | `424ckcA6GGswYmQbrGjQmzdfhk4G9eB2zD1gK8xLw7sN` |
| Upgrade authority (an opeq wallet) | `FoWCn5Rj4jPuMLqpUSQ7KkQrMK5RhFNNhzs6ZLsxxzdm` |

## Open items

- upgrade governance: a timelock or an immutable program
- an external audit
- done 2026-10-19: mainnet deployed with fresh program keys; the governance program is immutable and holds the admin vault
- done 2026-10-12: the live devnet program runs v1.1, which caps a signature's expiry at 300 slots ahead on chain so no client can ever emit a non-expiring authorization. It was upgraded through its own quantum-signed exec (transaction `5fYWB4XrtyUvStFVPU5qD9c8iWjpFtBJ4LqSFJzthN7Swd6svEcdB7jJ6AVbakG9fevstDLJMbT55amsvMLw8GAD`), after the same self-upgrade path was rehearsed on test program `9MPeZzh3rdpJA88AtZ26j5yrDwcsdzWCzJ4jWoEQhBnG`

## License

Apache License 2.0, see [LICENSE](LICENSE). The license covers the code only. The opeq name and logo are not licensed for use by other projects.
