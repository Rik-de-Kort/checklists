// Entry point. The error banner goes first so that failures while starting up are visible too.
import { installErrorBanner } from "./errors.ts";

installErrorBanner();

// Imported dynamically so that a module failing to load (e.g. no Temporal API) still reaches the banner.
const [store, actions, ui] = await Promise.all([
  import("./store.ts"),
  import("./actions.ts"),
  import("./ui.ts"),
]);
store.init();
actions.init();
ui.init();

if ("serviceWorker" in navigator) {
  await navigator.serviceWorker.register("sw.js");
}
