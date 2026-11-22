// The activities (docs/spec/activity.md): the activity of each tab of a window from the statuses of its plugin that declare activity,
// the highest activity of each card, group card and space of the window, and the record of the activities of the projects of the
// application, which the host holds and the browser runtime holds with createProjectActivities. The shared cases of
// docs/spec/cases/activity.json state them; the Go workbench of packages/workbench-mygo meets the cases of tabs and windows, and the Go
// and the Rust host meet the cases of records.
import { ACTIVITIES } from "@soksak/plugin-api";
import declaration from "./workbench.json" with { type: "json" };
import { declaredIcons } from "./icons.js";

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
    // default: the first invalid value among the statuses is the error that the tab reports.
    error ??= `${plugin} exposes ${name} on tab ${tab}: activity value ${JSON.stringify(value)} is not one of ${ACTIVITIES.join(", ")}`;
    return null;
  });
  return { activity: highestActivity(activities), error };
}

/** The card nodes of the stored tree under node, in tree order (docs/spec/groups.md#storage). */
const cardNodes = (node) => (node.box !== undefined ? cardNodes(node.inner) : node.cut !== undefined ? node.kids.flatMap((kid) => cardNodes(kid.node)) : [node]);

/**
 * The activities of the projects of a window, each {id, spaces} with the stored layout of each space, from the activity of each tab
 * (tabs, by tab id): {spaces, tabs}, where spaces holds for each project the activities of its spaces that the window publishes with
 * projectActivity (docs/spec/activity.md#activity-of-a-card-a-group-card-and-a-space). Each holder is listed only with an activity, and
 * no activity of a project is derived here.
 */
export function windowActivity(projects, tabs) {
  const out = { spaces: {}, tabs: {} };
  for (const project of projects) {
    const spaces = {};
    for (const space of project.spaces) {
      const cards = {};
      const groups = {};
      // The activity of a node of the stored tree is the highest activity of the cards inside it; a box records it as the activity of
      // its group card (docs/spec/groups.md#storage).
      const held = (node) => {
        if (node.box !== undefined) {
          const activity = held(node.inner);
          if (activity !== null) groups[node.box] = activity;
          return activity;
        }
        if (node.cut !== undefined) return highestActivity(node.kids.map((kid) => held(kid.node)));
        // default: a seat card and a window sidebar have null data or no tabs, so they hold no tabs.
        const activity = highestActivity((node.data?.tabs ?? []).map(({ id }) => {
          const value = Object.hasOwn(tabs, id) ? tabs[id] : null;
          if (value !== null) out.tabs[id] = value;
          return value;
        }));
        if (activity !== null) cards[node.card] = activity;
        return activity;
      };
      held(space.layout.state.root);
      const activity = highestActivity(Object.values(cards));
      if (activity !== null) spaces[space.id] = { activity, cards, groups };
    }
    if (Object.keys(spaces).length) out.spaces[project.id] = spaces;
  }
  return out;
}

