// View layer: hash router, the overview and checklist pages, and UI event handling.
// Every store change triggers a full re-render of the current page; data is small.
import * as store from "./store.ts";
import { canUndo, describe, dispatch, undo } from "./actions.ts";
import { latestVersion, pull, refreshAppFiles, sync } from "./sync.ts";
import { message } from "./errors.ts";
import { localDate, relTime, toInstant } from "./time.ts";
import { CHECKLIST_ID, parseRecords } from "./validate.ts";
import type { ChecklistSummary } from "./store.ts";
import type { Checklist, Item } from "./types.ts";
import { VERSION } from "./version.ts";
import { wordId } from "./words.ts";

const SWIPE_THRESHOLD = 80;
const LONG_PRESS_MS = 500;
const TOAST_MS = 4000;
const SYNC_INTERVAL_MS = 3000;
const AUTOSCROLL_EDGE = 48; // px from the list's top or bottom where a drag scrolls it
const AUTOSCROLL_SPEED = 8; // px per frame

const ICONS = {
  back: '<polyline points="15 18 9 12 15 6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  sync:
    '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  more:
    '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  plus:
    '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  send:
    '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  trash:
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit:
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  grip:
    '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
} as const;
type IconName = keyof typeof ICONS;

type Route = { name: "overview" } | { name: "checklist"; id: string };
type SyncStatus = "idle" | "busy" | "error";
type Lookup = "loading" | "missing" | "unreachable";

function byId<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) {
    throw new Error(`#${id} is missing from index.html`);
  }
  return el;
}

const app = byId("app", HTMLDivElement);
const toastEl = byId("toast", HTMLDivElement);
const importInput = byId("import-file", HTMLInputElement);

let route = parseRoute();
let renderedRoute: string | null = null;
let rendering = false;
let renderQueued = false;
let editingId: string | null = null;
let pendingFocus: string | null = null; // data-key of an input to focus and select after the next render
let scrollToBottom = false;
let syncStatus: SyncStatus = "idle";
let syncing = false;
const remoteLookups = new Map<string, Lookup>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let drag: Drag | null = null; // an item being dragged; renders wait until it's dropped
let installPrompt: BeforeInstallPromptEvent | null = null;

// Only Chromium browsers have this event, so it isn't in TypeScript's DOM types.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
}

export function init(): void {
  store.subscribe(render);
  globalThis.addEventListener("hashchange", () => {
    route = parseRoute();
    editingId = null;
    if (
      route.name === "checklist" && remoteLookups.get(route.id) !== "loading"
    ) remoteLookups.delete(route.id);
    render();
  });
  globalThis.addEventListener("storage", (e) => {
    if (e.key === store.KEY) store.reload();
  });
  globalThis.addEventListener("online", () => void runSync({ quiet: true }));
  document.addEventListener("keydown", (e) => {
    const inField = e.target instanceof Element &&
      e.target.closest("input, textarea");
    if (
      (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z" &&
      !inField
    ) {
      e.preventDefault();
      doUndo();
    }
  });
  document.addEventListener("click", (e) => {
    for (const d of document.querySelectorAll("details.menu[open]")) {
      if (!(e.target instanceof Node && d.contains(e.target))) {
        d.removeAttribute("open");
      }
    }
  });
  importInput.addEventListener("change", () => void importJson());
  globalThis.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we offer it from the menu instead of the browser's own banner
    installPrompt = e as BeforeInstallPromptEvent;
  });
  render();
  void runSync({ quiet: true });
  // Push our changes and pull everyone else's; runSync skips a tick while one is still in flight.
  setInterval(() => {
    if (!document.hidden) void runSync({ quiet: true });
  }, SYNC_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void runSync({ quiet: true });
  });
}

function parseRoute(): Route {
  // Lowercase: phones like to capitalize the first letter of a hand-typed link.
  const id = /^#\/c\/(.+)$/.exec(location.hash)?.[1]?.toLowerCase();
  return id && CHECKLIST_ID.test(id)
    ? { name: "checklist", id }
    : { name: "overview" };
}

// ---------- rendering ----------

const APP_NAME = "Seznam";

