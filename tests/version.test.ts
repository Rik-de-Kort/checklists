import assert from "node:assert/strict";
import { HISTORY, VERSION } from "../src/version.ts";

const ROOT = new URL("../", import.meta.url);
// Everything that ships, except src/version.ts (it holds the hashes), the bundles built from src/,
// and the dev server's database. Keep in step with .gitignore.
const DIRS = ["src", "server", "public"];
const SKIP = new Set(["src/version.ts", "public/js", "public/sw.js"]);
const SKIP_FILE = /\.sqlite(-\w+)?$/;

async function files(dir: string): Promise<string[]> {
  if (SKIP.has(dir)) return [];
  const out: string[] = [];
  for await (const e of Deno.readDir(new URL(dir, ROOT))) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...await files(path));
    else if (!SKIP.has(path) && !SKIP_FILE.test(path)) out.push(path);
  }
  return out;
}

async function fingerprint(): Promise<string> {
  const paths = (await Promise.all(DIRS.map(files))).flat().sort();
  const parts = await Promise.all(paths.map(async (p) => {
    const bytes = await Deno.readFile(new URL(p, ROOT));
    return [new TextEncoder().encode(`${p}\0${bytes.length}\0`), bytes];
  }));
  const all = new Uint8Array(await new Blob(parts.flat()).arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", all);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("the newest version in the history matches the app's files", async () => {
  const hash = await fingerprint();
  assert.equal(
    hash,
    HISTORY.at(-1)?.hash,
    `The app's files changed since version ${VERSION}. Add a new entry to HISTORY in src/version.ts with version ${
      VERSION + 1
    } and hash "${hash}".`,
  );
});

Deno.test("versions count up from 1", () => {
  assert.deepEqual(
    HISTORY.map((e) => e.version),
    HISTORY.map((_, i) => i + 1),
  );
});
