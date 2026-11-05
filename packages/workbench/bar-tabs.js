// The project and space tab strips of the first rows: the tabs, their rename field, and the draw that keeps a pressed tab.
import { keepChildren } from "./keep-children.js";

/**
 * Creates the strips. projects is the project module, bind and run are the command functions, redraw draws the bars
 * again, and changed reports a change of the rename state.
 */
export function createBarTabs({ projects, projectBar, spaceBar, workarea, bind, run, redraw, keyboardOwed, changed }) {
  /**
   * Creates one tab. A click switches, a double click renames, and ✕ closes. All three are commands.
   *
   *   pick    {command, params}
   *   close   {command, params} or none
   *   rename  {kind, id} or none
   */
  function tab(text, on, { dot, pick, close, rename, expose, closeExpose }) {
    if (rename && renaming?.kind === rename.kind && renaming.id === rename.id) return renameField(text);
    const el = document.createElement("button");
    el.className = "bar-tab";
    el.dataset.expose = expose;
    el.type = "button";
    el.dataset.on = String(on);
    el.title = text;
    // The project color is shown as the background of the selected tab. No separate mark is used.
    if (dot && on) el.style.background = `color-mix(in srgb, ${dot} 24%, transparent)`;
    const name = document.createElement("span");
    name.className = "bar-tab__name";
    name.textContent = text;
    el.appendChild(name);
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

  /* Rename in progress. {kind: "project"|"space", id, value}. */
  let renaming = null;

  /** Input field in the place of the tab being renamed. Enter confirms, Escape cancels, and losing focus confirms. */
  function renameField(was) {
    const input = document.createElement("input");
    input.className = "bar-tab__root";
    input.dataset.expose = "core.rename.input";
    input.value = renaming.value ?? was;
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
      const list = kind === "project" ? projects.all() : kind === "space" ? projects.active()?.spaces ?? [] : null;
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
        else projects.renameSpace(id, title);
      }
      redraw();
      keyboardOwed();
      changed();
    },
    cancel() {
      if (!renaming) throw new Error("nothing is being renamed");
      renaming = null;
      redraw();
      keyboardOwed();
      changed();
    },
    state: () => renaming && { ...renaming },
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

  function draw(left) {
    const here = projects.active();
    const browsing = projects.inLibrary();
    const toLeft = !browsing && left;
    /* The project column is created only in the left mode. It is removed, not hidden. [hidden] does not override the rule that
       sets display and .project-column is display:flex, so hiding it would leave an empty
       area. The chrome row, in contrast, is always kept. Even when empty, that row pushes the buttons
       to the right. */
    let column = workarea.querySelector(".project-column");
    if (toLeft && !column) {
      column = document.createElement("div");
      column.className = "project-column";
      column.dataset.expose = "core.projects.column";
      workarea.prepend(column);
    } else if (!toLeft && column) {
      column.remove();
      column = null;
    }
    const into = toLeft ? column : projectBar;
    // A draw keeps the tabs that did not change: replacing a pressed tab between its press and its release would lose the click.
    const projectTab = (p) => {
      const el = tab(p.title, p.id === here?.id, {
        dot: p.color,
        expose: "core.project-tab",
        closeExpose: "core.project-tab.close",
        pick: { command: "core.project.activate", params: { id: p.id } },
        rename: { kind: "project", id: p.id },
        close: { command: "core.project.close", params: { id: p.id } },
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
      key: JSON.stringify([p.id, p.title, p.id === here?.id, p.color, renamed("project", p.id)]),
      create: () => projectTab(p),
    }));
    if (!browsing) projectTabs.push({ key: "add", create: () => addTabButton("+", "core.projects.browse", "core.project-tab.add") });
    keepChildren(into, projectTabs);
    if (column) keepChildren(projectBar, []);

    const spaces = here?.spaces ?? [];
    const spaceTabs = spaces.map((sp) => ({
      key: JSON.stringify([sp.id, sp.title, sp.id === here.activeSpaceId, spaces.length > 1, renamed("space", sp.id)]),
      create: () => tab(sp.title, sp.id === here.activeSpaceId, {
        expose: "core.space-tab",
        closeExpose: "core.space-tab.close",
        pick: { command: "core.space.activate", params: { id: sp.id } },
        rename: { kind: "space", id: sp.id },
        close: spaces.length > 1 ? { command: "core.space.close", params: { id: sp.id } } : null,
      }),
    }));
    if (here) spaceTabs.push({ key: "add", create: () => addTabButton("+", "core.space.add", "core.space-tab.add") });
    keepChildren(spaceBar, spaceTabs);
  }

  return { draw, renames };
}