function render(): void {
  if (rendering || drag) {
    renderQueued = true;
    return;
  }
  rendering = true;
  try {
    // The checklist we're looking at vanished (deleted, or its creation undone): go back.
    if (
      route.name === "checklist" && location.hash === renderedRoute &&
      !store.getChecklist(route.id) && !remoteLookups.has(route.id)
    ) {
      history.replaceState(null, "", "#/");
      route = parseRoute();
    }
    const sameRoute = location.hash === renderedRoute;
    const focus = sameRoute ? saveFocus() : null;
    const oldScroll = sameRoute
      ? app.querySelector("main")?.scrollTop
      : undefined;

    app.replaceChildren(
      ...(route.name === "checklist"
        ? checklistView(route.id)
        : overviewView()),
    );
    renderedRoute = location.hash;
    const shown = route.name === "checklist"
      ? store.getChecklist(route.id)
      : undefined;
    document.title = shown ? `${shown.name} - ${APP_NAME}` : APP_NAME;

    const main = app.querySelector("main");
    if (!main) throw new Error("Rendered page has no <main>");
    if (scrollToBottom || (!sameRoute && route.name === "checklist")) {
      main.scrollTop = main.scrollHeight;
    } else if (oldScroll !== undefined) main.scrollTop = oldScroll;
    scrollToBottom = false;

    const toFocus = pendingFocus
      ? app.querySelector(`input[data-key="${pendingFocus}"]`)
      : null;
    if (toFocus instanceof HTMLInputElement) {
      toFocus.focus();
      toFocus.select();
      pendingFocus = null;
    } else if (focus) {
      restoreFocus(focus);
    }
  } finally {
    rendering = false;
  }
  if (renderQueued) {
    renderQueued = false;
    render();
  }
}

interface SavedFocus {
  key: string;
  value: string;
  start: number | null;
  end: number | null;
}

function saveFocus(): SavedFocus | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement) || !el.dataset["key"]) return null;
  return {
    key: el.dataset["key"],
    value: el.value,
    start: el.selectionStart,
    end: el.selectionEnd,
  };
}

function restoreFocus(f: SavedFocus): void {
  const el = app.querySelector(`input[data-key="${f.key}"]`);
  if (!(el instanceof HTMLInputElement)) return;
  el.value = f.value;
  el.focus();
  el.setSelectionRange(f.start, f.end);
}

type Handlers = {
  [K in keyof HTMLElementEventMap]?: (e: HTMLElementEventMap[K]) => void;
};
interface Props {
  on?: Handlers;
  [attr: string]: string | boolean | null | undefined | Handlers;
}
type Child = Node | string | null | false | undefined;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "on") {
      for (const [type, fn] of Object.entries(v as Handlers)) {
        el.addEventListener(type, fn as EventListener);
      }
    } else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else if (typeof v === "string") el.setAttribute(k, v);
  }
  el.append(
    ...children.flat().filter((c): c is Node | string =>
      c != null && c !== false
    ),
  );
  return el;
}

function icon(name: IconName): Node {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${
    ICONS[name]
  }</svg>`;
  return t.content.cloneNode(true);
}

function iconButton(
  name: IconName,
  label: string,
  onclick: () => void,
  extraClass = "",
): HTMLButtonElement {
  return h("button", {
    class: `icon-btn ${extraClass}`,
    title: label,
    "aria-label": label,
    on: { click: onclick },
  }, icon(name));
}

function undoButton(): HTMLButtonElement {
  const b = iconButton("undo", "Undo", doUndo);
  b.disabled = !canUndo();
  return b;
}

function syncButton(): HTMLButtonElement {
  return iconButton(
    "sync",
    syncStatus === "error" ? "Sync (last attempt failed)" : "Sync",
    () => void runSync(),
    `sync ${syncStatus}`,
  );
}

function menu(...entries: (HTMLButtonElement | null)[]): HTMLDetailsElement {
  return h(
    "details",
    { class: "menu" },
    h(
      "summary",
      { class: "icon-btn", title: "More", "aria-label": "More" },
      icon("more"),
    ),
    h("div", { class: "menu-panel" }, entries),
  );
}

function menuItem(label: string, fn: () => void, cls = ""): HTMLButtonElement {
  const b: HTMLButtonElement = h("button", {
    class: cls,
    on: {
      click: () => {
        b.closest("details")?.removeAttribute("open");
        fn();
      },
    },
  }, label);
  return b;
}

// ---------- overview ----------

function overviewView(): Node[] {
  const lists = store.listChecklists();
  return [
    h(
      "header",
      { class: "topbar" },
      h("h1", {}, "Checklists"),
      undoButton(),
      syncButton(),
      menu(
        menuItem("Export all (JSON)", exportJson),
        menuItem("Import JSON…", () => importInput.click()),
        menuItem("Check for updates", () => void checkForUpdates()),
        isInstalled() ? null : menuItem("Install app", () => void install()),
        menuItem("About", () => toast(`${APP_NAME} version ${VERSION}`)),
      ),
    ),
    h(
      "main",
      { class: "chats" },
      lists.length
        ? lists.map(chatRow)
        : h("p", { class: "empty" }, "No checklists yet. Tap + to start one."),
    ),
    h("button", {
      class: "fab",
      title: "New checklist",
      "aria-label": "New checklist",
      on: { click: newChecklist },
    }, icon("plus")),
  ];
}

function chatRow(
  { checklist, last, total, done, activity }: ChecklistSummary,
): HTMLAnchorElement {
  return h(
    "a",
    { class: "chat-row", href: `#/c/${checklist.id}` },
    h(
      "div",
      { class: "avatar", "aria-hidden": "true" },
      (checklist.name.trim()[0] ?? "?").toUpperCase(),
    ),
    h(
      "div",
      { class: "chat-body" },
      h(
        "div",
        { class: "chat-line" },
        h("span", { class: "chat-name" }, checklist.name),
        h(
          "time",
          { datetime: toInstant(activity).toString() },
          relTime(activity),
        ),
      ),
      h(
        "div",
        { class: "chat-line" },
        h(
          "span",
          { class: "chat-preview" },
          last ? last.label : "No items yet",
        ),
        total
          ? h(
            "span",
            { class: `count${done === total ? " complete" : ""}` },
            `${done}/${total}`,
          )
          : null,
      ),
    ),
  );
}

