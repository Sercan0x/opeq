# Security

opeq is a devnet beta. Do not use it with real funds.

## Reporting a vulnerability

Email **hello@opeq.io** with the details and, if possible, steps to reproduce. Please do not open a public issue for security problems. You will get a reply within 72 hours.

Useful areas to look at:

- the on-chain program (`program.py`, `asm.py`, reference model `refmodel.py`)
- one-time key handling in the clients (`opeq.py`, `web/lib/engine.js`): any way to make a client sign the same leaf twice for different messages is critical
- the browser extension (`extension/`)

## Scope notes

- The devnet program's upgrade authority is a single opeq wallet held by the developer. This is known and will be decided before mainnet.
- Never share your 24 recovery words. opeq will never ask for them.
