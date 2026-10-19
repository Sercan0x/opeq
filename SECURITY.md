# Security

opeq is a mainnet beta. Start with small amounts. There has been no external audit yet.

## Reporting a vulnerability

Email **hello@opeq.io** with the details and, if possible, steps to reproduce. Please do not open a public issue for security problems. You will get a reply within 72 hours.

Useful areas to look at:

- the on-chain program (`program.py`, `asm.py`, reference model `refmodel.py`)
- one-time key handling in the clients (`opeq.py`, `web/lib/engine.js`): any way to make a client sign the same leaf twice for different messages is critical
- the browser extension (`extension/`)

## Scope notes

- The mainnet program's upgrade authority is a single opeq wallet held by the developer, with no timelock. This is a known trust assumption.
- Swaps rely on Jupiter's public API for routes. The wallet does not trust it: every instruction is checked and the signed transaction is simulated before it is sent.
- If two devices both try *Use on this device* at the same time and both attempts fail to land, they can pick the same one-time key (about 1 in 256). Retry on the device you started on.
- Never share your 24 recovery words. opeq will never ask for them.