// ---------- checklist ----------

function checklistView(id: string): Node[] {
  const c = store.getChecklist(id);
  if (!c) return missingView(id);
  const items = store.itemsFor(id);
  const title: HTMLInputElement = h("input", {
    class: "title",
    "data-key": "title",
    value: c.name,
    "aria-label": "Checklist name",
    enterkeyhint: "done",
    on: {
      keydown: (e) => {
        if (e.key === "Enter") title.blur();
        if (e.key === "Escape") {
          title.value = c.name;
          title.blur();
        }
      },
      blur: () => rename(c, title.value),
    },
  });
  const composer: HTMLInputElement = h("input", {
    "data-key": "composer",
    placeholder: "Add an item",
    autocomplete: "off",
    enterkeyhint: "send",
    "aria-label": "New item",
  });
  return [
    h(
      "header",
      { class: "topbar" },
      h("a", {
        class: "icon-btn",
        href: "#/",
        title: "Back",
        "aria-label": "Back",
      }, icon("back")),
      title,
      undoButton(),
      menu(
        menuItem("Share link", () => void share(c)),
        menuItem("Clone (all unchecked)", () => clone(c)),
        menuItem("Export as text", () => exportText(c, items)),
        menuItem("Delete from this device", () => deleteChecklist(c), "danger"),
      ),
    ),
    h(
      "main",
      { class: "items" },
      items.length
        ? items.map(itemView)
        : h("p", { class: "empty" }, "Add your first item below."),
    ),
    h(
      "form",
      { class: "composer", on: { submit: (e) => addItem(e, c, composer) } },
      composer,
      h("button", {
        type: "submit",
        class: "send",
        title: "Add",
        "aria-label": "Add",
      }, icon("send")),
    ),
  ];
}

const LOOKUP_TEXT: Record<Lookup, string> = {
  loading: "Fetching checklist…",
  missing: "This checklist isn't on this device or on the server.",
  unreachable:
    "This checklist isn't on this device, and the server couldn't be reached. Try again when you're online.",
};

function missingView(id: string): Node[] {
  const state = remoteLookups.get(id);
  if (!state) void lookupRemote(id);
  return [
    h(
      "header",
      { class: "topbar" },
      h("a", {
        class: "icon-btn",
        href: "#/",
        title: "Back",
        "aria-label": "Back",
      }, icon("back")),
      h("h1", {}, "Checklist"),
    ),
    h(
      "main",
      { class: "items" },
      h("p", { class: "empty" }, LOOKUP_TEXT[state ?? "loading"]),
    ),
  ];
}

async function lookupRemote(id: string): Promise<void> {
  remoteLookups.set(id, "loading");
  try {
    const found = await pull([id]);
    if (found) remoteLookups.delete(id);
    else remoteLookups.set(id, "missing");
  } catch (e) {
    console.error(`Fetching checklist ${id} failed:`, e);
    remoteLookups.set(id, "unreachable");
  }
  render();
}

