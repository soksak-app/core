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
 * The activity of the tab tab of plugin from the statuses of the plugin that declare activity, each {name, value} with the value that
 * the surface of the tab reports, value absent while the surface has not registered the status: a status whose value is an activity
 * gives it, and null gives none. Returns {activity, error}: error is the text of the first status in the order of statuses whose value
 * is neither an activity nor null, which gives no activity (docs/spec/activity.md#activity-of-a-tab), or null.
 */
export function tabActivity(plugin, tab, statuses) {
  let error = null;
  const activities = statuses.map(({ name, value }) => {
    // default: a status that the surface has not registered gives no activity.
    if (value === undefined || value === null) return null;
    if (ACTIVITIES.includes(value)) return value;
    error ??= `${plugin} exposes ${name} on tab ${tab}: activity value ${JSON.stringify(value)} is not one of ${ACTIVITIES.join(", ")}`;
    return null;
  });
  return { activity: highestActivity(activities), error };
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
 *   statuses(plugin)            the names of the statuses of the plugin that declare activity, in the order of its declaration
 *   projects()                  the projects of the window, each {id, spaces} with the stored layout of each space
 *   changed()                   called after the value of core.activity changed
 *   failed(tab, text)           shows the error text of the activity values of the tab, or withdraws it with null
 *
 * sync() starts and ends the watches after a layout, a project or the plugins changed; state() is the value of core.activity.
 */
export function createActivity({ observe, statuses, projects, changed, failed }) {
  // The followed tabs by id: the plugin, and each followed status by name with its value and the function that ends its watch.
  const followed = new Map();
  // The tabs whose error is shown, with its text.
  const errors = new Map();
  let state = { projects: {}, tabs: {} };
  let syncing = false;

  function derive() {
    if (syncing) return;
    const tabs = {};
    for (const [tab, { plugin, watches }] of followed) {
      const { activity, error } = tabActivity(plugin, tab, [...watches].map(([name, { value }]) => ({ name, value })));
      if (activity !== null) tabs[tab] = activity;
      if (error !== (errors.get(tab) ?? null)) {
        if (error === null) errors.delete(tab);
        else errors.set(tab, error);
        failed(tab, error);
      }
    }
    for (const tab of [...errors.keys()]) {
      if (followed.has(tab)) continue;
      errors.delete(tab);
      failed(tab, null);
    }
    const next = windowActivity(projects(), tabs);
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    changed();
  }

  function sync() {
    // The wanted tabs by id: the plugin and the names of its statuses that declare activity.
    const wanted = new Map();
    for (const project of projects()) {
      for (const space of project.spaces) {
        for (const card of space.layout.state.cards) {
          // default: a seat card has null data, so it holds no tabs.
          for (const tab of card.data?.tabs ?? []) {
            const names = statuses(tab.plugin);
            if (names.length) wanted.set(tab.id, { plugin: tab.plugin, names });
          }
        }
      }
    }
    syncing = true;
    try {
      for (const [tab, follow] of [...followed]) {
        const want = wanted.get(tab);
        if (want?.plugin === follow.plugin && want.names.join("\n") === [...follow.watches.keys()].join("\n")) continue;
        followed.delete(tab);
        for (const { stop } of follow.watches.values()) stop();
      }
      for (const [tab, { plugin, names }] of wanted) {
        if (followed.has(tab)) continue;
        const follow = { plugin, watches: new Map() };
        followed.set(tab, follow);
        for (const name of names) {
          const watch = { value: null, stop: null };
          follow.watches.set(name, watch);
          watch.stop = observe(name, tab, (value) => {
            if (followed.get(tab) !== follow) return;
            // A surface that has not registered the status gives null, which gives no activity.
            watch.value = value;
            derive();
          });
        }
      }
    } finally {
      syncing = false;
    }
    derive();
  }

  return { sync, state: () => state };
}

