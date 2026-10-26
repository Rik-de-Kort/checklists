// Test setup: in-memory Web Storage and fresh module state for each test.
import * as store from "../src/store.ts";
import * as actions from "../src/actions.ts";

export class MemoryStorage {
  #data = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    return this.#data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    }
    this.#data.set(key, value);
  }
  removeItem(key: string): void {
    this.#data.delete(key);
  }
}

export function freshStorage(): {
  local: MemoryStorage;
  session: MemoryStorage;
} {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: local,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: session,
    configurable: true,
  });
  return { local, session };
}

/** Empty storage, store and undo stack. */
export function fresh(): { local: MemoryStorage; session: MemoryStorage } {
  const storages = freshStorage();
  store.init();
  actions.init();
  return storages;
}

/** A checklist with the given items, created through actions (so it's undoable). */
export function seed(
  labels: string[],
): { checklistId: string; itemIds: string[] } {
  const checklistId = store.uuid();
  actions.dispatch({
    type: "createChecklist",
    id: checklistId,
    name: "Groceries",
  });
  const itemIds = labels.map((label) => {
    const id = store.uuid();
    actions.dispatch({ type: "addItem", id, checklistId, label });
    return id;
  });
  return { checklistId, itemIds };
}

export function item(id: string) {
  const i = store.getItem(id);
  if (!i) throw new Error(`test: item ${id} missing`);
  return i;
}
