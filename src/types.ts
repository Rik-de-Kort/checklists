/** UTC milliseconds since the Unix epoch. Converted to local time only for display (see time.ts). */
export type EpochMs = number & { readonly __brand: "EpochMs" };

export type Status = "checked" | "unchecked";

export interface Checklist {
  readonly id: string;
  readonly name: string;
  readonly created_at: EpochMs;
  readonly updated_at: EpochMs;
}

export interface Item {
  readonly id: string;
  readonly checklist_id: string;
  readonly label: string;
  readonly status: Status;
  readonly created_at: EpochMs;
  readonly updated_at: EpochMs;
  /** Tombstone: deleted items are kept so the deletion can sync. */
  readonly deleted: boolean;
}

export interface Db {
  checklists: Record<string, Checklist>;
  items: Record<string, Item>;
  /** Every change stamped before this was included in a successful sync. */
  syncedThrough: EpochMs;
}

/** Export/import and wire format. */
export interface Records {
  checklists: Checklist[];
  items: Item[];
}

/** Records as they were before (or after) an action; null means the record didn't exist. */
export interface Snapshot {
  checklists: Record<string, Checklist | null>;
  items: Record<string, Item | null>;
}
