// Posts tab notices as operating system notifications (docs/spec/plugins.md#tab-reports). Whenever the notice list changes, a notice that is new
// or changed is posted, and a notice that was removed is removed. Pressing a notice selects its tab.
import { notificationCenter } from "./host.js";
import { onTabReports, tabNotices } from "./tab-reports.js";

/** The last line of the notification help while the permission is denied. */
export const DENIED_LINE = "System notifications are turned off for this application.";

/**
 * post({surface,title,body}) and remove({surface}) are host calls, notices() is the list of [tab, text], tabName(tab) is the name of the
 * tab, and select(tab) runs core.tab.select.
 */
export function createSystemNotifications({ post, remove, notices, tabName, select }) {
  const posted = new Map();
  // The tabs whose notice the notification center accepted and that have not been removed.
  const accepted = [];
  let current = { authorization: "notDetermined", error: null };
  const listeners = new Set();
  const changed = () => { for (const listener of listeners) listener(); };
  const failed = (operation) => (error) => {
    // default: a rejection value may not be an Error, so the value itself is written.
    current = { ...current, error: `${operation}: ${error?.message ?? error}` };
    changed();
  };

  return {
    sync() {
      const now = new Map(notices());
      for (const [tab, text] of now) {
        if (posted.get(tab) === text) continue;
        posted.set(tab, text);
        post({ surface: tab, title: tabName(tab), body: text }).catch(failed("post"));
      }
      for (const tab of [...posted.keys()]) {
        if (now.has(tab)) continue;
        posted.delete(tab);
        const index = accepted.indexOf(tab);
        if (index >= 0) {
          accepted.splice(index, 1);
          changed();
        }
        remove({ surface: tab }).catch(failed("remove"));
      }
    },
    setState(state) {
      // default: the notification state of the host carries error only when there is an error.
      current = { authorization: state.authorization, error: state.error ?? null };
      changed();
    },
    state: () => ({ ...current, posted: [...accepted] }),
    posted({ surface }) {
      if (accepted.includes(surface) || !posted.has(surface)) return;
      accepted.push(surface);
      changed();
    },
    activated: ({ surface }) => select(surface),
    tooltip: (text) => (current.authorization === "denied" ? `${text}\n${DENIED_LINE}` : text),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/* The plane decides the tab names and the tab selection. */
let nameOf = (tab) => tab;
let selectTab = () => Promise.reject(new Error("no tab selection is configured"));

/** The system notifications of this window. Without the application, nothing is posted. */
export const systemNotifications = createSystemNotifications({
  // default: as stated above, the browser example without a host posts no system notifications.
  post: (request) => notificationCenter?.post(request) ?? Promise.resolve(),
  // default: the browser example without a host has no system notification to remove.
  remove: (request) => notificationCenter?.remove(request) ?? Promise.resolve(),
  notices: tabNotices,
  tabName: (tab) => nameOf(tab),
  select: (tab) => selectTab(tab),
});

/** The plane provides the function that finds a tab name and the function that runs core.tab.select. */
export function configureSystemNotifications({ tabName, select }) {
  nameOf = tabName;
  selectTab = select;
}

if (notificationCenter) {
  onTabReports(() => systemNotifications.sync());
  notificationCenter.onState((state) => systemNotifications.setState(state));
  notificationCenter.onPosted((post) => systemNotifications.posted(post));
  notificationCenter.onActivated((activation) => {
    systemNotifications.activated(activation).catch((error) =>
      // default: a rejection value may not be an Error, so the value itself is written.
      systemNotifications.setState({ ...systemNotifications.state(), error: `activate: ${error?.message ?? error}` }));
  });
  notificationCenter.state().then((state) => systemNotifications.setState(state),
    // default: a rejection value may not be an Error, so the value itself is written.
    (error) => systemNotifications.setState({ ...systemNotifications.state(), error: `state: ${error?.message ?? error}` }));
}
