// Project list and the create/open screen. The content webview and the shell are created when a project is opened.
import * as projects from "./projects.js";
import { fresh } from "./plane.js";
import { windows } from "@soksak/runtime";
import { icon } from "./icons.js";
import { preview } from "./library-preview.js";
import { delegate, mark } from "./commands.js";
import { contributionsState, onContributionsChange } from "./contributions.js";
import { appUpdate, onPluginOperations, pluginOperations } from "./installed-plugins.js";
import { matchPlugins } from "./plugin-search.js";
import { hasUpdate } from "./plugin-operations.js";
import { hideError, showError } from "./shown-errors.js";

const TINTS = ["#ffb36b", "#7fe3b0", "#7db4ff", "#e08bd8", "#f2d16b"];
const element = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/**
 * Creates the library screen. rendered is called when the screen is drawn again or
 * a form is opened or closed.
 */
/* Folder error messages of the host (workspace.folder.messages in docs/spec/host-contract.md) and the reason shown on the card. The card shows the path
   on the line directly above, so the reason does not contain the path. */
const FOLDER_REASONS = [
  ['project directory does not exist: ', '폴더가 없습니다.'],
  ['project directory is not readable: ', '폴더를 읽을 권한이 없습니다.'],
  ['not a project directory: ', '폴더가 아니라 파일입니다.'],
];

/** Converts a folder error message to the reason of the card. A message that is not in the contract is shown unchanged. */
function folderReason(message) {
  const known = FOLDER_REASONS.find(([prefix]) => message.startsWith(prefix));
  return known ? known[1] : `폴더를 확인할 수 없습니다: ${message}`;
}

/* The two pages of the library (Plugin screen in docs/spec/installation.md). */
const PAGES = [['projects', '프로젝트'], ['plugins', '플러그인']];

/** Status text of a plugin card. */
const PLUGIN_STATES = { loaded: '사용 중', disabled: '사용 안 함', available: '설치 안 됨', reload: '창을 다시 불러오면 적용' };
// The states of contributions to extension points (docs/spec/plugins.md#extension-points); invalid shows through the error display.
const CONTRIBUTION_STATES = { connected: '연결됨', 'provider-missing': '제공자 없음', 'version-mismatch': 'version 불일치', invalid: '오류' };

/** Sidecar line. It shows the installed version if there is one, otherwise the declared range. */
function sidecarLine(sidecars) {
  if (!sidecars.length) return '사이드카 없음';
  // default: a sidecar whose version and range are unknown (a window without a host) shows only its name.
  return `사이드카 ${sidecars.map((item) => [item.name, item.version ?? item.range].filter(Boolean).join(' ')).join(', ')}`;
}

