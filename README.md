# Checklists

A home-cooked, offline-first, chat-style checklist PWA. Plain HTML/CSS/JS, no build step. See `spec.md`.

## Run

```sh
python3 server/server.py            # http://127.0.0.1:8000, data in server/data.sqlite
python3 server/server.py --host 0.0.0.0 --port 8000 --db /path/to/data.sqlite
```

The server serves `public/` and the sync API. The app also works from any static host;
sync then just shows an error state.

Service workers, `navigator.share` and the clipboard need a secure context: `localhost`
works, but to use it from a phone put the server behind HTTPS (e.g. Caddy or Tailscale serve).

## How it works

- `public/js/store.js`: all data in one localStorage blob. Every record has `updated_at`;
  items are soft-deleted (`deleted: true`) so deletes sync.
- `public/js/actions.js`: every change is an action on an undo stack (kept in sessionStorage, last 100).
- `public/js/ui.js`: hash routes `#/` (overview) and `#/c/<uuid>` (checklist).
- `public/js/sync.js` + `server/server.py`: `POST /api/push {checklists, items}` and
  `POST /api/pull {ids}`, merged last-writer-wins per record on both sides.
- Deleting a checklist only removes it from this device; the server copy stays, and opening
  its link again pulls it back.
- No accounts or auth: a checklist's UUID in the share link is the only key to it.
