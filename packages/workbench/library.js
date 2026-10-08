// 프로젝트 목록과 생성·열기 화면. 콘텐츠 웹뷰와 셸은 프로젝트를 열 때 생성한다.
import * as projects from "./projects.js";
import { fresh } from "./plane.js";
import { windows } from "@soksak/runtime";
import { icon } from "./icons.js";
import { preview } from "./library-preview.js";
import { delegate, mark } from "./commands.js";
import { contributionsState, onContributionsChange } from "./contributions.js";
import { onPluginOperations, pluginOperations } from "./installed-plugins.js";
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
 * 라이브러리 화면을 만든다. rendered 는 화면을 다시 그리거나 양식을 열고 닫을 때
 * 호출된다.
 */
/* 호스트의 폴더 오류 문구(docs/spec/host-contract.md 의 workspace.folder.messages)와 카드에 보일 이유. 카드는 경로를
   바로 위 줄에 보이므로 이유에는 경로를 넣지 않는다. */
const FOLDER_REASONS = [
  ['project directory does not exist: ', '폴더가 없습니다.'],
  ['project directory is not readable: ', '폴더를 읽을 권한이 없습니다.'],
  ['not a project directory: ', '폴더가 아니라 파일입니다.'],
];

/** 폴더 오류 문구를 카드의 이유로 바꾼다. 계약에 없는 문구는 그대로 보인다. */
function folderReason(message) {
  const known = FOLDER_REASONS.find(([prefix]) => message.startsWith(prefix));
  return known ? known[1] : `폴더를 확인할 수 없습니다: ${message}`;
}

/* 라이브러리의 두 페이지(docs/spec/installation.md 의 Plugin screen). */
const PAGES = [['projects', '프로젝트'], ['plugins', '플러그인']];

/** 플러그인 카드의 상태 글. */
const PLUGIN_STATES = { loaded: '사용 중', disabled: '사용 안 함', available: '설치 안 됨', reload: '창을 다시 불러오면 적용' };
// The states of contributions to extension points (docs/spec/plugins.md#extension-points); invalid shows through the error display.
const CONTRIBUTION_STATES = { connected: '연결됨', 'provider-missing': '제공자 없음', 'version-mismatch': 'version 불일치', invalid: '오류' };

