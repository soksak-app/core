// The activities of a window (docs/spec/activity.md): the activity of each tab from the statuses of its plugin that declare activity,
// and the highest activity of each card, group card, space and project. The shared cases of docs/spec/cases/activity.json state them,
// and the Go workbench of packages/workbench-mygo meets the same cases.
import { ACTIVITIES } from "@soksak/plugin-api";

/** The highest of the activities, or null when none is given. null stands for no activity. */
export function highestActivity(activities) {
  let highest = null;
  for (const activity of activities) {
    if (activity !== null && (highest === null || ACTIVITIES.indexOf(activity) < ACTIVITIES.indexOf(highest))) highest = activity;
  }
  return highest;
}

/**
 * The activity of a tab from the statuses of its plugin that declare activity, each {activity, value} with the value that its surface
 * reports, value absent while the surface has not registered the status: a string value that names a member gives that activity.
 */
export function tabActivity(statuses) {
  return highestActivity(statuses.map(({ activity, value }) => (typeof value === "string" && Object.hasOwn(activity, value) ? activity[value] : null)));
}

/**
 * The value of core.activity for the projects of a window, each {id, spaces} with the stored layout of each space, from the activity of
 * each tab (tabs, by tab id). Each holder is listed only with an activity.
 */
export function windowActivity(projects, tabs) {
  const out = { projects: {}, tabs: {} };
  for (const project of projects) {
    const spaces = {};
    for (const space of project.spaces) {
      const cards = {};
      const groups = {};
      for (const card of space.layout.state.cards) {
        // default: a seat card has null data, so it holds no tabs.
        const held = (card.data?.tabs ?? []).map(({ id }) => {
          const activity = Object.hasOwn(tabs, id) ? tabs[id] : null;
          if (activity !== null) out.tabs[id] = activity;
          return activity;
        });
        const activity = highestActivity(held);
        if (activity !== null) cards[card.id] = activity;
      }
      // A member is a content card by its identifier or the node of a group card (docs/spec/groups.md#storage).
      const member = (node) => (typeof node === "string" ? (cards[node] ?? null) : group(node));
      const group = (node) => {
        const activity = highestActivity(node.members.map(member));
        if (activity !== null) groups[node.card] = activity;
        return activity;
      };
      for (const node of space.layout.groups) group(node);
      const activity = highestActivity(Object.values(cards));
      if (activity !== null) spaces[space.id] = { activity, cards, groups };
    }
    const activity = highestActivity(Object.values(spaces).map((space) => space.activity));
    if (activity !== null) out.projects[project.id] = { activity, spaces };
  }
  return out;
}

/**
 * Follows the statuses that declare activity on the surface of each tab of the projects of the window, by a watch of each surface
 * (docs/spec/activity.md#activity-of-a-tab).
 *
 *   observe(name, surface, fn)  follows the status name of surface; fn receives each value, null while the surface has not
 *                               registered it, and the function returns the function that ends it
 *   statuses(plugin)            the statuses of the plugin that declare activity, each {name, activity}
 *   projects()                  the projects of the window, each {id, spaces} with the stored layout of each space
 *   changed()                   called after the value of core.activity changed
 *
 * sync() starts and ends the watches after a layout, a project or the plugins changed; state() is the value of core.activity.
 */
export function createActivity({ observe, statuses, projects, changed }) {
  // Each followed status of a tab by the key [tab, name]: its declared activity, its value and the function that ends the watch.
  const followed = new Map();
  let state = { projects: {}, tabs: {} };
  let syncing = false;

  function derive() {
    if (syncing) return;
    const tabs = {};
    for (const [key, follow] of followed) {
      const [tab] = JSON.parse(key);
      tabs[tab] = highestActivity([Object.hasOwn(tabs, tab) ? tabs[tab] : null, tabActivity([follow])]);
    }
    const next = windowActivity(projects(), tabs);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    changed();
  }

  function sync() {
    const wanted = new Map();
    for (const project of projects()) {
      for (const space of project.spaces) {
        for (const card of space.layout.state.cards) {
          // default: a seat card has null data, so it holds no tabs.
          for (const tab of card.data?.tabs ?? []) {
            for (const status of statuses(tab.plugin)) wanted.set(JSON.stringify([tab.id, status.name]), status.activity);
          }
        }
      }
    }
    syncing = true;
    try {
      for (const [key, follow] of [...followed]) {
        if (wanted.get(key) === follow.activity) continue;
        followed.delete(key);
        follow.stop();
      }
      for (const [key, activity] of wanted) {
        if (followed.has(key)) continue;
        const [tab, name] = JSON.parse(key);
        const follow = { activity, value: null, stop: null };
        followed.set(key, follow);
        follow.stop = observe(name, tab, (value) => {
          if (followed.get(key) !== follow) return;
          // A surface that has not registered the status gives null, which names no activity.
          follow.value = value;
          derive();
        });
      }
    } finally {
      syncing = false;
    }
    derive();
  }

  return { sync, state: () => state };
}
