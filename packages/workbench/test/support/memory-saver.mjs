// The memory saver of the page (docs/spec/plugins.md#memory-saver), built as index.html builds it, for the tests that install the
// core entries with installCoreExposure. The page modules are imported when a test calls pageMemorySaver, so the test sets up its
// document and selects its page-wire case before them. A test has no error display of the page, so a failed unload or restore
// throws its text.

/** Creates the memory saver of the page over the settings, the tab reports, the stores and the document regions of the page. */
export async function pageMemorySaver() {
  const { createMemorySaver, unloadDeclaration } = await import("../../memory-saver.js");
  const { value } = await import("../../settings.js");
  const projects = await import("../../projects.js");
  const { documentRegions } = await import("../../document-regions.js");
  const { restoreSection } = await import("../../sidebar-sections.js");
  const { publish } = await import("../../compositor.js");
  const { reportTabState, reportTitle, tabKeeps } = await import("../../tab-reports.js");
  const { coreChanged } = await import("../../core-exposure.js");
  return createMemorySaver({
    enabled: () => value("memorySaver"),
    delay: () => value("memorySaverDelay"),
    declaration: unloadDeclaration,
    keeps: tabKeeps,
    kept: (tab) => projects.tabStateStore()?.entry(tab)?.kept === true,
    setKept: (tab, on) => projects.tabStateStore().setKept(tab, on),
    regions: (tab) => documentRegions.reasons(tab),
    interaction: (tab) => projects.tabSessionStore().capture(tab, "unload"),
    restore: (tab) => {
      restoreSection(tab);
      return documentRegions.restore(tab);
    },
    commit: () => Promise.resolve(publish()),
    showLabel: (tab) => {
      // default: a tab without a tab state store or without a stored label has no label to show (null).
      const label = projects.tabStateStore()?.label(tab) ?? null;
      if (label !== null) reportTitle(tab, label);
    },
    changed: () => coreChanged(),
    failed: (text) => {
      throw new Error(`memory saver: ${text}`);
    },
    stateChanged: reportTabState,
  });
}
