// The plugin document that the layout probe loads into its document region (docs/spec/native-surfaces.md#document-regions). It
// reports its color scheme, its visibility, the site data value of its key and its content color to the view by posting to its own
// window, which the host forwards to the view as document-message, and it applies the color and the value that the view posts.
// Both sides receive every message of the window, so a message of the document carries from and a message of the view carries to.

const FROM_DOCUMENT = "layoutprobe.document";
const TO_DOCUMENT = "layoutprobe.document";

/** The local storage key of the site data of the document: one key per tab, named by the key of the document address. */
export function storageKey(location) {
  // default: a document address without a key keeps its value under the empty key.
  return `layoutprobe.site.${new URL(location.href).searchParams.get("key") ?? ""}`;
}

/** Starts the document in its window and reports it once at once and again at each change. */
export function startDocumentProbe(window) {
  const { document, localStorage, location } = window;
  const key = storageKey(location);
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const report = () => window.postMessage({
    from: FROM_DOCUMENT,
    scheme: dark.matches ? "dark" : "light",
    visibility: document.visibilityState,
    stored: localStorage.getItem(key),
    color: window.getComputedStyle(document.body).backgroundColor,
  }, location.origin);
  dark.addEventListener("change", report);
  document.addEventListener("visibilitychange", report);
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.to !== TO_DOCUMENT) return;
    if (typeof message.color === "string") document.body.style.background = message.color;
    if (typeof message.store === "string") localStorage.setItem(key, message.store);
    report();
  });
  report();
}
