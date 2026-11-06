// Two-way sync with the server: push everything local, then pull back the checklists we hold.
import * as store from "./store.ts";
import { now } from "./time.ts";
import { parseRecords } from "./validate.ts";
import type { Records } from "./types.ts";

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(new URL(path, location.href), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `${path}: ${res.status} ${res.statusText} ${await res.text()}`.trim(),
    );
  }
  return res.json();
}

export async function sync(): Promise<void> {
  // Changes stamped before this are in the snapshot we push; later ones (made while the
  // request is in flight) are not, and must still count as unsynced for undo.
  const snapshotAt = now();
  const local = store.exportData();
  const unsynced = [...local.checklists, ...local.items].some((r) =>
    r.updated_at > store.syncedThrough()
  );
  await post("api/push", local);
  const remote = parseRecords(
    await post("api/pull", { ids: local.checklists.map((c) => c.id) }),
  );
  // Don't resurrect checklists deleted locally while the request was in flight.
  const kept: Records = {
    checklists: remote.checklists.filter((c) => store.getChecklist(c.id)),
    items: remote.items,
  };
  const changed = store.merge(kept);
  store.setSyncedThrough(snapshotAt);
  // This runs every few seconds: only re-render when something arrived, or the page would be
  // rebuilt under the user's fingers (resetting the keyboard mid-word). Only write when needed,
  // since every write makes other open tabs reload.
  if (changed) store.save();
  else if (unsynced) store.persist();
}

// The app version the server has: what a reload would load.
export async function latestVersion(): Promise<number> {
  const res = await fetch(new URL("api/version", location.href), {
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`api/version: ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json();
  const version = typeof body === "object" && body !== null &&
    "version" in body && body.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error(`api/version: invalid response ${JSON.stringify(body)}`);
  }
  return version as number;
}

// Puts the latest app files in the service worker's cache, which is what a reload loads.
export function refreshAppFiles(): Promise<void> {
  const worker = "serviceWorker" in navigator
    ? navigator.serviceWorker.controller
    : null;
  if (!worker) return Promise.resolve(); // nothing cached: a reload goes to the network
  return new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (e: MessageEvent<string | null>) => {
      if (e.data === null) resolve();
      else reject(new Error(e.data));
    };
    worker.postMessage("refresh", [port2]);
  });
}

// Fetch checklists this device doesn't have yet (e.g. from a shared link).
// Resolves to true if at least one was found on the server.
export async function pull(ids: string[]): Promise<boolean> {
  const remote = parseRecords(await post("api/pull", { ids }));
  if (store.merge(remote)) store.save();
  return remote.checklists.length > 0;
}