function itemView(item: Item): HTMLElement {
  if (editingId === item.id) {
    const input: HTMLInputElement = h("input", {
      class: "bubble edit",
      "data-key": "edit",
      value: item.label,
      "aria-label": "Edit item",
      enterkeyhint: "done",
      on: {
        keydown: (e) => {
          if (e.key === "Enter") finish(true);
          if (e.key === "Escape") finish(false);
        },
        blur: () => finish(true),
      },
    });
    const finish = (save: boolean): void => {
      if (rendering || editingId !== item.id) return;
      editingId = null;
      const label = input.value.trim();
      if (save && label && label !== item.label) {
        dispatch({ type: "editItem", id: item.id, label });
      } else render();
    };
    return h("div", { class: "bubble-row" }, input);
  }

  const checked = item.status === "checked";
  const bubble = h(
    "div",
    {
      class: `bubble${checked ? " checked" : ""}`,
      role: "checkbox",
      "aria-checked": String(checked),
      tabindex: "0",
    },
    h("span", { class: "tick" }, icon("check")),
    h("span", { class: "label" }, item.label),
  );
  const handle = h("div", {
    class: "drag-handle",
    title: "Drag to move",
    "aria-hidden": "true",
  }, icon("grip"));
  const row = h(
    "div",
    { class: "bubble-row", "data-id": item.id },
    h("div", { class: "swipe-bg", "aria-hidden": "true" }, icon("trash")),
    handle,
    bubble,
    h(
      "div",
      { class: "hover-actions" },
      iconButton("edit", "Edit", () => startEdit(item.id)),
      iconButton("trash", "Delete", () => deleteItem(item.id)),
    ),
  );
  attachGestures(row, bubble, item);
  attachDrag(row, handle);
  return row;
}

interface Drag {
  row: HTMLElement;
  rows: HTMLElement[];
  /** Each row's vertical centre when the drag started, in the list's scrolled coordinates. */
  mids: number[];
  from: number;
  to: number;
  /** How far the other rows move to make room: the dragged row's height plus the gap. */
  step: number;
  startY: number;
  startScroll: number;
  y: number;
  main: HTMLElement;
  frame: number;
}

// Dragging an item's handle moves it, while the rows it passes make room. Same for touch and mouse.
function attachDrag(row: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener("pointerdown", (e) => {
    if (drag || e.button !== 0) return;
    const main = row.closest("main");
    if (!main) throw new Error("Item row is not inside <main>");
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const rows = [...main.querySelectorAll<HTMLElement>(".bubble-row")];
    const from = rows.indexOf(row);
    const mids = rows.map((r) => {
      const box = r.getBoundingClientRect();
      return box.top + box.height / 2 + main.scrollTop;
    });
    const gap = parseFloat(getComputedStyle(main).rowGap) || 0;
    drag = {
      row,
      rows,
      mids,
      from,
      to: from,
      step: row.getBoundingClientRect().height + gap,
      startY: e.clientY,
      startScroll: main.scrollTop,
      y: e.clientY,
      main,
      frame: requestAnimationFrame(autoScroll),
    };
    row.classList.add("dragging");
    document.body.classList.add("dragging-item");
  });
  handle.addEventListener("pointermove", (e) => {
    if (drag?.row !== row) return;
    drag.y = e.clientY;
    updateDrag(drag);
  });
  handle.addEventListener("pointerup", () => {
    if (drag?.row === row) drop(drag, true);
  });
  handle.addEventListener("pointercancel", () => {
    if (drag?.row === row) drop(drag, false);
  });
}

function updateDrag(d: Drag): void {
  const dy = d.y - d.startY + d.main.scrollTop - d.startScroll;
  d.row.style.transform = `translateY(${dy}px)`;
  const centre = d.mids[d.from]! + dy;
  d.to = d.mids.filter((m, i) => i !== d.from && m < centre).length;
  d.rows.forEach((r, i) => {
    const shift = i > d.from && i <= d.to
      ? -d.step
      : i < d.from && i >= d.to
      ? d.step
      : 0;
    if (i !== d.from) r.style.transform = shift ? `translateY(${shift}px)` : "";
  });
}

// While dragging near the list's top or bottom edge, scroll it.
function autoScroll(): void {
  if (!drag) return;
  const box = drag.main.getBoundingClientRect();
  const by = drag.y < box.top + AUTOSCROLL_EDGE
    ? -AUTOSCROLL_SPEED
    : drag.y > box.bottom - AUTOSCROLL_EDGE
    ? AUTOSCROLL_SPEED
    : 0;
  const before = drag.main.scrollTop;
  drag.main.scrollTop += by;
  if (drag.main.scrollTop !== before) updateDrag(drag);
  drag.frame = requestAnimationFrame(autoScroll);
}

