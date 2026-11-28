# Contributing

Thanks for looking at opeq. The project is a mainnet beta, so small, careful changes are the most useful.

## Security problems

Do not open a public issue for a vulnerability. Email **hello@opeq.io** as described in [SECURITY.md](SECURITY.md).

## Issues

- Bug reports: say which edition (Chrome extension, USB, web, SDK or DOKO), the version, the network and the steps that show the problem. Never paste recovery words, vault files or private keys.
- Ideas: describe the problem first, then the change you have in mind.

## Code

- The code is hand-written with no runtime dependencies. Please keep it that way: no new packages.
- Keep the style of the file you change. Code carries no comments; explain the change in the pull request instead.
- Run the tests that cover your change before you open a pull request, for example `python3 test_client.py`, `node test_bot.mjs`, `node test_indicators.mjs` or the tests in `sdk/test` and `evm/`.
- Anything that signs, builds a transaction or checks one needs a test that shows the new behaviour, and a test that shows a wrong input is refused.

By contributing you agree that your work is released under the Apache License 2.0, as in [LICENSE](LICENSE).
