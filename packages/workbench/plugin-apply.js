// A window applies a plugin change by reloading its page, after the questions of its modified tabs
// (docs/spec/installation.md#applying-a-change).

/**
 * Returns apply(), which runs settle() to ask for each modified tab of the window and, when no tab was kept, saves the
 * projects with flush() and starts the page reload with reload(), which waits for the replies that the page still sends.
 * It answers {reloaded} as core.plugins.apply does, before the reload ends the page.
 */
export function createPluginApply({ settle, flush, reload }) {
  return async function apply() {
    if (!(await settle())) return { reloaded: false };
    await flush();
    // The reload rejects through the document's unhandledrejection, which shows the error.
    reload();
    return { reloaded: true };
  };
}
