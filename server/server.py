#!/usr/bin/env python3
"""Tiny sync server: serves the PWA from ../public and stores checklists in SQLite."""
import argparse
import json
import sqlite3
from collections.abc import Callable
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Literal, TypedDict

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public"
MAX_BODY = 10 * 1024 * 1024
MAX_IDS = 1000

SCHEMA = """
CREATE TABLE IF NOT EXISTS checklists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    checklist_id TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_checklist ON items (checklist_id);
"""

# Last-writer-wins: an incoming record only replaces a stored one if it is newer.
UPSERT_CHECKLIST = """
INSERT INTO checklists (id, name, created_at, updated_at)
VALUES (:id, :name, :created_at, :updated_at)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
WHERE excluded.updated_at > checklists.updated_at
"""

UPSERT_ITEM = """
INSERT INTO items (id, checklist_id, label, status, created_at, updated_at, deleted)
VALUES (:id, :checklist_id, :label, :status, :created_at, :updated_at, :deleted)
ON CONFLICT (id) DO UPDATE SET
    label = excluded.label,
    status = excluded.status,
    updated_at = excluded.updated_at,
    deleted = excluded.deleted
WHERE excluded.updated_at > items.updated_at
"""


class BadRequest(Exception):
    pass


class ChecklistRow(TypedDict):
    id: str
    name: str
    created_at: int
    updated_at: int


class ItemRow(TypedDict):
    id: str
    checklist_id: str
    label: str
    status: Literal["checked", "unchecked"]
    created_at: int
    updated_at: int
    deleted: int


Json = dict[str, Any]


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def checklist_row(c: Any) -> ChecklistRow:
    try:
        return {
            "id": str(c["id"]),
            "name": str(c["name"]),
            "created_at": int(c["created_at"]),
            "updated_at": int(c["updated_at"]),
        }
    except (KeyError, TypeError, ValueError) as e:
        raise BadRequest(f"invalid checklist: {e!r}")


def item_row(i: Any) -> ItemRow:
    try:
        if i["status"] not in ("checked", "unchecked"):
            raise ValueError(i["status"])
        return {
            "id": str(i["id"]),
            "checklist_id": str(i["checklist_id"]),
            "label": str(i["label"]),
            "status": i["status"],
            "created_at": int(i["created_at"]),
            "updated_at": int(i["updated_at"]),
            "deleted": int(bool(i.get("deleted", False))),
        }
    except (KeyError, TypeError, ValueError) as e:
        raise BadRequest(f"invalid item: {e!r}")


def push(conn: sqlite3.Connection, body: Json) -> Json:
    checklists = [checklist_row(c) for c in body.get("checklists", [])]
    items = [item_row(i) for i in body.get("items", [])]
    with conn:
        conn.executemany(UPSERT_CHECKLIST, checklists)
        conn.executemany(UPSERT_ITEM, items)
    return {"ok": True}


def pull(conn: sqlite3.Connection, body: Json) -> Json:
    ids = body.get("ids")
    if not isinstance(ids, list) or len(ids) > MAX_IDS or not all(isinstance(i, str) for i in ids):
        raise BadRequest(f"ids must be a list of at most {MAX_IDS} strings")
    if not ids:
        return {"checklists": [], "items": []}
    marks = ",".join("?" * len(ids))
    checklists = [dict(r) for r in conn.execute(f"SELECT * FROM checklists WHERE id IN ({marks})", ids)]
    items = [
        dict(r, deleted=bool(r["deleted"]))
        for r in conn.execute(f"SELECT * FROM items WHERE checklist_id IN ({marks})", ids)
    ]
    return {"checklists": checklists, "items": items}


ROUTES: dict[str, Callable[[sqlite3.Connection, Json], Json]] = {"/api/push": push, "/api/pull": pull}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args: Any, db_path: str, **kwargs: Any) -> None:
        self.db_path = db_path
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def do_POST(self) -> None:
        route = ROUTES.get(self.path)
        if route is None:
            return self.send_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length > MAX_BODY:
                raise BadRequest("body too large")
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                raise BadRequest("body must be a JSON object")
            conn = connect(self.db_path)
            try:
                result = route(conn, body)
            finally:
                conn.close()
        except (BadRequest, ValueError) as e:  # JSONDecodeError is a ValueError
            return self.send_json(400, {"error": str(e)})
        self.send_json(200, result)

    def send_json(self, status: int, data: Json) -> None:
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--db", default=str(HERE / "data.sqlite"))
    args = parser.parse_args()

    conn = connect(args.db)
    conn.executescript(SCHEMA)
    conn.close()

    server = ThreadingHTTPServer((args.host, args.port), partial(Handler, db_path=args.db))
    print(f"Serving http://{args.host}:{args.port} (db: {args.db})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
