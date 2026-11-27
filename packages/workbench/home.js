// The project home: the launcher that a window shows when it has no project in front (docs/spec/projects.md#project-home). It lists the
// projects of the registry, opens one in place, pins, and removes records from the list. It has no tabs and no plugin entry.
import * as projects from "./projects.js";
import { fresh } from "./plane.js";
import { windows } from "@soksak/runtime";
import { icon } from "./icons.js";
import { delegate, mark, run } from "./commands.js";
import { errorToasts, hideError, showError } from "./shown-errors.js";

const TINTS = ["#ffb36b", "#7fe3b0", "#7db4ff", "#e08bd8", "#f2d16b"];

const element = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/* Folder error messages of the host (workspace.folder.messages in docs/spec/host-contract.md) and the reason shown on the row. The row shows the path
   on its own line, so the reason does not contain the path. */
const FOLDER_REASONS = [
  ['project directory does not exist: ', '폴더가 없습니다.'],
  ['project directory is not readable: ', '폴더를 읽을 권한이 없습니다.'],
  ['not a project directory: ', '폴더가 아니라 파일입니다.'],
];

/** Converts a folder error message to the reason of the row. A message that is not in the contract is shown unchanged. */
function folderReason(message) {
  const known = FOLDER_REASONS.find(([prefix]) => message.startsWith(prefix));
  return known ? known[1] : `폴더를 확인할 수 없습니다: ${message}`;
}