function drop(d: Drag, commit: boolean): void {
  cancelAnimationFrame(d.frame);
  drag = null;
  document.body.classList.remove("dragging-item");
  d.row.classList.remove("dragging");
  for (const r of d.rows) r.style.transform = "";
  // A sync during the drag may have deleted items: skip those.
  const present = (id: string | undefined): id is string =>
    id !== undefined && store.getItem(id)?.deleted === false;
  const id = d.row.dataset["id"];
  if (commit && d.to !== d.from && present(id)) {
    const afterId = d.rows.filter((r) => r !== d.row).slice(0, d.to)
      .map((r) => r.dataset["id"]).findLast(present) ?? null;
    dispatch({ type: "moveItem", id, afterId });
  } else if (renderQueued) {
    renderQueued = false;
    render();
  }
}

// Tap toggles. On touch: swipe left deletes, long-press edits. (Mouse gets hover buttons.)
function attachGestures(
  row: HTMLElement,
  bubble: HTMLElement,
  item: Item,
): void {
  let start: { x: number; y: number } | null = null;
  let dx = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;

  const reset = (): void => {
    clearTimeout(timer);
    start = null;
    bubble.style.transform = "";
    row.classList.remove("swiping", "armed", "rightward");
  };

  bubble.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    start = { x: e.clientX, y: e.clientY };
    dx = 0;
    suppressClick = false;
    timer = setTimeout(() => {
      reset();
      suppressClick = true;
      startEdit(item.id);
    }, LONG_PRESS_MS);
  });
  bubble.addEventListener("pointermove", (e) => {
    if (!start) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimeout(timer);
    if (dx === 0 && Math.abs(my) > 8 && Math.abs(my) > Math.abs(mx)) {
      reset(); // vertical scroll; let the browser have it
      return;
    }
    dx = mx; // either direction deletes
    if (Math.abs(dx) > 8) {
      suppressClick = true;
      bubble.setPointerCapture(e.pointerId);
      row.classList.add("swiping");
    }
    row.classList.toggle("rightward", dx > 0);
    row.classList.toggle("armed", Math.abs(dx) > SWIPE_THRESHOLD);
    bubble.style.transform = `translateX(${dx}px)`;
  });
  bubble.addEventListener("pointerup", () => {
    if (start && Math.abs(dx) > SWIPE_THRESHOLD) deleteItem(item.id);
    else reset();
  });
  bubble.addEventListener("pointercancel", reset);
  bubble.addEventListener("contextmenu", (e) => e.preventDefault());
  bubble.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    dispatch({ type: "toggleItem", id: item.id });
  });
  bubble.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      dispatch({ type: "toggleItem", id: item.id });
    }
  });
}

// ---------- actions ----------

function newChecklist(): void {
  const id = wordId();
  dispatch({ type: "createChecklist", id, name: "New checklist" });
  pendingFocus = "title";
  location.hash = `#/c/${id}`;
}

function rename(c: Checklist, value: string): void {
  if (rendering) return;
  const name = value.trim();
  if (name && name !== c.name) {
    dispatch({ type: "renameChecklist", id: c.id, name });
  } else render(); // restore the old name if the field was emptied
}

function addItem(e: SubmitEvent, c: Checklist, input: HTMLInputElement): void {
  e.preventDefault();
  const label = input.value.trim();
  if (!label) return;
  input.value = "";
  scrollToBottom = true;
  dispatch({ type: "addItem", id: store.uuid(), checklistId: c.id, label });
}

function startEdit(id: string): void {
  editingId = id;
  pendingFocus = "edit";
  render();
}

function deleteItem(id: string): void {
  dispatch({ type: "deleteItem", id });
  toast("Item deleted", true);
}

function deleteChecklist(c: Checklist): void {
  dispatch({ type: "deleteChecklist", id: c.id });
  toast(`Deleted “${c.name}”`, true);
}

function clone(c: Checklist): void {
  const id = wordId();
  dispatch({ type: "cloneChecklist", sourceId: c.id, id });
  location.hash = `#/c/${id}`;
  toast("Cloned with all items unchecked", true);
}

function doUndo(): void {
  const result = undo();
  if (!result) {
    toast("Nothing to undo");
    return;
  }
  const what = describe(result.action).toLowerCase();
  toast(
    result.local ? `Undone: ${what}` : `Undone: ${what} (synced on next sync)`,
  );
}

