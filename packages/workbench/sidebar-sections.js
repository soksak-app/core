// 사이드바가 보이는 세트의 섹션을 그린다(docs/spec/plugins.md#sections).
//
// 사이드바는 그것을 담은 카드의 id 로 식별한다. 레일, left, right 카드와 inset 사이드바를 가진 카드다.
// 세트의 layout 이 list 이면 모든 섹션을 머리와 함께 쌓고, tabs 이면 고른 탭의 섹션 하나만 마운트한다.
// 탭 선택과 섹션 접힘은 사이드바마다 이 모듈이 보관한다.
import { bind } from "./commands.js";
import { registry } from "./exposure.js";
import { section } from "./registry.js";

/* 사이드바 id 마다 고른 탭과 접힌 섹션. */
const choices = new Map();
/* 그린 세트 요소마다 그 사이드바, 세트, 섹션 항목. */
const drawn = new Map();
const listeners = new Set();

const notify = () => { for (const fn of listeners) fn(); };

/** 섹션의 마운트 상태가 바뀌면 fn 을 호출한다. */
export function onSectionsChange(fn) {
  listeners.add(fn);
}

function choiceOf(sidebar) {
  if (!choices.has(sidebar)) choices.set(sidebar, { tab: null, folded: new Set() });
  return choices.get(sidebar);
}

/** 항목의 모듈을 해제한다. 마운트가 끝나지 않았으면 끝난 뒤 해제한다. */
function unmount(entry) {
  if (!entry.mount) return;
  const pending = entry.mount;
  entry.mount = null;
  entry.mounted = false;
  entry.error = null;
  // 해제 중의 마운트 실패와 해제 실패는 페이지 오류로 보고한다(docs/spec/plugins.md). 항목은 이미 해제되어
  // core.sidebars 의 error 로는 보이지 않는다.
  pending.then((result) => result.dispose()).catch((error) => {
    dispatchEvent(new ErrorEvent("error", { message: `section ${entry.section.id}: ${error.message}` }));
  });
  for (const stop of entry.observing.splice(0)) stop();
}

/**
 * 섹션 모듈이 받는 문맥. card 와 surface 에 더해, 섹션을 가진 플러그인의 status 를 따라가는
 * status(name, fn) 과 요소를 그 플러그인의 명령에 연결하는 bind(el, name, params, options) 를 준다.
 */
function sectionContext(entry, context) {
  const owner = entry.section.id.slice(0, entry.section.id.indexOf("."));
  const own = (name) => {
    if (!name.startsWith(`${owner}.`)) throw new Error(`section ${entry.section.id} cannot use ${name}`);
  };
  return {
    card: context.card,
    surface: context.surface,
    status(name, fn) {
      own(name);
      const stop = registry.observe(name, context.surface, fn);
      entry.observing.push(stop);
      return () => {
        const at = entry.observing.indexOf(stop);
        if (at >= 0) entry.observing.splice(at, 1);
        stop();
      };
    },
    bind(el, name, params, options) {
      own(name);
      el.dataset.expose = "core.sidebar.section.control";
      return bind(el, name, params, options);
    },
  };
}

function mount(entry, context) {
  if (entry.mount) return;
  const mountOnce = entry.mount = import(entry.section.module).then(async (module) => {
    if (typeof module.mount !== "function") throw new TypeError(`section ${entry.section.id} module has no mount()`);
    const result = await module.mount(entry.body, sectionContext(entry, context));
    if (!result || typeof result.dispose !== "function") {
      throw new TypeError(`section ${entry.section.id} mount() must return { dispose() }`);
    }
    return result;
  });
  mountOnce.then(() => {
    if (entry.mount !== mountOnce) return;
    entry.mounted = true;
    notify();
  }, (error) => {
    if (entry.mount !== mountOnce) return;
    entry.error = error.message;
    notify();
  });
}

/** 세트 요소 하나의 모든 섹션을 해제하고 기록을 지운다. */
export function clearSet(container) {
  const record = drawn.get(container);
  if (!record) return;
  for (const entry of record.entries) {
    unmount(entry);
    entry.watcher?.disconnect();
  }
  drawn.delete(container);
  container.replaceChildren();
  delete container.dataset.sidebar;
  notify();
}

/** 문서에서 빠진 세트 요소의 섹션을 해제한다. */
function sweep() {
  for (const container of [...drawn.keys()]) if (!container.isConnected) clearSet(container);
}

/** 고른 탭과 접힘을 요소와 마운트에 반영한다. */
function apply(record) {
  const choice = choiceOf(record.sidebar);
  for (const entry of record.entries) {
    const id = entry.section.id;
    if (record.layout === "tabs") {
      const selected = choice.tab === id;
      entry.tab.setAttribute("aria-selected", String(selected));
      entry.element.hidden = !selected;
      if (selected) mount(entry, record.context);
      else unmount(entry);
    } else {
      const folded = choice.folded.has(id);
      entry.element.dataset.folded = String(folded);
      entry.header.setAttribute("aria-expanded", String(!folded));
      mount(entry, record.context);
    }
  }
}