/** The relative day of the last opening: 오늘, 어제, N일 전 within the last week, and M월 D일 for older days. */
function dayLabel(time, nowTime) {
  const day = (value) => { const d = new Date(value); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000; };
  const days = Math.round(day(nowTime) - day(time));
  if (days <= 0) return '오늘';
  if (days === 1) return '어제';
  if (days < 7) return `${days}일 전`;
  const d = new Date(time);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** The order of the rows: pinned projects first, then the newest last-opened time first. */
function ordered(list) {
  // default: a project that was never opened has no lastOpened, so it sorts as the oldest.
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
}

/**
 * Creates the project home. The home draws into root; render redraws it from the registry, and state reads the screen.
 */
export function createHome(root) {
  root.innerHTML = `
    <main class="home">
      <div class="home__panel">
        <div class="home__brand"><span class="home__logo" aria-hidden="true"></span><span class="home__name">SOKSAK</span><span class="home__question">어디서 시작할까?</span></div>
        <label class="home__search"><span class="sr-only">프로젝트 찾기</span><input class="text-field" type="search" data-expose="core.home.search" data-command="core.home.search" data-value="query" data-live placeholder="프로젝트 찾기 또는 폴더 경로 붙여넣기" autocomplete="off"></label>
        <div class="home__actions"></div>
        <div class="home__form" hidden></div>
        <div class="home__list" role="list"></div>
        <p class="home__hint"><span>↑↓ 이동</span><span>Enter 열기</span><span>⌘⌫ 목록에서 빼기</span><span>⌘, 설정</span></p>
      </div>
    </main>`;
  const search = root.querySelector('[data-expose="core.home.search"]');
  const list = root.querySelector('.home__list');
  const actionsRow = root.querySelector('.home__actions');
  const form = root.querySelector('.home__form');
  const errors = errorToasts(root.ownerDocument);
  // Keeps the rows of the last render, so that a row which did not change stays in the document.
  const rows = new Map();
  let selected = null;
  let confirming = null;
  let pending = false;
  let formMode = null;
  let formPath = null;

  // default: a folder that has not been read yet has no error.
  const folders = new Map();
  const checks = new Map();
  let checkCount = 0;
  let foldersFor = null;

  // default: an error value without a message is shown as the value itself.
  const fail = (reason) => errors.show(String(reason.message ?? reason), '', 'home', 'home');
  async function perform(work) {
    if (pending) return;
    pending = true; errors.withdraw('home');
    root.setAttribute('aria-busy', 'true');
    try { await work(); } catch (reason) { fail(reason); }
    finally { pending = false; root.removeAttribute('aria-busy'); render(); }
  }

  /** The projects that the search matches by name and path. */
  function matching() {
    const query = search.value.trim().toLocaleLowerCase();
    return ordered(projects.all().filter((p) => `${p.title} ${p.root}`.toLocaleLowerCase().includes(query)));
  }

  /* Folder checks: each path is asked of the host when the list changes. Only the answer of the latest check of a path replaces its result. */
  function checkFolders(all) {
    const key = all.map((p) => p.root).join('\n');
    if (foldersFor === key) return;
    foldersFor = key;
    for (const path of [...folders.keys()]) if (!all.some((p) => p.root === path)) { folders.delete(path); checks.delete(path); hideError(document, `home project ${path}`); }
    for (const project of all) {
      const check = ++checkCount;
      checks.set(project.root, check);
      windows.folder(project.root).then(
        () => settleFolder(project.root, check, null),
        (reason) => settleFolder(project.root, check, String(reason.message)),
      );
    }
  }
  function settleFolder(path, check, error) {
    if (checks.get(path) !== check) return;
    folders.set(path, error);
    render();
  }

  /** One row. The row presses open the project; its buttons run their own commands. */
  function rowNode(project, group) {
    const open = projects.isOpen(project.id);
    // default: a folder without a recorded error has no error.
    const folderError = folders.get(project.root) ?? null;
    const isConfirming = confirming === project.id;
    const row = element('div', 'home-row');
    row.dataset.projectId = project.id;
    row.dataset.selected = String(selected === project.id);
    row.dataset.open = String(open);
    row.dataset.pinned = String(Boolean(project.pinned));
    row.setAttribute('role', 'listitem');
    row.dataset.group = group;
    if (isConfirming) {
      row.dataset.confirm = '';
      const text = element('p', 'home-row__confirm');
      text.append(element('strong', '', project.title), document.createTextNode(' — 목록에서 뺄까? 폴더는 그대로 둔다.'));
      const cancel = element('button', 'ui-button', '취소'); cancel.type = 'button'; cancel.dataset.expose = 'core.home.confirm';
      mark(cancel, 'core.home.confirm', { project: project.id, answer: 'no' });
      const yes = element('button', 'ui-button danger', '빼기'); yes.type = 'button'; yes.dataset.expose = 'core.home.confirm';
      mark(yes, 'core.home.confirm', { project: project.id, answer: 'yes' });
      const buttons = element('div', 'home-row__buttons');
      buttons.append(cancel, yes);
      row.append(text, buttons);
      return row;
    }
    mark(row, 'core.home.open', { project: project.id });
    // default: a title without a character has an empty mark.
    const letter = element('span', 'home-row__mark', [...project.title][0] ?? '');
    letter.setAttribute('aria-hidden', 'true');
    const main = element('div', 'home-row__main');
    const name = element('button', 'home-row__name', project.title); name.type = 'button'; name.dataset.expose = 'core.home.open';
    mark(name, 'core.home.open', { project: project.id });
    if (open) name.append(element('span', 'home-row__badge', '열림'));
    const path = element('p', 'home-row__path', project.root); path.title = project.root;
    main.append(name, path);
    if (folderError !== null) {
      main.append(element('p', 'home-row__missing', '폴더를 열 수 없음'));
      showError(document, `home project ${project.root}`, folderReason(folderError));
    } else if (folders.has(project.root)) {
      hideError(document, `home project ${project.root}`);
    }
    const meta = element('p', 'home-row__meta', `스페이스 ${project.spaces.length}`);
    // default: a project that was never opened has no last-opened time, so its row shows no day.
    const day = project.lastOpened === undefined || project.lastOpened === null ? '' : dayLabel(project.lastOpened, Date.now());
    meta.append(document.createElement('br'), document.createTextNode(day));
    const pin = element('button', 'home-row__pin act'); pin.type = 'button'; pin.dataset.expose = 'core.home.pin';
    pin.innerHTML = icon('star');
    pin.title = project.pinned ? '고정 풀기' : '위에 고정';
    pin.setAttribute('aria-label', `${project.title} ${project.pinned ? '고정 풀기' : '위에 고정'}`);
    mark(pin, 'core.home.pin', { project: project.id });
    const remove = element('button', 'home-row__remove act'); remove.type = 'button'; remove.dataset.expose = 'core.home.remove-ask';
    remove.innerHTML = icon('close');
    remove.title = `${project.title} 목록에서 빼기`;
    remove.setAttribute('aria-label', `${project.title} 목록에서 빼기`);
    mark(remove, 'core.home.confirm', { project: project.id, answer: 'ask' });
    row.append(letter, main, meta, pin, remove);
    return row;
  }

  /** Draws the list: the groups, the rows, the path row or the no-result note, and the add buttons. */
  function renderList(shown) {
    const wanted = [];
    const pinned = shown.filter((p) => p.pinned);
    const others = shown.filter((p) => !p.pinned);
    const groupTitle = (text) => { const node = element('p', 'home-group__title', text); wanted.push(node); };
    const seen = new Set();
    const nodes = (items, group) => items.map((project) => {
      seen.add(project.id);
      // default: a row whose state did not change is kept.
      const key = JSON.stringify([project, selected === project.id, confirming === project.id, projects.isOpen(project.id), folders.get(project.root) ?? null, group]);
      const kept = rows.get(project.id);
      if (kept?.key === key) return kept.node;
      const node = rowNode(project, group);
      rows.set(project.id, { key, node });
      return node;
    });
    // A group title shows only while a pinned project exists.
    if (pinned.length) { groupTitle('고정'); wanted.push(...nodes(pinned, 'pinned')); }
    if (pinned.length && others.length) groupTitle('최근');
    if (others.length) wanted.push(...nodes(others, 'recent'));
    for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);
    const query = search.value.trim();
    if (!shown.length && query) {
      if (/^[/~]/.test(query)) {
        const path = element('div', 'home-path');
        path.append(element('span', 'home-path__text', '이 경로를 프로젝트로 연다: '), element('code', 'home-path__value', query));
        const open = element('button', 'ui-button primary', '열기'); open.type = 'button';
        open.dataset.expose = 'core.home.path';
        mark(open, 'core.home.form.open', { mode: 'open', parent: query });
        path.append(open);
        wanted.push(path);
      } else {
        const note = element('p', 'home-no-results', `“${query}”와 맞는 프로젝트가 없다.`);
        note.dataset.expose = 'core.home.no-results';
        wanted.push(note);
      }
    }
    place(list, wanted);
  }

  /** Arranges the children of parent in the order of nodes. An element already in place is not moved, and a child that is not in nodes is removed. */
  function place(parent, nodes) {
    const keep = new Set(nodes);
    for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
    // default: a node after the last child of the parent is inserted last.
    nodes.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null); });
  }

  /** The actions row: the new project button and the open folder button. */
  function renderActions() {
    if (actionsRow.children.length) return;
    const add = element('button', 'ui-button primary', '새 프로젝트'); add.type = 'button';
    add.dataset.expose = 'core.home.add';
    mark(add, 'core.home.form.open', { mode: 'create' });
    const open = element('button', 'ui-button', '폴더 열기'); open.type = 'button';
    open.dataset.expose = 'core.home.open-folder';
    mark(open, 'core.home.form.open', { mode: 'open' });
    actionsRow.append(add, open);
  }

  function renderForm() {
    if (form.hidden) return;
    if (form.dataset.mode === formMode) return;
    form.dataset.mode = formMode;
    form.innerHTML = '';
    const creates = formMode === 'create';
    form.append(element('h2', '', creates ? '새 폴더로 프로젝트 만들기' : '기존 폴더로 프로젝트 만들기'));
    const fields = element('form', 'home-form__fields');
    const field = (name, title, placeholder, expose) => {
      const label = element('label', '', title), input = element('input', 'text-field');
      input.name = name; input.dataset.expose = expose; input.placeholder = placeholder; input.required = true; input.autocomplete = 'off';
      mark(input, 'core.home.form.set', { field: name }); input.dataset.live = '';
      label.append(input); fields.append(label); return input;
    };
    if (creates) field('name', '프로젝트 폴더 이름', 'my-project', 'core.home.form.name');
    const parent = field('parent', creates ? '생성 위치' : '폴더 경로', '/Users/…', 'core.home.form.parent');
    if (formPath !== null) parent.value = formPath;
    const choose = element('button', 'ui-button', '폴더 선택'); choose.type = 'button'; choose.dataset.expose = 'core.home.form.choose';
    mark(choose, 'core.home.choose-folder');
    parent.parentElement.append(choose);
    const actions = element('div', 'home-form__actions');
    const cancel = element('button', 'ui-button', '취소'); cancel.type = 'button'; cancel.dataset.expose = 'core.home.form.cancel';
    mark(cancel, 'core.home.form.cancel');
    const submit = element('button', 'ui-button primary', creates ? '생성 후 열기' : '프로젝트로 열기'); submit.type = 'button'; submit.dataset.expose = 'core.home.form.submit';
    mark(submit, 'core.home.form.submit');
    actions.append(cancel, submit); fields.append(actions); form.append(fields);
    // Enter runs the submit command. The default submission of the form is not used.
    fields.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); submit.click(); } });
    fields.querySelector('input').focus();
  }

  function formField(name) {
    const input = form.querySelector(`input[name="${name}"]`);
    if (form.hidden || !input) throw new Error(`the form has no ${name} field`);
    return input;
  }

  function render() {
    if (!projects.inHome()) return;
    const all = projects.all();
    checkFolders(all);
    const shown = matching();
    // default: when the selected row left the list, the first row is selected.
    if (!shown.some((p) => p.id === selected)) selected = shown[0]?.id ?? null;
    // Each row carries its selection, so the rows of the selection and of the previous selection are drawn again.
    renderActions();
    renderList(shown);
    renderForm();
  }

  const state = () => {
    const folderErrors = {};
    for (const project of projects.all()) if (folders.get(project.root)) folderErrors[project.id] = folders.get(project.root);
    return {
      query: search.value,
      selected,
      rows: matching().map((p) => p.id),
      confirming,
      previewErrors: {},
      folderErrors,
      formMode: form.hidden ? null : formMode,
      pending,
    };
  };

  const actions = {
    select(step) {
      if (step !== -1 && step !== 1) throw new Error(`step must be -1 or 1, not ${step}`);
      const ids = matching().map((p) => p.id);
      if (!ids.length) return;
      const at = ids.indexOf(selected);
      selected = ids[(at < 0 ? 0 : at + step + ids.length) % ids.length];
      render();
    },
    search(query) {
      if (typeof query !== 'string') throw new Error('query must be a string');
      search.value = query;
      // default: a changed search keeps the selection only while the selected row still matches.
      render();
    },
    escape() { if (search.value !== '') actions.search(''); },
    // default: opening without an id opens the selected row.
    open: (id) => { const target = id ?? selected; if (target === null) throw new Error('there is no row to open'); return perform(() => projects.activate(target)); },
    // default: without an id the selected row is the row of the answer (docs/spec/projects.md#project-home).
    confirm(id, answer) {
      if (!['ask', 'no', 'yes'].includes(answer)) throw new Error(`unknown answer ${answer}`);
      const target = id ?? selected;
      if (target === null) throw new Error('there is no row to confirm');
      if (answer === 'yes') return actions.remove(target);
      confirming = answer === 'ask' ? target : null;
      render();
    },
    // Removes the record and its spaces from the registry; the folder is not changed (docs/spec/projects.md#project-home).
    remove: (id) => perform(() => projects.close(id)),
    pin: (id) => { const project = projects.all().find((p) => p.id === id); if (!project) throw new Error(`unknown project ${id}`); return perform(() => projects.pin(id, !project.pinned)); },
    openForm(mode, parent) {
      if (mode === 'create' && !windows.createsFolders) throw new Error('this application cannot create folders');
      if (mode !== 'create' && mode !== 'open') throw new Error(`unknown form mode ${mode}`);
      // default: a form without a parent has no parent folder.
      formMode = mode; formPath = parent ?? null; form.hidden = false; form.dataset.mode = '';
      errors.withdraw('home');
      render();
    },
    cancelForm() { if (form.hidden) throw new Error('the form is not open'); form.hidden = true; formMode = null; form.dataset.mode = ''; form.innerHTML = ''; render(); },
    setField(name, value) { formField(name).value = value; },
    chooseFolder() { formField('parent'); return perform(async () => { const path = await windows.chooseFolder(); if (path) formField('parent').value = path; }); },
    submitForm() {
      if (form.hidden) throw new Error('the form is not open');
      return perform(async () => {
        let target = formField('parent').value.trim();
        if (formMode === 'create') target = (await windows.createFolder({ parent: target, name: formField('name').value.trim() })).root;
        // default: if every color is already in use, the first color is used again.
        await projects.open({ root: target, color: TINTS.find((t) => !projects.all().some((p) => p.color === t)) ?? TINTS[0], layout: fresh() });
        form.hidden = true; formMode = null; form.dataset.mode = ''; form.innerHTML = '';
      });
    },
  };

  // The keys of the home run declared commands; the search field keeps its own text editing keys.
  root.addEventListener('keydown', (event) => {
    const inForm = !form.hidden && form.contains(event.target);
    if (inForm) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); run('core.home.select', { step: event.key === 'ArrowDown' ? 1 : -1 }); }
    else if (event.key === 'Enter' && selected !== null) { event.preventDefault(); run('core.home.open', {}); }
    else if (event.key === 'Escape' && search.value !== '') { event.preventDefault(); run('core.home.search', { query: '' }); }
  });
  delegate(root);
  form.hidden = true;
  return { render, state, actions, refreshFolders: () => { foldersFor = null; }, idle: () => Promise.resolve() };
}