async function share(c: Checklist): Promise<void> {
  // The server redirects /<id> to /#/c/<id>; it's much easier to type on a phone.
  const url = new URL(c.id, location.href).href;
  void runSync({ quiet: true }); // make sure the server has it before someone opens the link
  if ("share" in navigator) {
    try {
      await navigator.share({ title: c.name, url });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // the user closed the share sheet
      console.error(
        "navigator.share failed, falling back to the clipboard:",
        e,
      );
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch (e) {
    console.error("Copying the link failed, showing it instead:", e);
    globalThis.prompt("Copy this link", url);
  }
}

async function runSync({ quiet = false } = {}): Promise<void> {
  if (syncing) return;
  syncing = true;
  // Background syncs don't spin the button: re-rendering every few seconds disrupts typing.
  if (!quiet) setSyncStatus("busy");
  try {
    await sync();
    setSyncStatus("idle");
    if (!quiet) toast("Synced");
  } catch (e) {
    console.error("Sync failed:", e);
    setSyncStatus("error");
    if (!quiet) toast(`Sync failed: ${message(e)}`);
  } finally {
    syncing = false;
  }
}

// App files are served from the cache (see sw.ts), so that has to be refreshed before reloading.
async function checkForUpdates(): Promise<void> {
  try {
    const latest = await latestVersion();
    if (latest <= VERSION) {
      toast(`${APP_NAME} version ${VERSION} is up to date`);
      return;
    }
    toast(`Updating to version ${latest}…`);
    await refreshAppFiles();
  } catch (e) {
    console.error("Checking for updates failed:", e);
    toast(`Couldn't check for updates: ${message(e)}`);
    return;
  }
  location.reload();
}

// ---------- install ----------

function isInstalled(): boolean {
  // navigator.standalone is how Safari on iOS says the same thing.
  return globalThis.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && navigator.standalone === true);
}

async function install(): Promise<void> {
  if (!installPrompt) {
    showInstallHelp();
    return;
  }
  const prompt = installPrompt;
  installPrompt = null; // each event can only prompt once
  try {
    await prompt.prompt();
  } catch (e) {
    console.error("The install prompt failed:", e);
    showInstallHelp();
  }
}

// Safari and Firefox don't let a page offer installing, so the user has to do it from the browser.
function showInstallHelp(): void {
  const dialog: HTMLDialogElement = h(
    "dialog",
    { class: "install-help", on: { close: () => dialog.remove() } },
    h("h2", {}, `Install ${APP_NAME}`),
    h(
      "ul",
      {},
      h(
        "li",
        {},
        "Safari on iPhone or iPad: tap Share, then Add to Home Screen.",
      ),
      h(
        "li",
        {},
        "Other browsers: open the browser's menu and look for Install or Add to Home screen.",
      ),
    ),
    h("button", { on: { click: () => dialog.close() } }, "Close"),
  );
  document.body.append(dialog);
  dialog.showModal();
}

function setSyncStatus(s: SyncStatus): void {
  if (s === syncStatus) return;
  syncStatus = s;
  render();
}

// ---------- export / import ----------

function download(filename: string, text: string, type: string): void {
  const a = h("a", {
    href: URL.createObjectURL(new Blob([text], { type })),
    download: filename,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportJson(): void {
  download(
    `checklists-${localDate()}.json`,
    JSON.stringify(store.exportData(), null, 2),
    "application/json",
  );
}

function exportText(c: Checklist, items: Item[]): void {
  const lines = items.map((i) =>
    `- [${i.status === "checked" ? "x" : " "}] ${i.label}`
  );
  const safeName = c.name.replace(/[^\w -]+/g, "").trim() || "checklist";
  download(
    `${safeName}.md`,
    `# ${c.name}\n\n${lines.join("\n")}\n`,
    "text/markdown",
  );
}

async function importJson(): Promise<void> {
  const file = importInput.files?.[0];
  importInput.value = "";
  if (!file) return;
  let records;
  try {
    records = parseRecords(JSON.parse(await file.text()));
  } catch (e) {
    console.error(`Importing ${file.name} failed:`, e);
    toast(`Import failed: ${message(e)}`);
    return;
  }
  store.merge(records);
  store.save();
  toast("Imported");
}

// ---------- toast ----------

function toast(text: string, withUndo = false): void {
  toastEl.replaceChildren(
    h("span", {}, text),
    withUndo ? h("button", { on: { click: doUndo } }, "Undo") : "",
  );
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), TOAST_MS);
}
