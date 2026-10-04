// 프로젝트 목록과 생성·열기 화면. 콘텐츠 웹뷰와 셸은 프로젝트를 열 때 생성한다.
import * as projects from "./projects.js";
import { fresh } from "./plane.js";
import { windows } from "@soksak/runtime";
import { icon } from "./icons.js";
import { preview } from "./library-preview.js";
import { delegate, mark } from "./commands.js";
import { onPluginOperations, pluginOperations } from "./installed-plugins.js";
import { matchPlugins } from "./plugin-search.js";
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
const PLUGIN_STATES = { loaded: '사용 중', disabled: '사용 안 함', available: '설치 안 됨', restart: '다시 시작하면 적용' };

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
    if (pluginOperations.hosted) {
      const actions = element('div', 'library-plugin__actions');
      const action = (label, name) => {
        const button = element('button', 'ui-button', label); button.type = 'button'; button.dataset.expose = 'core.library.plugins.action'; button.dataset.action = name;
        mark(button, `core.plugins.${name}`, { plugin: row.id });
        // 작업이 실행되는 동안에는 어느 작업도 시작하지 않는다.
        button.disabled = status.operation?.state === 'running';
        actions.append(button);
      };
      if (!row.installed && row.latest) action('설치', 'install');
      if (row.installed && row.latest) action('업데이트', 'update');
      if (row.installed) action(row.installed.enabled ? '사용 안 함' : '사용', row.installed.enabled ? 'disable' : 'enable');
      if (row.installed) action('제거', 'remove');
      if (actions.children.length) card.append(actions);
    }
    const operation = status.operation;
    if (operation && operation.plugin === row.id) {
      const line = element('p', 'library-plugin__operation', operation.state === 'running' ? `${row.id} ${operation.action} 진행 중`
        : operation.state === 'done' ? '애플리케이션을 다시 시작하면 적용됩니다.' : '');
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
    pluginList.replaceChildren();
    if (failure) {
      const line = element('p', 'library-plugins-error');
      line.dataset.kind = failure.kind; line.setAttribute('role', 'alert');
      pluginList.append(line);
      showError(line, 'library plugins', failure.kind === 'index'
        ? `레지스트리를 읽지 못했습니다: ${failure.message}` : `플러그인 상태를 읽지 못했습니다: ${failure.message}`);
    } else {
      hideError(null, 'library plugins');
    }
    const rows = matchPlugins(status.plugins, pluginQuery);
    for (const row of rows) pluginList.append(pluginCard(row, status));
    // 상태를 읽지 못하면 카드가 없고 그 까닭은 위의 글이 보인다.
    if (!rows.length && failure?.kind !== 'state') pluginList.append(element('p', 'library-plugins-none', '찾는 플러그인이 없습니다.'));
  }

  function render() {
    if (!projects.inLibrary()) return;
    const all=projects.all(), open=all.filter(p=>projects.isOpen(p.id));
    checkFolders(all);
    root.querySelector('.library-count').textContent=`프로젝트 ${all.length} · 열림 ${open.length}`;
    back.hidden=!projects.active();
    showPage();
    if (page === 'plugins') {
      grid.replaceChildren();
      renderPlugins();
      rendered();
      return;
    }
    pluginList.replaceChildren();
    const query=search.value.trim().toLocaleLowerCase();
    const shown=all.filter(p=>`${p.title} ${p.root}`.toLocaleLowerCase().includes(query));
    if(sort.value==='name') shown.sort((a,b)=>a.title.localeCompare(b.title));
    // 기본값: 한 번도 열지 않은 프로젝트는 lastOpened 가 없으므로 가장 오래된 것으로 정렬한다.
    if(sort.value==='recent') shown.sort((a,b)=>(b.lastOpened??0)-(a.lastOpened??0));
    if(sort.value==='open') shown.sort((a,b)=>Number(projects.isOpen(b.id))-Number(projects.isOpen(a.id)));
    grid.replaceChildren();
    for(const project of shown) {
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
      const folder=folders.get(project.root);
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
      card.append(choose,actions); grid.append(card);
    }
    const add=element('button','library-add','＋ 프로젝트 만들기');add.type='button';add.dataset.action='create';add.dataset.expose='core.library.add';
    mark(add,'core.library.form.open');grid.append(add);
    const empty=root.querySelector('.library-empty');empty.hidden=all.length>0;
    if(!shown.length&&all.length) {
      const none=element('p','library-no-results','일치하는 프로젝트가 없습니다.'); none.dataset.expose='core.library.no-results'; grid.prepend(none);
    }
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
      if(page==='plugins') pluginOperations.refresh();
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
  return {render, refreshFolders, state, actions};
}