const PROJECT_ID = /^[a-z0-9-]+$/;
const codePointOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The record of the activities of the projects of the application (docs/spec/activity.md#activity-of-a-project), by project and not by
 * window. publish(window, owner, id, spaces) sets the activities of the spaces of project id that window publishes, where owner is the
 * window that holds the project or null, and throws the text of a refusal; release(id) removes the entry of a released project and
 * end(window) the entries that an ended window published. record() is {revision, projects}; each change raises revision.
 */
export function createProjectActivities() {
  // The entries by project id: the window that published it and the activities of its spaces.
  const entries = new Map();
  let revision = 0;
  const projects = () => {
    const out = {};
    for (const [id, { spaces }] of entries) out[id] = { activity: highestActivity(Object.values(spaces).map((space) => space.activity)), spaces };
    return out;
  };
  const refuse = (at, value) => {
    if (!ACTIVITIES.includes(value)) throw new Error(`${at}: activity ${JSON.stringify(value)} is not one of ${ACTIVITIES.join(", ")}`);
  };
  return {
    publish(window, owner, id, spaces) {
      if (!PROJECT_ID.test(id)) throw new Error("invalid project id");
      if (owner !== window) throw new Error(`project ${id} is not owned by this window`);
      for (const space of Object.keys(spaces).sort(codePointOrder)) {
        const { activity, cards, groups } = spaces[space];
        refuse(`project ${id} space ${space}`, activity);
        for (const card of Object.keys(cards).sort(codePointOrder)) refuse(`project ${id} space ${space} card ${card}`, cards[card]);
        for (const card of Object.keys(groups).sort(codePointOrder)) refuse(`project ${id} space ${space} group ${card}`, groups[card]);
      }
      const held = entries.get(id);
      if (!Object.keys(spaces).length) {
        if (!held) return;
        entries.delete(id);
      } else {
        if (held?.window === window && JSON.stringify(held.spaces) === JSON.stringify(spaces)) return;
        entries.set(id, { window, spaces: structuredClone(spaces) });
      }
      revision += 1;
    },
    release(id) {
      if (entries.delete(id)) revision += 1;
    },
    end(window) {
      let ended = false;
      for (const [id, entry] of entries) {
        if (entry.window !== window) continue;
        entries.delete(id);
        ended = true;
      }
      if (ended) revision += 1;
    },
    record: () => ({ revision, projects: projects() }),
  };
}

/**
 * Follows the statuses that declare activity on the surface of each tab of the projects of the window, by a watch of each surface
 * (docs/spec/activity.md#activity-of-a-tab), and publishes the activities of the spaces of each project of the window after each change
 * of them (docs/spec/activity.md#activity-of-a-project).
 *
 *   observe(name, surface, fn)  follows the status name of surface; fn receives each value, null while the surface has not
 *                               registered it, and the function returns the function that ends it
 *   statuses(plugin)            the names of the statuses of the plugin that declare activity, in the order of its declaration
 *   projects()                  the projects of the window, each {id, spaces} with the stored layout of each space
 *   changed()                   called after the value of core.activity changed
 *   failed(tab, text)           shows the error text of the activity values of the tab, or withdraws it with null
 *   publish(id, spaces)         publishes the activities of the spaces of the project id, {} when none has an activity
 *
 * sync() starts and ends the watches after a layout, a project or the plugins changed; state() is {spaces, tabs} of windowActivity.
 * A project that leaves the window is not published again: the host removes its entry with its release.
 */
export function createActivity({ observe, statuses, programStatus = () => null, projects, changed, failed, programFailed, publish }) {
  // The followed tabs by id: the plugin, each followed status by name with its value and the function that ends its watch, and the
  // program status with its watch (null when the plugin declares none).
  const followed = new Map();
  // The tabs whose error is shown, with its text.
  const errors = new Map();
  // The tabs whose program error is shown, with its text.
  const programErrors = new Map();
  let state = { spaces: {}, tabs: {} };
  // The program state of each tab that has one, by tab id (docs/spec/program-state.md#status).
  let programs = {};
  // The published activities of the spaces of each project of the window, as JSON text, by project id.
  const published = new Map();
  let syncing = false;

  function derive() {
    if (syncing) return;
    const tabs = {};
    const programStates = {};
    for (const [tab, follow] of followed) {
      const { activity, error } = tabActivity(follow.plugin, tab, [...follow.watches].map(([name, { value }]) => ({ name, value })));
      if (activity !== null) tabs[tab] = activity;
      // default: a tab without a recorded error has the error null.
      if (error !== (errors.get(tab) ?? null)) {
        if (error === null) errors.delete(tab);
        else errors.set(tab, error);
        failed(tab, error);
      }
      if (follow.programWatch === null) continue;
      const { program, error: programError } = tabProgram(follow.plugin, follow.program, tab, follow.programWatch.value);
      if (program !== null) programStates[tab] = program;
      // default: a tab without a recorded program error has the error null.
      if (programError !== (programErrors.get(tab) ?? null)) {
        if (programError === null) programErrors.delete(tab);
        else programErrors.set(tab, programError);
        programFailed(tab, programError);
      }
    }
    for (const tab of [...errors.keys()]) {
      if (followed.has(tab)) continue;
      errors.delete(tab);
      failed(tab, null);
    }
    for (const tab of [...programErrors.keys()]) {
      if (followed.get(tab)?.programWatch) continue;
      programErrors.delete(tab);
      programFailed(tab, null);
    }
    const held = projects();
    const next = windowActivity(held, tabs);
    const ids = new Set(held.map(({ id }) => id));
    for (const id of [...published.keys()]) if (!ids.has(id)) published.delete(id);
    for (const id of ids) {
      // default: a project without a space with an activity publishes {}, which a project never published leaves unpublished.
      const spaces = next.spaces[id] ?? {};
      const text = JSON.stringify(spaces);
      // default: a project never published counts as published {}, so its first empty publish is skipped.
      if (text === (published.get(id) ?? "{}")) continue;
      published.set(id, text);
      publish(id, spaces);
    }
    const activityChanged = JSON.stringify(next) !== JSON.stringify(state);
    const programChanged = JSON.stringify(programStates) !== JSON.stringify(programs);
    if (!activityChanged && !programChanged) return;
    state = next;
    programs = programStates;
    changed();
  }

  function sync() {
    // The wanted tabs by id: the plugin and the names of its statuses that declare activity.
    const wanted = new Map();
    for (const project of projects()) {
      for (const space of project.spaces) {
        for (const card of cardNodes(space.layout.state.root)) {
          // default: a seat card has null data, so it holds no tabs.
          for (const tab of card.data?.tabs ?? []) {
            const names = statuses(tab.plugin);
            const program = programStatus(tab.plugin);
            if (names.length || program !== null) wanted.set(tab.id, { plugin: tab.plugin, names, program });
          }
        }
      }
    }
    syncing = true;
    try {
      for (const [tab, follow] of [...followed]) {
        const want = wanted.get(tab);
        if (want?.plugin === follow.plugin && want.names.join("\n") === [...follow.watches.keys()].join("\n") &&
          want.program === follow.program) continue;
        followed.delete(tab);
        for (const { stop } of follow.watches.values()) stop();
        follow.programWatch?.stop();
      }
      for (const [tab, { plugin, names, program }] of wanted) {
        if (followed.has(tab)) continue;
        const follow = { plugin, watches: new Map(), program, programWatch: null };
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
        if (program !== null) {
          // A surface that has not registered the program status gives null, which gives no program state.
          const watch = { value: null, stop: null };
          follow.programWatch = watch;
          watch.stop = observe(program, tab, (value) => {
            if (followed.get(tab) !== follow) return;
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

  return { sync, state: () => state, programs: () => programs };
}

/** The program states of a tab, from the first to the last (docs/spec/program-state.md#value). */
export const PROGRAM_STATES = Object.freeze(["idle", "working", "blocked"]);

/**
 * The program state of the tab tab from the value that its surface reports for the program status of plugin: an object whose only
 * members are state, one of the program states, and pid, a positive integer or null, gives {state, pid}, and null gives none
 * (docs/spec/program-state.md#value). Returns {program, error}: error is the text of any other value, which gives no program state, or null.
 */
export function tabProgram(plugin, status, tab, value) {
  // default: a surface that has not registered the status reports null, which gives no program state.
  if (value === null) return { program: null, error: null };
  const keys = typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const pidValid = value?.pid === null || (Number.isInteger(value?.pid) && value.pid > 0);
  if (keys.length === 2 && keys[0] === "pid" && keys[1] === "state" && PROGRAM_STATES.includes(value.state) && pidValid) {
    return { program: { state: value.state, pid: value.pid }, error: null };
  }
  return {
    program: null,
    error: `${plugin} exposes ${status} on tab ${tab}: program value ${JSON.stringify(value)} is not null or an object with only the members state and pid, where state is one of ${PROGRAM_STATES.join(", ")} and pid is a positive integer or null`,
  };
}

/**
 * Keeps the icon of activity in holder immediately before the element before (docs/spec/activity.md#drawing): an image with the
 * element name expose and the declared name of the activity as its label and tooltip, and none when activity is null. An unchanged
 * activity keeps the drawn icon.
 */
export function drawActivity(holder, before, activity, expose) {
  let icon = holder.querySelector(":scope > .activity");
  if (activity === null) {
    icon?.remove();
    return;
  }
  if (!icon) {
    icon = document.createElement("span");
    icon.className = "activity";
    icon.dataset.expose = expose;
    icon.setAttribute("role", "img");
  }
  if (icon.nextElementSibling !== before) holder.insertBefore(icon, before);
  if (icon.dataset.activity === activity) return;
  const name = declaration.activities[activity];
  icon.dataset.activity = activity;
  icon.setAttribute("aria-label", name);
  icon.title = name;
  icon.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${declaredIcons[`activity-${activity}`]}</svg>`;
}
