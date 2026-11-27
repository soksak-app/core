// The project and space tab strips of the first rows: the tabs, their rename field, and the draw that keeps a pressed tab.
import { keepChildren } from "./keep-children.js";
import { drawActivity } from "./activity.js";

/** The places of the project tabs (settings projectTabs). */
const PLACES = ["top", "bottom", "left", "right"];

/**
 * Creates the strips. projects is the project module, bind and run are the command functions, redraw draws the bars
 * again, changed reports a change of the rename state, and activities reads the value of core.activity, whose project and space
 * activities the tabs show (docs/spec/activity.md#drawing). groups gives the group cards of the shown space to the rename of the kind
 * group (docs/spec/groups.md#headers): name(id), the name of a group card, rename(id, name), its rename, and redraw(), the draw of
 * the plane that shows the rename field in the header of the group card.
 */
export function createBarTabs({ projects, projectBar, projectRow, spaceBar, workarea, bind, run, redraw, keyboardOwed, changed, activities, groups }) {
  /**
   * Creates one tab. A click switches, a double click renames, and ✕ closes. All three are commands.
   *
   *   pick    {command, params}
   *   close   {command, params} or none
   *   rename  {kind, id} or none
   *   activity  {activity, expose}, the activity of the tab or null and the element name of its icon
   */
  function tab(text, on, { dot, pick, close, rename, expose, closeExpose, activity }) {
    if (rename && renaming?.kind === rename.kind && renaming.id === rename.id) return renameField();
    const el = document.createElement("button");
    el.className = "bar-tab";
    el.dataset.expose = expose;
    el.type = "button";
    el.dataset.on = String(on);
    el.title = text;
    // The project color is shown as the background of the selected tab. No separate mark is used.
    if (dot && on) {
      el.dataset.tinted = "true";
      el.style.setProperty("--project-color", dot);
    }
    const name = document.createElement("span");
    name.className = "bar-tab__name";
    name.textContent = text;
    el.appendChild(name);
    drawActivity(el, name, activity.activity, activity.expose);
    bind(el, pick.command, pick.params);
    if (rename) {
      el.dataset.rename = JSON.stringify(rename);
      el.addEventListener("dblclick", () => run("core.rename.begin", rename));
    }
    if (close) {
      const x = document.createElement("span");
      x.className = "bar-tab__x";
      x.dataset.expose = closeExpose;
      x.setAttribute("role", "button");
      x.textContent = "✕";
      bind(x, close.command, close.params, { stop: true });
      el.appendChild(x);
    }
    return el;
  }

  /* Rename in progress. {kind: "project"|"space"|"group", id, value}. */
  let renaming = null;

  /** Input field in the place of the tab being renamed. Enter confirms, Escape cancels, and losing focus confirms. */
  function renameField() {
    const input = document.createElement("input");
    input.className = "bar-tab__root";
    input.dataset.expose = "core.rename.input";
    input.value = renaming.value;
    // The entered value is recorded with core.rename.set. The confirmation uses that value.
    bind(input, "core.rename.set", () => ({ value: input.value }), { event: "input" });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") return run("core.rename.commit");
      if (e.key === "Escape") return run("core.rename.cancel");
    });
    input.addEventListener("focusout", () => { if (renaming) return run("core.rename.commit"); });
    queueMicrotask(() => { if (input.isConnected) { input.focus(); input.select(); } });
    return input;
  }

  /** Operations that the rename commands call. */
  const renames = {
    begin({ kind, id }) {
      if (kind === "group") {
        renaming = { kind, id, value: groups.name(id) };
        groups.redraw();
        changed();
        return;
      }
      const here = projects.active();
      if (kind === "space" && !here) throw new Error(`no ${kind} ${id}`);
      const list = kind === "project" ? projects.all() : kind === "space" ? here.spaces : null;
      if (!list) throw new Error(`unknown rename target ${kind}`);
      const found = list.find((item) => item.id === id);
      if (!found) throw new Error(`no ${kind} ${id}`);
      renaming = { kind, id, value: found.title };
      redraw();
      changed();
    },
    set(value) {
      if (!renaming) throw new Error("nothing is being renamed");
      renaming.value = String(value);
      changed();
    },
    async commit() {
      if (!renaming) throw new Error("nothing is being renamed");
      const { kind, id, value } = renaming;
      renaming = null;
      const title = value.trim();
      if (title) {
        if (kind === "project") await projects.rename(id, title);
        else if (kind === "group") groups.rename(id, title);
        else projects.renameSpace(id, title);
      }
      if (kind === "group") groups.redraw();
      redraw();
      keyboardOwed();
      changed();
    },
    cancel() {
      if (!renaming) throw new Error("nothing is being renamed");
      const { kind } = renaming;
      renaming = null;
      if (kind === "group") groups.redraw();
      redraw();
      keyboardOwed();
      changed();
    },
    state: () => renaming && { ...renaming },
    /** The rename field of the group card that is renamed, which the header of that group card shows in the place of its name. */
    field: () => renameField(),
  };

  /** Creates the "+" button. */
  function addTabButton(text, command, expose) {
    const b = document.createElement("button");
    b.className = "bar-tab bar-tab--add";
    b.dataset.expose = expose;
    b.type = "button";
    b.textContent = text;
    bind(b, command);
    return b;
  }

  /**
   * Draws the strips. position is the place of the project tabs, one of top (the chrome row), bottom (a row below the work area), left
   * and right (a column at that side of the work area). The project home has no project tab in any place.
   */
  function draw(position) {
    if (!PLACES.includes(position)) throw new Error(`project tabs position ${String(position)} is not one of ${PLACES.join(", ")}`);
    const here = projects.active();
    const browsing = projects.inHome();
    const place = browsing ? "top" : position;
    // A project or a space without an activity is not listed in core.activity.
    const shown = activities().projects;
    const projectActivity = (id) => (Object.hasOwn(shown, id) ? shown[id].activity : null);
    const spaceActivity = (id) => {
      const spaces = here && Object.hasOwn(shown, here.id) ? shown[here.id].spaces : {};
      return Object.hasOwn(spaces, id) ? spaces[id].activity : null;
    };
    /* The project column is created only in the left mode. It is removed, not hidden. [hidden] does not override the rule that
       sets display and .project-column is display:flex, so hiding it would leave an empty
       area. The chrome row, in contrast, is always kept. Even when empty, that row pushes the buttons
       to the right. */
    const sided = place === "left" || place === "right";
    let column = workarea.querySelector(".project-column");
    if (column && (!sided || !column.classList.contains(`project-column--${place}`))) {
      column.remove();
      column = null;
    }
    if (sided && !column) {
      column = document.createElement("div");
      column.className = `project-column project-column--${place}`;
      column.dataset.expose = "core.projects.column";
      // The left column stands before the work area and the right column after it, so the column is the outer edge of the window.
      if (place === "left") workarea.prepend(column);
      else workarea.append(column);
    }
    const into = sided ? column : place === "bottom" ? projectRow : projectBar;
    // A draw keeps the tabs that did not change: replacing a pressed tab between its press and its release would lose the click.
    const projectTab = (p) => {
      const el = tab(p.title, p.id === here?.id, {
        dot: p.color,
        expose: "core.project-tab",
        closeExpose: "core.project-tab.close",
        pick: { command: "core.project.activate", params: { id: p.id } },
        rename: { kind: "project", id: p.id },
        close: { command: "core.project.close", params: { id: p.id } },
        activity: { activity: projectActivity(p.id), expose: "core.activity.project" },
      });
      // The reorder by drag and drop is made by core.project.move.
      if (el.tagName === "BUTTON") {
        el.draggable = true;
        el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", p.id));
        el.addEventListener("dragover", (e) => e.preventDefault());
        el.addEventListener("drop", (e) => {
          e.preventDefault();
          const ids = projects.all().map((p) => p.id);
          const from = ids.indexOf(e.dataTransfer.getData("text/plain"));
          if (from >= 0) return run("core.project.move", { id: ids[from], delta: ids.indexOf(p.id) - from });
        });
      }
      return el;
    };
    const renamed = (kind, id) => renaming?.kind === kind && renaming.id === id;
    const projectTabs = (browsing ? [] : projects.all()).map((p) => ({
      key: JSON.stringify([p.id, p.title, p.id === here?.id, p.color, renamed("project", p.id), projectActivity(p.id)]),
      create: () => projectTab(p),
    }));
    if (!browsing) projectTabs.push({ key: "add", create: () => addTabButton("+", "core.projects.browse", "core.project-tab.add") });
    keepChildren(into, projectTabs);
    // The strips that the position does not use hold no project tab.
    if (into !== projectBar) keepChildren(projectBar, []);
    if (into !== projectRow) keepChildren(projectRow, []);
    projectRow.hidden = place !== "bottom";

    const spaces = here?.spaces ?? []; // default: a window with no project has no space tabs.
    const spaceTabs = spaces.map((sp) => ({
      key: JSON.stringify([sp.id, sp.title, sp.id === here.activeSpaceId, spaces.length > 1, renamed("space", sp.id), spaceActivity(sp.id)]),
      create: () => tab(sp.title, sp.id === here.activeSpaceId, {
        expose: "core.space-tab",
        closeExpose: "core.space-tab.close",
        pick: { command: "core.space.activate", params: { id: sp.id } },
        rename: { kind: "space", id: sp.id },
        close: spaces.length > 1 ? { command: "core.space.close", params: { id: sp.id } } : null,
        activity: { activity: spaceActivity(sp.id), expose: "core.activity.space" },
      }),
    }));
    if (here) spaceTabs.push({ key: "add", create: () => addTabButton("+", "core.space.add", "core.space-tab.add") });
    keepChildren(spaceBar, spaceTabs);
  }

  return { draw, renames };
}
