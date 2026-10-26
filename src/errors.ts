// Uncaught errors are already logged by the browser; this also makes them visible on devices
// without a console (phones), as a banner that stays until the page is reloaded.

let banner: HTMLElement | null = null;
let count = 0;

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function showError(err: unknown): void {
  count++;
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "error-banner";
    banner.setAttribute("role", "alert");
    document.body.prepend(banner);
  }
  const text = document.createElement("span");
  text.textContent = `Something went wrong: ${message(err)}${
    count > 1 ? ` (+${count - 1} more, see console)` : ""
  }`;
  const reload = document.createElement("button");
  reload.textContent = "Reload";
  reload.addEventListener("click", () => location.reload());
  banner.replaceChildren(text, reload);
}

export function installErrorBanner(): void {
  globalThis.addEventListener("error", (e) => showError(e.error ?? e.message));
  globalThis.addEventListener("unhandledrejection", (e) => showError(e.reason));
}
