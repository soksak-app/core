// The window interface that asks the native host for window and project folder operations.
//
// The runtime module of a native application exports this interface as `windows`. The browser
// runtime implements the same interface with browser APIs.

export function hostWindows(host) {
  return {
    /** Provides the new folder creation and folder selection dialogs. */
    createsFolders: true,
    newWindow: () => host.call("windowNew"),
    onActivate: (fn) => host.on("project-activate", fn),
    onCloseRequest: (fn) => host.on("project-close-request", fn),
    /** The main page calls it before it registers or raises a surface. It returns after the host cleaned up the state of the previous page. */
    ready: () => host.call("windowReady"),
    close: () => host.call("windowClose"),
    /** Receives a window close request and reports that the window was not closed because it keeps a modified tab. The host finishes the termination that the request started. */
    closeKept: () => host.call("windowCloseKept"),
    /** The current size and position of the window. */
    state: () => host.call("windowState"),
    folder: (root) => host.call("projectFolder", root),
    chooseFolder: () => host.call("folderChoose"),
    createFolder: (request) => host.call("projectCreate", request),
    /**
     * Opens a project. The host decides from the window ownership whether to open it in this window,
     * and returns whether it must be opened in this window as `{ local }`.
     */
    openProject: ({ id, root, title, separate, geometry }) =>
      host.call("projectOpen", { id, root, title, separate, geometry }),
    releaseProject: (id) => host.call("projectRelease", id),
    /** Asks another window that shows the project whether the project may be removed, and fulfills with true if it may be removed. */
    askRemoveProject: (id) => host.call("projectRemoveAsk", id),
    onRemoveProjectRequest: (fn) => host.on("project-remove-request", fn),
    answerRemoveProject: (id, allowed) => host.call("projectRemoveAnswer", { id, allowed }),
  };
}
