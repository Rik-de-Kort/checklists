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
  /** Fractional index ordering the checklist's items (see order.ts). */
  readonly position: string;
}

/**
 * An item as sent and stored by the server, where position is null for items written by app
 * versions from before positions. The app gives those their key from order.keyFromTime.
 */
export type WireItem = Omit<Item, "position"> & {
  readonly position: string | null;
};

export interface Db {
  checklists: Record<string, Checklist>;
  items: Record<string, Item>;
  /** Every change stamped before this was included in a successful sync. */
  syncedThrough: EpochMs;
}

/** Export/import and wire format. */
export interface Records {
  checklists: Checklist[];
  items: WireItem[];
}

/** Records as they were before (or after) an action; null means the record didn't exist. */
export interface Snapshot {
  checklists: Record<string, Checklist | null>;
  items: Record<string, Item | null>;
}
