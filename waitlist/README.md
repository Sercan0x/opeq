# opeq waitlist

Collects emails plus two X tasks: follow @opeqio, then post about opeq. No emails are sent and no X login is used. Users type their X username and paste the link to their post, so both can be checked by hand.

## API

Steps run in this order on the page: follow @opeqio and type your X username, post on X and paste the link, then join with your email. Steps unlock one by one. Nothing is stored until the last step, and the server refuses a sign-up that is missing any of the three.

`POST /api/waitlist/join` with JSON `handle`, `url`, `email` returns `{"ok": true}`. Errors return `error` and `step` (`follow`, `post` or `email`) so the page can reopen the right step.

`GET /api/waitlist/export` with `Authorization: Bearer <ADMIN>` returns every row as JSON.

Rules: one entry per email, a post link can only be used once (the username part is compared without case), the post must come from the same account as the username, and at most 20 sign-ups per network per hour. Only a SHA-256 of each IP is stored.

## Local

`python3 web/test/serve.py 8790` serves the site and the API, with data in `waitlist/dev.db`. Export needs `WAITLIST_ADMIN` set when the server starts.

## Cloudflare

1. Create a D1 database and run `schema.sql` in its console.
2. Create a Worker from `worker.js`. Bind the database as `DB`, and the static site as `ASSETS`.
3. Add two secrets: `SALT` (random) and `ADMIN` (random, used for export).
4. Add `connect-src 'self'` to the CSP. It is already in `web/_headers` and `index.html`.