/**
 * container 에 사이드바 sidebar 의 세트 set 을 그린다. context 는 섹션 모듈이 받는 {card, surface} 다.
 * 세트, 레이아웃, 섹션 목록, 문맥이 같으면 요소와 마운트를 유지한다.
 */
export function drawSet(container, sidebar, set, context) {
  sweep();
  if (set.layout !== "list" && set.layout !== "tabs") throw new Error(`set ${set.id} layout must be list or tabs`);
  const sections = set.sections.map(section);
  const choice = choiceOf(sidebar);
  if (set.layout === "tabs" && !sections.some((s) => s.id === choice.tab)) choice.tab = sections[0]?.id ?? null;
  const key = JSON.stringify([sidebar, set.id, set.title, set.layout, sections.map((s) => s.id), context.card, context.surface]);
  let record = drawn.get(container);
  if (record?.key !== key) {
    if (record) clearSet(container);
    record = { sidebar, key, set: set.id, layout: set.layout, context, entries: [] };
    drawn.set(container, record);
    container.dataset.sidebar = sidebar;
    delete container.dataset.html;
    const title = document.createElement("b");
    title.textContent = set.title;
    container.replaceChildren(title);
    let strip = null;
    if (set.layout === "tabs") {
      strip = document.createElement("div");
      strip.className = "set__tabs";
      strip.setAttribute("role", "tablist");
      container.append(strip);
    }
    for (const section of sections) {
      const element = document.createElement("section");
      element.className = "set__section";
      element.dataset.expose = "core.sidebar.section";
      element.dataset.section = section.id;
      const entry = { section, element, header: null, tab: null, body: document.createElement("div"),
        mount: null, mounted: false, error: null, observing: [] };
      entry.body.className = "set__body";
      if (context.surface) entry.body.dataset.surface = context.surface;
      // 섹션이 그린 내용은 core.sidebars 의 text 로 드러나므로, 내용이 바뀌면 알린다.
      entry.watcher = typeof MutationObserver === "function" ? new MutationObserver(notify) : null;
      entry.watcher?.observe(entry.body, { subtree: true, childList: true, characterData: true });
      const params = { sidebar, section: section.id };
      if (strip) {
        entry.tab = document.createElement("button");
        entry.tab.type = "button";
        entry.tab.className = "set__tab";
        entry.tab.setAttribute("role", "tab");
        entry.tab.dataset.expose = "core.sidebar.section.tab";
        entry.tab.textContent = section.name;
        bind(entry.tab, "core.sidebar.section.select", params);
        strip.append(entry.tab);
        element.append(entry.body);
      } else {
        entry.header = document.createElement("button");
        entry.header.type = "button";
        entry.header.className = "set__head";
        entry.header.dataset.expose = "core.sidebar.section.header";
        entry.header.textContent = section.name;
        bind(entry.header, "core.sidebar.section.fold", params);
        element.append(entry.header, entry.body);
      }
      record.entries.push(entry);
      container.append(element);
    }
    notify();
  }
  apply(record);
}

function recordsOf(sidebar, section) {
  sweep();
  const records = [...drawn.values()].filter((record) => record.sidebar === sidebar);
  if (records.length === 0) throw new Error(`no sidebar ${sidebar} is drawn`);
  if (!records[0].entries.some((entry) => entry.section.id === section)) {
    throw new Error(`sidebar ${sidebar} has no section ${section}`);
  }
  return records;
}

/** tabs 레이아웃 사이드바에서 섹션 하나를 고른다. */
export function selectSection(sidebar, section) {
  const records = recordsOf(sidebar, section);
  if (records[0].layout !== "tabs") throw new Error(`sidebar ${sidebar} does not use the tabs layout`);
  choiceOf(sidebar).tab = section;
  for (const record of records) apply(record);
  notify();
}

/** list 레이아웃 사이드바에서 섹션 하나를 접거나 편다. */
export function foldSection(sidebar, section) {
  const records = recordsOf(sidebar, section);
  if (records[0].layout !== "list") throw new Error(`sidebar ${sidebar} does not use the list layout`);
  const { folded } = choiceOf(sidebar);
  if (folded.has(section)) folded.delete(section);
  else folded.add(section);
  for (const record of records) apply(record);
  notify();
}

/** 문서 순서의 그린 사이드바. core.sidebars 의 값이다. */
export function sidebarsState() {
  return [...document.querySelectorAll(".set[data-sidebar]")].map((container) => drawn.get(container)).filter(Boolean)
    .map((record) => {
      const choice = choiceOf(record.sidebar);
      return {
        sidebar: record.sidebar, set: record.set, layout: record.layout,
        tab: record.layout === "tabs" ? choice.tab : null,
        card: record.context.card, surface: record.context.surface,
        sections: record.entries.map((entry) => ({
          id: entry.section.id, name: entry.section.name,
          folded: record.layout === "list" && choice.folded.has(entry.section.id),
          mounted: entry.mounted, error: entry.error, text: entry.body.textContent,
        })),
      };
    });
}