/** 사이드카 줄. 설치된 버전이 있으면 그 버전을, 없으면 선언한 범위를 보인다. */
function sidecarLine(sidecars) {
  if (!sidecars.length) return '사이드카 없음';
  // 기본값: 버전도 범위도 모르는 사이드카(host 가 없는 창)는 이름만 보인다.
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
  // 프로젝트 id 마다 그 카드와 카드를 만든 값이다. 같은 값이면 render 가 카드를 다시 만들지 않는다.
  const cards = new Map();
  // 플러그인 id 마다 그 카드와 카드를 만든 값, 그리고 목록 위의 실패 글이다.
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
  /* 보이는 페이지와 플러그인 검색어. 작업 화면을 보이는 동안에도 유지한다. */
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

  // 기본값: 거부 값은 Error 가 아닐 수 있으므로 그 값 자체를 보인다.
  const fail = (reason) => showError(error, 'library', String(reason.message ?? reason));
  async function perform(work) {
    if (pending) return;
    pending = true; error.hidden = true; hideError(error, 'library');
    root.setAttribute('aria-busy', 'true');
    try { await work(); } catch (reason) { fail(reason); }
    finally { pending = false; root.removeAttribute('aria-busy'); render(); }
  }
  function record(root) {
    // 기본값: 모든 색을 이미 쓰고 있으면 첫 색을 다시 쓴다.
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
    // 두 경로를 나란히 보여 사용자가 새 폴더를 만들지 이미 있는 폴더를 쓸지 바로 고른다.
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
    // 두 모드 모두 네이티브 선택기로 경로를 고를 수 있다.
    const choose=element('button','ui-button','폴더 선택'); choose.type='button'; choose.dataset.expose='core.library.form.choose';
    mark(choose,'core.library.choose-folder');
    parent.parentElement.append(choose);
    const actions=element('div','library-form__actions');
    const cancel=element('button','ui-button','취소'); cancel.type='button'; cancel.dataset.expose='core.library.form.cancel'; mark(cancel,'core.library.form.cancel');
    const submit=element('button','ui-button library-primary',creates?'생성 후 열기':'프로젝트로 열기'); submit.type='button'; submit.dataset.expose='core.library.form.submit'; mark(submit,'core.library.form.submit');
    actions.append(cancel,submit); fields.append(actions); form.append(heading,toggle,fields);
    // Enter 는 제출 명령을 실행한다. 폼의 기본 제출은 쓰지 않는다.
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

  /* 프로젝트 폴더를 읽을 수 있는지. 경로마다 호스트에 한 번 묻고, 프로젝트 목록이 바뀌면 다시 묻는다. 읽을 수 없으면
     호스트가 알린 이유를 담는다(docs/spec/projects.md). */
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
  /** 프로젝트 목록이 바뀌었다. 폴더를 다시 확인한다. */
  function refreshFolders() { foldersFor=null; }

  /** 보이는 페이지의 탭과 그 페이지의 요소만 보인다. */
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

  /** 플러그인 카드 하나. 이름, id, 상태, 설명, 버전, 사이드카, 작업 단추, 그 플러그인의 마지막 작업 글이다. */
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
        // 작업이 실행되는 동안에는 어느 작업도 시작하지 않는다.
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
      const line = element('p', 'library-plugin__operation', operation.state === 'running' ? `${row.id} ${operation.action} 진행 중` : '');
      line.dataset.state = operation.state;
      card.append(line);
      if (operation.state === 'failed') showError(line, `library plugin ${row.id}`, operation.error);
      else hideError(line, `library plugin ${row.id}`);
    }
    return card;
  }

  /** 플러그인 페이지. 상태를 읽지 못한 글과 검색어에 맞는 플러그인 카드다. */
  function renderPlugins() {
    if (pluginSearch.value !== pluginQuery) pluginSearch.value = pluginQuery;
    const status = pluginOperations.status();
    const failure = pluginOperations.failure();
    // 바뀌지 않은 플러그인 카드는 문서에 그대로 둔다(render 의 프로젝트 카드와 같은 까닭이다).
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
    if (pluginOperations.hosted && status.updates.length) {
      const key = JSON.stringify(status.updates);
      if (updateList.key !== key) {
        updateList.key = key;
        const node = element('div', 'library-updates');
        for (const update of status.updates) {
          const row = element('p', 'library-updates__row', `${update.id}: ${update.installed} → ${update.latest}`);
          row.dataset.expose = 'core.library.plugins.updates'; row.dataset.plugin = update.id;
          node.append(row);
        }
        const all = element('button', 'ui-button', '모두 업데이트'); all.type = 'button';
        all.dataset.expose = 'core.library.plugins.update-all';
        mark(all, 'core.plugins.update-all');
        node.append(all);
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
    // 상태를 읽지 못하면 카드가 없고 그 까닭은 위의 글이 보인다.
    if (!rows.length && failure?.kind !== 'state') wanted.push(noPlugins);
    place(pluginList, wanted);
  }

  /** 프로젝트 하나의 카드. folder 는 그 폴더를 읽은 결과다. */
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
      // 폴더를 읽을 수 없는 프로젝트는 열기 전에 그 까닭을 보인다.
      if(folder?.error) {
        // 열 수 없는 폴더의 카드는 누를 수 없다. 이유는 카드에 보이고, 기록은 제거 버튼으로 지운다.
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

  /** parent 의 자식을 nodes 의 순서로 맞춘다. 제자리에 있는 요소는 옮기지 않고, nodes 에 없는 자식은 뺀다. */
  function place(parent, nodes) {
    const keep=new Set(nodes);
    for(const child of [...parent.children]) if(!keep.has(child)) child.remove();
    // 기본값: index 가 자식 수와 같으면 그 자리가 끝이므로 null 로 끝에 넣는다.
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
    // 기본값: 한 번도 열지 않은 프로젝트는 lastOpened 가 없으므로 가장 오래된 것으로 정렬한다.
    if(sort.value==='recent') shown.sort((a,b)=>(b.lastOpened??0)-(a.lastOpened??0));
    if(sort.value==='open') shown.sort((a,b)=>Number(projects.isOpen(b.id))-Number(projects.isOpen(a.id)));
    // 바뀌지 않은 카드와 그 조작 요소는 문서에 그대로 둔다. 다시 만들면 누름과 뗌 사이의 다시 그리기가 click 을
    // 잃는다(docs/spec/exposure.md). 카드의 내용을 정하는 값이 같으면 이전 카드를 쓰고, 순서가 틀린 요소만 옮긴다.
    const wanted=[];
    for(const project of shown) {
      const folder=folders.get(project.root);
      // 기본값: 아직 읽지 않았거나 읽은 폴더에는 오류가 없으므로 그 값은 null 이다.
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
  /** 화면의 상태. 미리보기 사각형은 뷰포트 기준이다. */
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
    // 기본값: 폴더 이름 칸은 새 폴더를 만들 때만 있으므로 없는 칸의 값은 null 이다.
    const input=(name)=>form.querySelector(`input[name="${name}"]`)?.value ?? null;
    return {
      page,
      plugins:{query:pluginQuery, shown:[...pluginList.querySelectorAll('.library-plugin')].map(card=>card.dataset.pluginId),
        // core.library.plugins.action 의 순번과 같은 문서 순서다.
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
  /* 명령이 부르는 연산. */
  const actions={
    page(next){
      if(!PAGES.some(([id])=>id===next)) throw new Error(`unknown library page ${next}`);
      page=next;
      // 플러그인 페이지는 보일 때 host 의 상태를 읽는다. 읽기 실패는 상태의 error 로 보고된다.
      if(page==='plugins') { pluginOperations.refresh(); pluginOperations.refreshOutdated(); }
      render();
    },
    searchPlugins(query){
      if(typeof query!=='string') throw new Error('query must be a string');
      pluginQuery=query; render();
    },
    search(query){ search.value=query; render(); },
    sort(order){ if(!SORTS.includes(order)) throw new Error(`unknown sort ${order}`); sort.value=order; render(); },
    open:(id)=>perform(()=>projects.activate(id)),
    pin:(id,pinned)=>perform(()=>projects.pin(id,pinned)),
    // 프로젝트 탭의 닫기와 같은 연산이다. 기록과 스페이스만 지우고 폴더는 건드리지 않는다.
    remove:(id)=>perform(()=>projects.close(id)),
    newWindow:()=>perform(()=>projects.newWindow()),
    back(){ if(back.hidden) throw new Error('there is no workspace to return to'); return perform(()=>projects.activate(projects.active().id)); },
    openForm:(mode)=>showForm(mode),
    cancelForm(){ if(form.hidden) throw new Error('the form is not open'); closeForm(); },
    setField(name,value){ formField(name).value=value; rendered(); },
    chooseFolder(){ formField('parent'); return perform(async()=>{ const path=await windows.chooseFolder(); if(path) formField('parent').value=path; }); },
    submitForm,
  };
  // 플러그인 페이지는 plugins-changed 와 작업마다 바뀐 상태를 다시 그린다.
  onPluginOperations(()=>{ if(page==='plugins') render(); });
  onContributionsChange(()=>{ if(page==='plugins') render(); });
  return {render, refreshFolders, state, actions};
}

