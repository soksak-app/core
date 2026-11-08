// The plain view probe and the plugin document of its document region (docs/spec/native-surfaces.md#document-regions). The document
// shows one line of text (#content) and reports that text to the view by posting to its own window, which the host forwards to the view
// as document-message. The view answers probeplain.content.read with the text that its document reported, so a check reads the text
// that the region shows.

/** The address of the region document. */
export const DOCUMENT_ADDRESS = "soksak://probeplain/ui/document.html";
const FROM_DOCUMENT = "probeplain.document";

/** Starts the region document in its window: it reports the text of #content once. */
export function startPlainDocument(window) {
  const text = window.document.getElementById("content").textContent;
  window.postMessage({ from: FROM_DOCUMENT, text }, window.location.origin);
}

/**
 * Registers probeplain.content.read on `bridge` and loads the region document into the region `page` of the composition: the read
 * answers the text that the document reported, and a read before the report waits for it.
 */
export async function startPlainContent({ bridge, page }) {
  let report;
  const reported = new Promise((resolve) => {
    report = resolve;
  });
  page.onMessage((message) => {
    if (message?.from !== FROM_DOCUMENT) return;
    if (typeof message.text !== "string") throw new TypeError("the plain view probe document reported no text");
    report(message.text);
  });
  await bridge.commands.register("probeplain.content.read", () => reported);
  await page.load(DOCUMENT_ADDRESS);
}
