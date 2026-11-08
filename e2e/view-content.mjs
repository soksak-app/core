// The content case of the plain view probe (e2e/fixtures/plain-view/probe), the core fixture view whose document region shows a known
// text; the content read and its proof are @soksak/window-check/view-content.mjs.
import { viewContentProof } from "@soksak/window-check/view-content.mjs";

/** The content read of the plain view probe: the text that its document region "page" shows (e2e/fixtures/plain-view/probe). */
export const PLAIN_CONTENT_READ = Object.freeze({ command: "probeplain.content.read", document: "page" });

/** The text that the document region of the plain view probe shows (e2e/fixtures/plain-view/probe/ui/document.html). */
export const PLAIN_CONTENT = "Plain view probe content";

/**
 * The content cases of the views, by plugin id: { params, ready(s, {tab}) }, where ready waits until the view registers its content
 * read and returns its content check, which reads the content after the display and checks that it holds the expected text. The one
 * case is the plain view probe, the view whose document region shows a known text.
 */
export async function viewContentCases(s, diagnostic) {
  return new Map([
    ["probeplain", { ready: async (_, { tab }) => {
      await s.until("core.surfaces", (all) => all.some((item) => item.surface === tab
        && item.exposes.includes(`command ${PLAIN_CONTENT_READ.command}`)), `${tab} did not register ${PLAIN_CONTENT_READ.command}`);
      return async () => {
        await viewContentProof(s, tab, PLAIN_CONTENT, PLAIN_CONTENT_READ);
        diagnostic(`probeplain ${tab} shows ${JSON.stringify(PLAIN_CONTENT)}`);
      };
    } }],
  ]);
}
