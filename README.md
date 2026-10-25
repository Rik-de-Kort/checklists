# Checklists

A home-cooked, offline-first, chat-style checklist PWA. TypeScript compiled by `tsc`, no bundler, no runtime
dependencies. See `spec.md`.

## Run

```sh
npm install
npm run dev                         # compile src/ to public/, watch, and serve http://127.0.0.1:8000
node server/server.ts --host 0.0.0.0 --port 8000 --db /path/to/data.sqlite
```

The source is TypeScript in `src/`; `npm run build` compiles it into `public/js/` (and `public/sw.js`),
which is not committed. `npm test` type-checks and runs the tests in `tests/` (Node runs the `.ts` files
directly), including the server tests, which run the app's sync against a real server.

The server needs Node 26 (it uses the built-in `node:sqlite` and runs its `.ts` source directly).

The server serves `public/` and the sync API. The app also works from any static host;
sync then just shows an error state.

The app needs the Temporal API (current Chrome, Edge and Firefox) and refuses to start without it.
Service workers, `navigator.share` and the clipboard need a secure context: `localhost`
works, but to use it from a phone put the server behind HTTPS (e.g. Caddy or Tailscale serve).

## How it works

- `src/store.ts`: all data in one localStorage blob. Every record has `updated_at` (UTC epoch ms);
  items are soft-deleted (`deleted: true`) so deletes sync. Unreadable data stops the app instead of
  being replaced, and a copy is kept in `localStorage["checklist-db-corrupt"]`.
- `src/actions.ts`: every change is an action on an undo stack (kept in sessionStorage, last 100).
  Undoing a change that hasn't synced yet restores the records exactly; undoing a synced change
  writes a new change (fresh `updated_at`, tombstones) so it propagates.
- `src/ui.ts`: hash routes `#/` (overview) and `#/c/<uuid>` (checklist).
- `src/time.ts`: Temporal helpers. Storage and sync use UTC epoch ms; local time is display-only.
- `src/errors.ts`: uncaught errors show a red banner (phones have no visible console).
- `src/sync.ts` + `server/server.ts`: `POST /api/push {checklists, items}` and
  `POST /api/pull {ids}`, merged last-writer-wins per record on both sides, using each device's clock.
  The server validates pushes with the app's own `src/validate.ts`.
- Deleting a checklist only removes it from this device; the server copy stays, and opening
  its link again pulls it back.
- No accounts or auth: a checklist's UUID in the share link is the only key to it.
