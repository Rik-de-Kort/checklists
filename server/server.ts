// Tiny sync server: serves the PWA from ../public and stores checklists in SQLite.
// Node runs this file directly (type stripping); no build step and no dependencies.
import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import type { Records } from '../src/types.ts';
import { parseRecords } from '../src/validate.ts';

const HERE = import.meta.dirname;
const PUBLIC = resolve(HERE, '..', 'public');
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
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
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
  db.exec('BEGIN');
  try {
    for (const c of records.checklists) upsertChecklist.run({ ...c });
    for (const i of records.items) upsertItem.run({ ...i, deleted: i.deleted ? 1 : 0 });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { ok: true };
}

function pull(db: DatabaseSync, body: Json): Json {
  const ids = body['ids'];
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((i) => typeof i === 'string')) {
    throw new BadRequest(`ids must be a list of at most ${MAX_IDS} strings`);
  }
  if (ids.length === 0) return { checklists: [], items: [] };
  const marks = ids.map(() => '?').join(',');
  const checklists = db.prepare(`SELECT * FROM checklists WHERE id IN (${marks})`).all(...ids);
  const items = db
    .prepare(`SELECT * FROM items WHERE checklist_id IN (${marks})`)
    .all(...ids)
    .map((r) => ({ ...r, deleted: r['deleted'] === 1 }));
  return { checklists, items };
}

const ROUTES: Record<string, (db: DatabaseSync, body: Json) => Json> = { '/api/push': push, '/api/pull': pull };

async function readJson(req: IncomingMessage): Promise<Json> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY) throw new BadRequest('body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BadRequest('body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8') || '{}';
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequest('body must be a JSON object');
  return body as Json;
}

function sendJson(res: ServerResponse, status: number, data: Json): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

/** File info, or null if there's nothing there. Other errors (permissions, I/O) propagate. */
async function statOrNull(file: string): Promise<Stats | null> {
  try {
    return await stat(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, publicDir: string): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
  let file = resolve(join(publicDir, pathname));
  if (file !== publicDir && !file.startsWith(publicDir + sep)) {
    res.writeHead(404).end();
    return;
  }
  let info = await statOrNull(file);
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = await statOrNull(file);
  }
  if (!info?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}

async function handle(req: IncomingMessage, res: ServerResponse, db: DatabaseSync, publicDir: string): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (req.method === 'POST') {
    const route = ROUTES[path];
    if (!route) return sendJson(res, 404, { error: 'not found' });
    return sendJson(res, 200, route(db, await readJson(req)));
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, publicDir);
  res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end();
}

export function makeServer(db: DatabaseSync, publicDir: string = PUBLIC): Server {
  return createServer((req, res) => {
    handle(req, res, db, publicDir).catch((e: unknown) => {
      if (e instanceof BadRequest) return sendJson(res, 400, { error: e.message });
      console.error(`${req.method} ${req.url} failed:`, e);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: 'internal error' });
    });
  });
}

function main(): void {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8000' },
      db: { type: 'string', default: join(HERE, 'data.sqlite') },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port)) throw new Error(`--port must be a number, got ${values.port}`);
  makeServer(openDb(values.db)).listen(port, values.host, () => {
    console.log(`Serving http://${values.host}:${port} (db: ${values.db})`);
  });
}

if (import.meta.main) main();
