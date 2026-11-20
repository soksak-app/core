// Window interface of the browser runtime. A window is a browser tab.
//
// A folder cannot be verified, so the entered path is used as it is, and the identifier is derived from the path.
import { createProjectActivities } from "@soksak/workbench/activity.js";

// The tab is the only window, so it holds each project that it opened, and the record of the project activities is the record of this
// tab (docs/spec/activity.md#activity-of-a-project).
const PAGE = "page";
const activities = createProjectActivities();
const activityListeners = new Set();
const sendActivities = () => {
  const record = activities.record();
  for (const listener of activityListeners) listener(record);
};

export const windows = {
  createsFolders: false,
  newWindow() {
    const target = new URL(location.href);
    target.search = "";
    if (!window.open(target, "_blank")) throw new Error("The browser blocked the new window");
  },
  onActivate: async () => {},
  onCloseRequest: async () => {},
  ready: async () => sendActivities(),
  close: async () => {},
  closeKept: async () => {},
  askRemoveProject: async () => true,
  onRemoveProjectRequest: async () => {},
  answerRemoveProject: async () => {},
  state: async () => null,
  folder: async (root) => ({ root: root.trim(), identity: `path:${root.trim()}` }),
  chooseFolder: () => Promise.reject(new Error("The browser runtime cannot choose folders")),
  createFolder: () => Promise.reject(new Error("The browser runtime cannot create folders")),
  /**
   * A request for a separate window from a tab that has another project open opens a new tab and returns `local: false`.
   */
  async openProject({ id, separate, current }) {
    if (!separate || current === null || current === id) return { local: true, staged: false };
    const target = new URL(location.href);
    target.search = "";
    target.searchParams.set("project", id);
    if (!window.open(target, `soksak-${id}`)) throw new Error("The browser blocked the project window");
    return { local: false, staged: false };
  },
  projectShown: async () => {},
  async releaseProject(id) {
    const { revision } = activities.record();
    activities.release(id);
    if (activities.record().revision !== revision) sendActivities();
  },
  async projectActivity({ id, spaces }) {
    const { revision } = activities.record();
    activities.publish(PAGE, PAGE, id, spaces);
    if (activities.record().revision !== revision) sendActivities();
  },
  onProjectActivity: async (fn) => {
    activityListeners.add(fn);
  },
};