export function createLibrary(root, rendered = () => {}) {
  root.innerHTML = `
    <main class="library-main">
      <header class="library-heading">
        <nav class="library-pages" aria-label="라이브러리 페이지"></nav>
        <label class="select-field library-sort"><select aria-label="프로젝트 정렬" data-expose="core.library.sort" data-command="core.library.sort" data-value="order"><option value="saved">저장 순서</option><option value="name">이름</option><option value="recent">최근</option><option value="open">열림</option></select></label>
        <label class="library-search"><span class="sr-only">프로젝트 검색</span><input class="text-field" type="search" data-expose="core.library.search" data-command="core.library.search" data-value="query" data-live placeholder="이름 또는 폴더 검색" autocomplete="off"></label>
        <label class="library-search library-plugin-search"><span class="sr-only">플러그인 검색</span><input class="text-field" type="search" data-expose="core.library.plugins.search" data-command="core.library.plugins.search" data-value="query" data-live placeholder="이름, id, 설명 검색" autocomplete="off"></label>
      </header>
      <div class="library-error" role="alert" hidden></div>
      <div class="library-form" hidden></div>
      <div class="library-empty" data-expose="core.library.empty" hidden><h2>프로젝트를 시작하세요</h2><p>새 프로젝트를 만들거나 기존 폴더를 여세요.</p></div>
      <div class="library-grid" role="list"></div>
      <div class="library-plugins" role="list"></div>
    </main>
    <footer class="library-footer"><span class="library-count"></span><button type="button" class="library-return" data-expose="core.library.return" data-command="core.library.return" hidden>작업 화면으로 돌아가기</button><button type="button" data-action="window" data-expose="core.library.window" data-command="core.library.window">＋ 새 창</button></footer>`;
  const grid = root.querySelector('.library-grid');
  // For each project id, its card and the value that built the card. If the value is the same, render does not rebuild the card.
  const cards = new Map();
  // For each plugin id, its card and the value that built the card, and the failure text above the list.
  const pluginCards = new Map();
  const outdatedRows = new Map();
  const updateList = { key: null, node: null };
  const failureLine = { key: null, node: null };
  const noPlugins = element('p', 'library-plugins-none', '찾는 플러그인이 없습니다.');
  const add=element('button','library-add','＋ 프로젝트 만들기');add.type='button';add.dataset.action='create';add.dataset.expose='core.library.add';
  mark(add,'core.library.form.open');
  const noResults=element('p','library-no-results','일치하는 프로젝트가 없습니다.'); noResults.dataset.expose='core.library.no-results';
  const search = root.querySelector('[data-expose="core.library.search"]');
  const sort = root.querySelector('select');
  const pages = root.querySelector('.library-pages');
  const pluginSearch = root.querySelector('[data-expose="core.library.plugins.search"]');
  const pluginList = root.querySelector('.library-plugins');
  /* Visible page and plugin search term. They are kept while the work screen is shown. */
  let page = 'projects';
  let pluginQuery = '';
  for (const [id, label] of PAGES) {
    const tab = element('button', 'library-page', label); tab.type = 'button'; tab.dataset.expose = 'core.library.page';
    mark(tab, 'core.library.page', { page: id });
    pages.append(tab);
  }
  const form = root.querySelector('.library-form');
  const error = root.querySelector('.library-error');
  const back = root.querySelector('.library-return');
  let pending = false;

  // default: a rejection value may not be an Error, so the value itself is shown.
  const fail = (reason) => showError(error, 'library', String(reason.message ?? reason));
  async function perform(work) {
    if (pending) return;
    pending = true; error.hidden = true; hideError(error, 'library');
    root.setAttribute('aria-busy', 'true');
    try { await work(); } catch (reason) { fail(reason); }
    finally { pending = false; root.removeAttribute('aria-busy'); render(); }
  }
  function record(root) {
    // default: if every color is already in use, the first color is used again.
    return projects.open({ root, color:TINTS.find(t=>!projects.all().some(p=>p.color===t)) ?? TINTS[0], layout:fresh() });
  }
  let formMode = null;
  function showForm(mode = windows.createsFolders ? 'create' : 'open') {
    if (mode === 'create' && !windows.createsFolders) throw new Error('this application cannot create folders');
    if (mode !== 'create' && mode !== 'open') throw new Error(`unknown form mode ${mode}`);
    formMode = mode;
    error.hidden = true;
    form.hidden = false;
    form.innerHTML = '';
    const creates = mode === 'create';
    const heading = element('h2', '', creates?'새 폴더로 프로젝트 만들기':'기존 폴더로 프로젝트 만들기');
    const fields = element('form', 'library-fields');
    // Shows both paths side by side so the user chooses at once whether to create a new folder or use an existing folder.
    const toggle=element('div','library-form__toggle');
    const newFolder=element('button','ui-button',creates?'● 새 폴더 만들기':'○ 새 폴더 만들기');
    newFolder.type='button'; newFolder.dataset.expose='core.library.form.mode-new';
    mark(newFolder,'core.library.form.open',{mode:'create'});
    const existingFolder=element('button','ui-button',creates?'○ 기존 폴더 선택':'● 기존 폴더 선택');
    existingFolder.type='button'; existingFolder.dataset.expose='core.library.form.mode-existing';
    mark(existingFolder,'core.library.form.open',{mode:'open'});
    toggle.append(newFolder,existingFolder);
    function field(name, title, placeholder, expose) {
      const label=element('label','',title), input=element('input','text-field');
      input.name=name; input.dataset.expose=expose; input.placeholder=placeholder; input.required=true; input.autocomplete='off';
      mark(input,'core.library.form.set',{field:name}); input.dataset.live='';
      label.append(input); fields.append(label); return input;
    }
    const name=creates?field('name','프로젝트 폴더 이름','my-project','core.library.form.name'):null;
    const parent=field('parent',creates?'생성 위치':'폴더 경로','/Users/…','core.library.form.parent');
    // In both modes the path can be chosen with the native picker.
    const choose=element('button','ui-button','폴더 선택'); choose.type='button'; choose.dataset.expose='core.library.form.choose';
    mark(choose,'core.library.choose-folder');
    parent.parentElement.append(choose);
    const actions=element('div','library-form__actions');
    const cancel=element('button','ui-button','취소'); cancel.type='button'; cancel.dataset.expose='core.library.form.cancel'; mark(cancel,'core.library.form.cancel');
    const submit=element('button','ui-button library-primary',creates?'생성 후 열기':'프로젝트로 열기'); submit.type='button'; submit.dataset.expose='core.library.form.submit'; mark(submit,'core.library.form.submit');
    actions.append(cancel,submit); fields.append(actions); form.append(heading,toggle,fields);
    // Enter runs the submit command. The default submission of the form is not used.
    fields.addEventListener('keydown',(event)=>{ if(event.key==='Enter'){ event.preventDefault(); submit.click(); } });
    fields.querySelector('input').focus();
    rendered();
  }
  function formField(name) {
    const input = form.querySelector(`input[name="${name}"]`);
    if (form.hidden || !input) throw new Error(`the form has no ${name} field`);
    return input;
  }
  function closeForm() { form.hidden = true; formMode = null; rendered(); }
  async function submitForm() {
    if (form.hidden) throw new Error('the form is not open');
    await perform(async()=>{
      let target=formField('parent').value.trim();
      if(formMode==='create') target=(await windows.createFolder({parent:target,name:formField('name').value.trim()})).root;
      await record(target); form.hidden=true; formMode=null;
    });
  }
  delegate(root);

  /* Whether the project folder can be read. It asks the host once for each path and asks again when the project list changes. If the folder cannot be read,
     it holds the reason that the host reported (docs/spec/projects.md). */
  const folders=new Map();
  let foldersFor=null;
  function checkFolders(all) {
    const roots=all.map(p=>p.root).join('\n');
    if(foldersFor!==roots) { folders.clear(); foldersFor=roots; }
    for(const project of all) {
      if(folders.has(project.root)) continue;
      folders.set(project.root, {pending:true});
      windows.folder(project.root).then(
        ()=>{ folders.set(project.root,{error:null}); },
        (reason)=>{ folders.set(project.root,{error:String(reason.message)}); },
      ).then(()=>{ if(foldersFor===roots) render(); });
    }
  }
  /** The project list changed. Checks the folders again. */
  function refreshFolders() { foldersFor=null; }

  /** Only the tab of the visible page and the elements of that page are shown. */
  function showPage() {
    for (const tab of pages.children) {
      const on = JSON.parse(tab.dataset.params).page === page;
      tab.dataset.on = String(on); tab.setAttribute('aria-pressed', String(on));
    }
    const plugins = page === 'plugins';
    for (const el of [sort.parentElement, search.parentElement, grid]) el.hidden = plugins;
    if (plugins) { error.hidden = true; form.hidden = true; formMode = null; root.querySelector('.library-empty').hidden = true; }
    pluginSearch.parentElement.hidden = !plugins;
    pluginList.hidden = !plugins;
  }

  /** One plugin card: name, id, status, description, version, sidecar, action buttons, and the last action text of that plugin. */
  function pluginCard(row, status) {
    const card = element('article', 'library-plugin'); card.dataset.pluginId = row.id; card.setAttribute('role', 'listitem');
    card.dataset.state = row.state;
    const head = element('div', 'library-plugin__head');
    head.append(element('h2', '', row.name), element('span', 'library-plugin__state', PLUGIN_STATES[row.state]));
    card.append(head, element('p', 'library-plugin__id', row.id));
    if (row.description) card.append(element('p', 'library-plugin__about', row.description));
    const versions = [
      row.installed ? `설치된 버전 ${row.installed.version}` : null,
      row.latest ? `최신 버전 ${row.latest}` : null,
    ].filter(Boolean).join(' · ');
    if (versions) card.append(element('p', 'library-plugin__versions', versions));
    card.append(element('p', 'library-plugin__sidecars', sidecarLine(row.sidecars)));
    for (const entry of contributionsState().filter((item) => item.plugin === row.id)) {
      const where = `library plugin ${row.id} contribution ${entry.point} ${entry.index + 1}`;
      const line = element('p', 'library-plugin__contribution', `${entry.point} 기여 ${entry.index + 1}: ${CONTRIBUTION_STATES[entry.state]}`);
      line.dataset.state = entry.state;
      card.append(line);
      if (entry.state === 'invalid') showError(line, where, `${entry.point} 기여 ${entry.index + 1}: ${entry.reason}`);
      else hideError(line, where);
    }
    if (pluginOperations.hosted) {
      const actions = element('div', 'library-plugin__actions');
      // core.plugins.apply reloads the window for every changed plugin, so it takes no plugin.
      const action = (label, name, params = { plugin: row.id }) => {
        const button = element('button', 'ui-button', label); button.type = 'button'; button.dataset.expose = 'core.library.plugins.action'; button.dataset.action = name;
        mark(button, `core.plugins.${name}`, params);
        // While an action runs, no other action starts.
        button.disabled = status.operation?.state === 'running';
        actions.append(button);
      };
      if (!row.installed && row.latest) action('설치', 'install');
      if (hasUpdate(row)) action('업데이트', 'update');
      if (row.state === 'reload') action('적용', 'apply', {});
      if (row.installed) action(row.installed.enabled ? '사용 안 함' : '사용', row.installed.enabled ? 'disable' : 'enable');
      if (row.installed) action('제거', 'remove');
      if (actions.children.length) card.append(actions);
    }
    const operation = status.operation;
    // A plugin operation that succeeds reloads the window, so a done operation shows no line.
    if (operation && operation.plugin === row.id && operation.state !== 'done') {
      const line = element('p', 'library-plugin__operation', operation.state === 'running' ? `${row.id} ${operation.action} 진행 중${operation.step ? ` · ${operation.step.application} ${operation.step.step}${operation.step.ok ? '' : ' 실패'}` : ''}` : '');
      line.dataset.state = operation.state;
      card.append(line);
      if (operation.state === 'failed') showError(line, `library plugin ${row.id}`, operation.error);
      else hideError(line, `library plugin ${row.id}`);
    }
    return card;
  }

  /** The row of the core update: the versions, the release page, the action, and the step or error of the operation. */
  function coreUpdateRow(app) {
    const row = element('div', 'library-app-update');
    row.dataset.expose = 'core.library.app.row';
    row.append(element('p', 'library-updates__row', `core: ${app.version} → ${app.available.version}`));
    if (app.available.release) {
      const release = element('button', 'ui-button', '릴리스 페이지'); release.type = 'button';
      release.dataset.expose = 'core.library.app.release';
      mark(release, 'core.app.release');
      row.append(release);
    }
    const update = element('button', 'ui-button', '업데이트'); update.type = 'button';
    update.dataset.expose = 'core.library.app.update';
    mark(update, 'core.app.update');
    row.append(update);
    for (const item of app.incompatible) {
      const line = element('p', 'library-app-update__incompatible',
        `${item.id} ${item.installed} (${item.range}): ${app.available.version}에 맞는 ${item.compatible ? `최신 버전 ${item.compatible}` : '버전 없음'}`);
      line.dataset.expose = 'core.library.app.incompatible';
      row.append(line);
    }
    const operation = app.operation;
    if (operation) {
      const line = element('p', 'library-app-update__operation');
      line.dataset.expose = 'core.library.app.operation';
      if (operation.state === 'failed') {
        line.setAttribute('role', 'alert');
        showError(line, 'library app update', `${operation.version} 업데이트하지 못했습니다: ${operation.error}`);
      } else {
        line.textContent = `${operation.version} ${operation.state === 'staging' ? '받는 중' : '적용하는 중'}`;
      }
      row.append(line);
    }
    return row;
  }

  /** Plugin page: the text for a status that could not be read and the plugin cards that match the search term. */
  function renderPlugins() {
    if (pluginSearch.value !== pluginQuery) pluginSearch.value = pluginQuery;
    const status = pluginOperations.status();
    const failure = pluginOperations.failure();
    // A plugin card that did not change stays in the document (same reason as the project cards in render).
    const wanted = [];
    if (failure) {
      const key = JSON.stringify(failure);
      if (failureLine.key !== key) {
        failureLine.key = key;
        failureLine.node = element('p', 'library-plugins-error');
        failureLine.node.dataset.kind = failure.kind; failureLine.node.setAttribute('role', 'alert');
        showError(failureLine.node, 'library plugins', failure.kind === 'index'
          ? `레지스트리를 읽지 못했습니다: ${failure.message}` : `플러그인 상태를 읽지 못했습니다: ${failure.message}`);
      }
      wanted.push(failureLine.node);
    } else {
      failureLine.key = null;
      hideError(null, 'library plugins');
    }
    // The plugins that the registry lists in a newer version, with the action that updates all of them.
    const app = appUpdate.status();
    if (app.operation?.state !== 'failed') hideError(null, 'library app update');
    if (pluginOperations.hosted && (status.updates.length || app.available)) {
      const key = JSON.stringify([app, status.updates]);
      if (updateList.key !== key) {
        updateList.key = key;
        const node = element('div', 'library-updates');
        if (app.available) node.append(coreUpdateRow(app));
        for (const update of status.updates) {
          const row = element('p', 'library-updates__row', `${update.id}: ${update.installed} → ${update.latest}`);
          row.dataset.expose = 'core.library.plugins.updates'; row.dataset.plugin = update.id;
          node.append(row);
        }
        if (status.updates.length) {
          const all = element('button', 'ui-button', '모두 업데이트'); all.type = 'button';
          all.dataset.expose = 'core.library.plugins.update-all';
          mark(all, 'core.plugins.update-all');
          node.append(all);
        }
        updateList.node = node;
      }
      wanted.push(updateList.node);
    } else {
      updateList.key = null;
    }
    // An outdated persistent service stays until its sessions end; the action ends them and replaces the service.
    if (pluginOperations.hosted) {
      for (const item of status.outdated) {
        const key = JSON.stringify(item);
        const kept = outdatedRows.get(item.sidecar);
        if (kept?.key === key) { wanted.push(kept.node); continue; }
        const node = element('div', 'library-outdated');
        node.dataset.expose = 'core.library.plugins.outdated'; node.dataset.sidecar = item.sidecar;
        // A service that sent no version is of an earlier version.
        const running = item.running === null ? '이전 버전' : item.running;
        node.append(element('p', 'library-outdated__text', `${item.sidecar}: ${running} → ${item.installed}`));
        const button = element('button', 'ui-button', `터미널 ${item.sessions}개를 끝내고 적용`); button.type = 'button';
        button.dataset.expose = 'core.library.plugins.replace';
        mark(button, 'core.plugins.replace', { sidecar: item.sidecar });
        node.append(button);
        outdatedRows.set(item.sidecar, { key, node });
        wanted.push(node);
      }
      for (const name of [...outdatedRows.keys()]) if (!status.outdated.some((item) => item.sidecar === name)) outdatedRows.delete(name);
    }
    const rows = matchPlugins(status.plugins, pluginQuery);
    const running = status.operation?.state === 'running';
    for (const row of rows) {
      const operation = status.operation?.plugin === row.id ? status.operation : null;
      const key = JSON.stringify([row, pluginOperations.hosted, running, operation, contributionsState().filter((item) => item.plugin === row.id)]);
      const kept = pluginCards.get(row.id);
      if (kept?.key === key) { wanted.push(kept.card); continue; }
      const card = pluginCard(row, status);
      pluginCards.set(row.id, { key, card });
      wanted.push(card);
    }
    for (const id of [...pluginCards.keys()]) if (!rows.some((row) => row.id === id)) pluginCards.delete(id);
    // If the status cannot be read, there is no card and the reason is shown in the text above.
    if (!rows.length && failure?.kind !== 'state') wanted.push(noPlugins);
    place(pluginList, wanted);
  }

  /** Card of one project. folder is the result of reading its folder. */
  function projectCard(project, folder) {
      const card=element('article','library-project'); card.dataset.projectId=project.id; card.setAttribute('role','listitem');
      card.dataset.open=String(projects.isOpen(project.id));
      const choose=element('button','library-project__open'); choose.type='button'; choose.title=project.root; choose.dataset.expose='core.library.open';
      choose.setAttribute('aria-label',`${project.title} 열기`);
      mark(choose,'core.library.open',{id:project.id});
      choose.append(preview(project));
      const text=element('div','library-project__text');
      text.append(element('h2','',project.title),element('p','library-project__path',project.root));
      const meta=element('p','library-project__meta',`스페이스 ${project.spaces.length}`);
      if(projects.isOpen(project.id)) meta.append(element('span','library-open','열림'));
      if(project.lastOpened) {
        const time=element('time','',new Intl.DateTimeFormat('ko',{month:'short',day:'numeric'}).format(project.lastOpened));
        time.dateTime=new Date(project.lastOpened).toISOString(); time.title=new Date(project.lastOpened).toLocaleString('ko'); meta.append(time);
      }
      text.append(meta);
      // A project whose folder cannot be read shows the reason before it is opened.
      if(folder?.error) {
        // The card of a folder that cannot be opened cannot be pressed. The reason is shown on the card, and the remove button deletes the record.
        choose.disabled=true;
        card.dataset.folderError=folder.error;
        const missing=element('p','library-project__missing');
        text.append(missing);
        showError(missing, `library project ${project.root}`, folderReason(folder.error));
      } else {
        hideError(null, `library project ${project.root}`);
      }
      choose.append(text);
      const pin=element('button','act library-project__pin');pin.type='button';pin.dataset.expose='core.library.pin';pin.innerHTML=icon('star');
      pin.title=project.pinned?'고정 해제':'프로젝트 고정';pin.setAttribute('aria-pressed',String(Boolean(project.pinned)));
      mark(pin,'core.library.pin',{id:project.id,pinned:!project.pinned});
      const remove=element('button','act library-project__remove');remove.type='button';remove.dataset.expose='core.library.remove';remove.innerHTML=icon('close');
      remove.title='라이브러리에서 제거';remove.setAttribute('aria-label',`${project.title} 라이브러리에서 제거`);
      mark(remove,'core.library.remove',{id:project.id});
      const actions=element('div','library-project__actions'); actions.append(remove,pin);
      card.append(choose,actions);
    return card;
  }

  /** Arranges the children of parent in the order of nodes. An element already in place is not moved, and a child that is not in nodes is removed. */
  function place(parent, nodes) {
    const keep=new Set(nodes);
    for(const child of [...parent.children]) if(!keep.has(child)) child.remove();
    // default: if index equals the number of children, that position is the end, so null inserts at the end.
    nodes.forEach((node, index)=>{ if(parent.children[index]!==node) parent.insertBefore(node, parent.children[index] ?? null); });
  }

  function render() {
    if (!projects.inLibrary()) return;
    const all=projects.all(), open=all.filter(p=>projects.isOpen(p.id));
    checkFolders(all);
    root.querySelector('.library-count').textContent=`프로젝트 ${all.length} · 열림 ${open.length}`;
    back.hidden=!projects.active();
    showPage();
    if (page === 'plugins') {
      place(grid, []);
      cards.clear();
      renderPlugins();
      rendered();
      return;
    }
    place(pluginList, []);
    pluginCards.clear();
    const query=search.value.trim().toLocaleLowerCase();
    const shown=all.filter(p=>`${p.title} ${p.root}`.toLocaleLowerCase().includes(query));
    if(sort.value==='name') shown.sort((a,b)=>a.title.localeCompare(b.title));
    // default: a project that was never opened has no lastOpened, so it sorts as the oldest.
    if(sort.value==='recent') shown.sort((a,b)=>(b.lastOpened??0)-(a.lastOpened??0));
    if(sort.value==='open') shown.sort((a,b)=>Number(projects.isOpen(b.id))-Number(projects.isOpen(a.id)));
    // A card that did not change and its controls stay in the document. Rebuilding them lets a redraw between press and release lose the
    // click (docs/spec/exposure.md). If the value that determines the card content is the same, the previous card is used and only misordered elements are moved.
    const wanted=[];
    for(const project of shown) {
      const folder=folders.get(project.root);
      // default: a folder that has not been read yet or was read without an error has no error, so the value is null.
      const key=JSON.stringify([project, projects.isOpen(project.id), folder?.error ?? null]);
      const kept=cards.get(project.id);
      if(kept?.key===key) {
        if(!folder?.error) hideError(null, `library project ${project.root}`);
        wanted.push(kept.card);
        continue;
      }
      const card=projectCard(project, folder);
      cards.set(project.id, {key, card});
      wanted.push(card);
    }
    for(const id of [...cards.keys()]) if(!shown.some((project)=>project.id===id)) cards.delete(id);
    if(!shown.length&&all.length) wanted.unshift(noResults);
    wanted.push(add);
    place(grid, wanted);
    const empty=root.querySelector('.library-empty');empty.hidden=all.length>0;
    rendered();
  }
  /** Screen state. The preview rectangle is relative to the viewport. */
  function state() {
    const previews={}, previewErrors={}, folderErrors={};
    for(const card of grid.querySelectorAll('.library-project')) {
      const failed=card.querySelector('.library-preview')?.dataset.previewError;
      if(failed!==undefined) previewErrors[card.dataset.projectId]=failed;
      if(card.dataset.folderError!==undefined) folderErrors[card.dataset.projectId]=card.dataset.folderError;
      previews[card.dataset.projectId]=[...card.querySelectorAll('.library-preview__pane')].map(pane=>{
        const r=pane.getBoundingClientRect();return {card:pane.dataset.cardId,x:r.x,y:r.y,w:r.width,h:r.height};
      });
    }
    // default: the folder name field exists only when a new folder is created, so the value of a missing field is null.
    const input=(name)=>form.querySelector(`input[name="${name}"]`)?.value ?? null;
    return {
      page,
      plugins:{query:pluginQuery, shown:[...pluginList.querySelectorAll('.library-plugin')].map(card=>card.dataset.pluginId),
        // Document order, the same as the sequence number of core.library.plugins.action.
        actions:[...pluginList.querySelectorAll('[data-expose="core.library.plugins.action"]')].map(button=>({
          plugin:button.closest('.library-plugin').dataset.pluginId, action:button.dataset.action, disabled:button.disabled,
        }))},
      shown:[...grid.querySelectorAll('.library-project')].map(card=>card.dataset.projectId),
      pinned:[...grid.querySelectorAll('.library-project')].filter(card=>card.querySelector('.library-project__pin').getAttribute('aria-pressed')==='true').map(card=>card.dataset.projectId),
      count:root.querySelector('.library-count').textContent,
      query:search.value, sort:sort.value, form:!form.hidden,
      formState:form.hidden?null:{mode:formMode,name:input('name'),parent:input('parent')},
      returnVisible:!back.hidden, pending, empty:!root.querySelector('.library-empty').hidden,
      noResults:Boolean(grid.querySelector('.library-no-results')),
      error:error.hidden?null:error.textContent, previews, previewErrors, folderErrors,
    };
  }
  const SORTS=['saved','name','recent','open'];
  /* Operations that the commands call. */
  const actions={
    page(next){
      if(!PAGES.some(([id])=>id===next)) throw new Error(`unknown library page ${next}`);
      page=next;
      // The plugin page reads the state of the host when it is shown. A read failure is reported as the error of the state.
      if(page==='plugins') { pluginOperations.refresh(); pluginOperations.refreshOutdated(); appUpdate.refresh(); }
      render();
    },
    /** Shows the plugin page with the update list at the top of the list. */
    showUpdates(){
      actions.page('plugins');
      updateList.node?.scrollIntoView({ block: 'start' });
    },
    searchPlugins(query){
      if(typeof query!=='string') throw new Error('query must be a string');
      pluginQuery=query; render();
    },
    search(query){ search.value=query; render(); },
    sort(order){ if(!SORTS.includes(order)) throw new Error(`unknown sort ${order}`); sort.value=order; render(); },
    open:(id)=>perform(()=>projects.activate(id)),
    pin:(id,pinned)=>perform(()=>projects.pin(id,pinned)),
    // Same operation as closing a project tab. It deletes only the record and the space and does not touch the folder.
    remove:(id)=>perform(()=>projects.close(id)),
    newWindow:()=>perform(()=>projects.newWindow()),
    back(){ if(back.hidden) throw new Error('there is no workspace to return to'); return perform(()=>projects.activate(projects.active().id)); },
    openForm:(mode)=>showForm(mode),
    cancelForm(){ if(form.hidden) throw new Error('the form is not open'); closeForm(); },
    setField(name,value){ formField(name).value=value; rendered(); },
    chooseFolder(){ formField('parent'); return perform(async()=>{ const path=await windows.chooseFolder(); if(path) formField('parent').value=path; }); },
    submitForm,
  };
  // The plugin page redraws the state that plugins-changed and each action changed.
  onPluginOperations(()=>{ if(page==='plugins') render(); });
  onContributionsChange(()=>{ if(page==='plugins') render(); });
  return {render, refreshFolders, state, actions};
}

