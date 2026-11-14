// The plugin document that the layout probe loads into its document region (docs/spec/native-surfaces.md#document-regions). It
// reports its color scheme, its visibility, the number of its visibilitychange events since it loaded, the site data value of its
// key and its content color to the view by posting to its own window, which the host forwards to the view as document-message, and
// it applies the color and the value that the view posts.
// Both sides receive every message of the window, so a message of the document carries from and a message of the view carries to.

const FROM_DOCUMENT = "layoutprobe.document";
const TO_DOCUMENT = "layoutprobe.document";

/** The local storage key of the site data of the document: one key per tab, named by the key of the document address. */
export function storageKey(location) {
  // default: a document address without a key keeps its value under the empty key.
  return `layoutprobe.site.${new URL(location.href).searchParams.get("key") ?? ""}`;
}

/**
 * Opens the document in its window with the color scheme `dark` (true for the dark scheme) and reports it once at once and again at
 * each change. Returns setDark(dark), which sets the color scheme and reports. The scheme is data of the caller, so the reaction of
 * the document to it does not depend on the media query of the platform.
 */
export function openDocumentProbe(window, dark) {
  const { document, localStorage, location } = window;
  const key = storageKey(location);
  let changes = 0;
  const report = () => window.postMessage({
    from: FROM_DOCUMENT,
    scheme: dark ? "dark" : "light",
    visibility: document.visibilityState,
    changes,
    stored: localStorage.getItem(key),
    color: window.getComputedStyle(document.body).backgroundColor,
  }, location.origin);
  document.addEventListener("visibilitychange", () => {
    changes += 1;
    report();
  });
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.to !== TO_DOCUMENT) return;
    if (typeof message.color === "string") document.body.style.background = message.color;
    if (typeof message.store === "string") localStorage.setItem(key, message.store);
    report();
  });
  report();
  return {
    setDark(next) {
      dark = next;
      report();
    },
  };
}

/** Starts the document in its window with the color scheme of the platform: it follows the media query `prefers-color-scheme: dark`. */
export function startDocumentProbe(window) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const probe = openDocumentProbe(window, query.matches);
  query.addEventListener("change", () => probe.setDark(query.matches));
}
