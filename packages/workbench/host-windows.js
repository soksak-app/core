// The window interface that asks the native host for window and project folder operations.
//
// The runtime module of a native application exports this interface as `windows`. The browser
// runtime implements the same interface with browser APIs.

export function hostWindows(host) {
  return {
    /** Provides the new folder creation and folder selection dialogs. */
    createsFolders: true,
    newWindow: (cids) => host.call("windowNew", undefined, { cids }),
    onActivate: (fn) => host.on("project-activate", fn),
    onCloseRequest: (fn) => host.on("project-close-request", fn),
    /** The main page calls it before it registers or raises a surface. It returns after the host cleaned up the state of the previous page. */
    ready: () => host.call("windowReady"),
    close: (cids) => host.call("windowClose", undefined, { cids }),
    /** Receives a window close request and reports that the window was not closed because it keeps a modified tab. The host finishes the termination that the request started. */
    closeKept: (cids) => host.call("windowCloseKept", undefined, { cids }),
    /** The current size and position of the window. */
    state: () => host.call("windowState"),
    folder: (root) => host.call("projectFolder", root),
    chooseFolder: () => host.call("folderChoose"),
    createFolder: (request) => host.call("projectCreate", request),
    /**
     * Opens a project. The host decides from the window ownership whether to open it in this window,
     * and returns whether it must be opened in this window as `{ local }`.
     */
    openProject: ({ id, root, title, separate, geometry }, cids) =>
      host.call("projectOpen", { id, root, title, separate, geometry }, { cids }),
    releaseProject: (id, cids) => host.call("projectRelease", id, { cids }),
    /** Asks another window that shows the project whether the project may be removed, and fulfills with true if it may be removed. */
    askRemoveProject: (id, cids) => host.call("projectRemoveAsk", id, { cids }),
    onRemoveProjectRequest: (fn) => host.on("project-remove-request", fn),
    answerRemoveProject: (id, allowed) => host.call("projectRemoveAnswer", { id, allowed }),
  };
}
