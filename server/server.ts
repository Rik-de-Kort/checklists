// Tiny sync server: serves the PWA from ../public and stores checklists in SQLite.
// Deno runs this file directly; no build step and no dependencies beyond Deno's built-in node: modules.
import { extname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import type { Records } from "../src/types.ts";
import { parseRecords } from "../src/validate.ts";

const HERE = import.meta.dirname;
if (!HERE) {
  throw new Error(
    `server.ts must run from a local file, not ${import.meta.url}`,
  );
}
const PUBLIC = resolve(HERE, "..", "public");
const DEFAULT_DB = join(HERE, "data.sqlite");
const MAX_BODY = 10 * 1024 * 1024;
const MAX_IDS = 1000;

const SCHEMA = `
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
`;

// Last-writer-wins: an incoming record only replaces a stored one if it is newer.
const UPSERT_CHECKLIST = `
INSERT INTO checklists (id, name, created_at, updated_at)
VALUES (:id, :name, :created_at, :updated_at)
ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
WHERE excluded.updated_at > checklists.updated_at
`;

const UPSERT_ITEM = `
INSERT INTO items (id, checklist_id, label, status, created_at, updated_at, deleted)
VALUES (:id, :checklist_id, :label, :status, :created_at, :updated_at, :deleted)
ON CONFLICT (id) DO UPDATE SET
    label = excluded.label,
    status = excluded.status,
    updated_at = excluded.updated_at,
    deleted = excluded.deleted
WHERE excluded.updated_at > items.updated_at
`;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** The client sent something we won't accept; becomes a 400. Anything else is our bug and a 500. */
class BadRequest extends Error {}

type Json = Record<string, unknown>;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

function push(db: DatabaseSync, body: Json): Json {
  let records: Records;
  try {
    records = parseRecords(body);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
  const upsertChecklist = db.prepare(UPSERT_CHECKLIST);
  const upsertItem = db.prepare(UPSERT_ITEM);
  db.exec("BEGIN");
  try {
    for (const c of records.checklists) upsertChecklist.run({ ...c });
    for (const i of records.items) {
      upsertItem.run({ ...i, deleted: i.deleted ? 1 : 0 });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { ok: true };
}

function pull(db: DatabaseSync, body: Json): Json {
  const ids = body["ids"];
  if (
    !Array.isArray(ids) || ids.length > MAX_IDS ||
    !ids.every((i) => typeof i === "string")
  ) {
    throw new BadRequest(`ids must be a list of at most ${MAX_IDS} strings`);
  }
  if (ids.length === 0) return { checklists: [], items: [] };
  const marks = ids.map(() => "?").join(",");
  const checklists = db.prepare(
    `SELECT * FROM checklists WHERE id IN (${marks})`,
  ).all(...ids);
  const items = db
    .prepare(`SELECT * FROM items WHERE checklist_id IN (${marks})`)
    .all(...ids)
    .map((r) => ({ ...r, deleted: r["deleted"] === 1 }));
  return { checklists, items };
}

const ROUTES: Record<string, (db: DatabaseSync, body: Json) => Json> = {
  "/api/push": push,
  "/api/pull": pull,
};

async function readJson(req: Request): Promise<Json> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) throw new BadRequest("body too large");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BadRequest("body too large");
    chunks.push(chunk);
  }
  const text = (await new Blob(chunks).text()) || "{}";
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequest("body must be a JSON object");
  }
  return body as Json;
}

/** File info, or null if there's nothing there. Other errors (permissions, I/O) propagate. */
async function statOrNull(file: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(file);
  } catch (e) {
    if (
      e instanceof Deno.errors.NotFound ||
      e instanceof Deno.errors.NotADirectory
    ) return null;
    throw e;
  }
}

async function serveStatic(req: Request, publicDir: string): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url).pathname);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
  let file = resolve(join(publicDir, pathname));
  if (file !== publicDir && !file.startsWith(publicDir + sep)) {
    return new Response(null, { status: 404 });
  }
  let info = await statOrNull(file);
  if (info?.isDirectory) {
    file = join(file, "index.html");
    info = await statOrNull(file);
  }
  if (!info?.isFile) {
    return new Response("not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }
  const headers = {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Content-Length": String(info.size),
  };
  if (req.method === "HEAD") return new Response(null, { headers });
  return new Response((await Deno.open(file)).readable, { headers });
}

async function handle(
  req: Request,
  db: DatabaseSync,
  publicDir: string,
): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "POST") {
    const route = ROUTES[path];
    if (!route) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(route(db, await readJson(req)));
  }
  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, publicDir);
  }
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET, HEAD, POST" },
  });
}

export function serve(
  db: DatabaseSync,
  options: Deno.ServeTcpOptions,
  publicDir: string = PUBLIC,
): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve(options, async (req) => {
    try {
      return await handle(req, db, publicDir);
    } catch (e) {
      if (e instanceof BadRequest) {
        return Response.json({ error: e.message }, { status: 400 });
      }
      console.error(`${req.method} ${req.url} failed:`, e);
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  });
}

function main(): void {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8000" },
      db: { type: "string", default: DEFAULT_DB },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port)) {
    throw new Error(`--port must be a number, got ${values.port}`);
  }
  serve(openDb(values.db), {
    hostname: values.host,
    port,
    onListen: () =>
      console.log(`Serving http://${values.host}:${port} (db: ${values.db})`),
  });
}

if (import.meta.main) main();
