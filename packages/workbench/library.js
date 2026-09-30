// 프로젝트 목록과 생성·열기 화면. 콘텐츠 웹뷰와 셸은 프로젝트를 열 때 생성한다.
import * as projects from "./projects.js";
import { fresh } from "./plane.js";
import { windows } from "@soksak/runtime";
import { icon } from "./icons.js";
import { hasPlugin, isPlace, plugin } from "./registry.js";
import { delegate, mark } from "./commands.js";

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
export function createLibrary(root, rendered = () => {}) {
  root.innerHTML = `
    <main class="library-main">
      <header class="library-heading">
        <h1>프로젝트</h1>
        <label class="select-field library-sort"><select aria-label="프로젝트 정렬" data-expose="core.library.sort" data-command="core.library.sort" data-value="order"><option value="saved">저장 순서</option><option value="name">이름</option><option value="recent">최근</option><option value="open">열림</option></select></label>
        <label class="library-search"><span class="sr-only">프로젝트 검색</span><input class="text-field" type="search" data-expose="core.library.search" data-command="core.library.search" data-value="query" data-live placeholder="이름 또는 폴더 검색" autocomplete="off"></label>
      </header>
      <div class="library-error" role="alert" hidden></div>
      <div class="library-form" hidden></div>
      <div class="library-empty" data-expose="core.library.empty" hidden><h2>프로젝트를 시작하세요</h2><p>새 프로젝트를 만들거나 기존 폴더를 여세요.</p></div>
      <div class="library-grid" role="list"></div>
    </main>
    <footer class="library-footer"><span class="library-count"></span><button type="button" class="library-return" data-expose="core.library.return" data-command="core.library.return" hidden>작업 화면으로 돌아가기</button><button type="button" data-action="window" data-expose="core.library.window" data-command="core.library.window">＋ 새 창</button></footer>`;
  const grid = root.querySelector('.library-grid');
  const search = root.querySelector('input[type=search]');
  const sort = root.querySelector('select');
  const form = root.querySelector('.library-form');
  const error = root.querySelector('.library-error');
  const back = root.querySelector('.library-return');
  let pending = false;

  // 기본값: 거부 값은 Error 가 아닐 수 있으므로 그 값 자체를 보인다.
  const fail = (reason) => { error.textContent = String(reason.message ?? reason); error.hidden = false; };
  async function perform(work) {
    if (pending) return;
    pending = true; error.hidden = true;
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

  function render() {
    if (!projects.inLibrary()) return;
    const all=projects.all(), open=all.filter(p=>projects.isOpen(p.id));
    root.querySelector('.library-count').textContent=`프로젝트 ${all.length} · 열림 ${open.length}`;
    back.hidden=!projects.active();
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
      text.append(meta); choose.append(text);
      const pin=element('button','act library-project__pin');pin.type='button';pin.dataset.expose='core.library.pin';pin.innerHTML=icon('star');
      pin.title=project.pinned?'고정 해제':'프로젝트 고정';pin.setAttribute('aria-pressed',String(Boolean(project.pinned)));
      mark(pin,'core.library.pin',{id:project.id,pinned:!project.pinned});
      card.append(choose,pin); grid.append(card);
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
    const previews={};
    for(const card of grid.querySelectorAll('.library-project')) {
      previews[card.dataset.projectId]=[...card.querySelectorAll('.library-preview__pane')].map(pane=>{
        const r=pane.getBoundingClientRect();return {card:pane.dataset.cardId,x:r.x,y:r.y,w:r.width,h:r.height};
      });
    }
    // 기본값: 폴더 이름 칸은 새 폴더를 만들 때만 있으므로 없는 칸의 값은 null 이다.
    const input=(name)=>form.querySelector(`input[name="${name}"]`)?.value ?? null;
    return {
      shown:[...grid.querySelectorAll('.library-project')].map(card=>card.dataset.projectId),
      pinned:[...grid.querySelectorAll('.library-project')].filter(card=>card.querySelector('.library-project__pin').getAttribute('aria-pressed')==='true').map(card=>card.dataset.projectId),
      count:root.querySelector('.library-count').textContent,
      query:search.value, sort:sort.value, form:!form.hidden,
      formState:form.hidden?null:{mode:formMode,name:input('name'),parent:input('parent')},
      returnVisible:!back.hidden, pending, empty:!root.querySelector('.library-empty').hidden,
      noResults:Boolean(grid.querySelector('.library-no-results')),
      error:error.hidden?null:error.textContent, previews,
    };
  }
  const SORTS=['saved','name','recent','open'];
  /* 명령이 부르는 연산. */
  const actions={
    search(query){ search.value=query; render(); },
    sort(order){ if(!SORTS.includes(order)) throw new Error(`unknown sort ${order}`); sort.value=order; render(); },
    open:(id)=>perform(()=>projects.activate(id)),
    pin:(id,pinned)=>perform(()=>projects.pin(id,pinned)),
    newWindow:()=>perform(()=>projects.newWindow()),
    back(){ if(back.hidden) throw new Error('there is no workspace to return to'); return perform(()=>projects.activate(projects.active().id)); },
    openForm:(mode)=>showForm(mode),
    cancelForm(){ if(form.hidden) throw new Error('the form is not open'); closeForm(); },
    setField(name,value){ formField(name).value=value; rendered(); },
    chooseFolder(){ formField('parent'); return perform(async()=>{ const path=await windows.chooseFolder(); if(path) formField('parent').value=path; }); },
    submitForm,
  };
  return {render, state, actions};
}

// 미리보기의 창 사이드바 열은 내용 카드와 구분한다.
const aside=(id)=>isPlace(id);

function preview(project) {
  const el=element('div','library-preview'); el.setAttribute('aria-hidden','true');
  const layout=project.spaces.find(s=>s.id===project.activeSpaceId)?.layout;
  if (!layout) return el;
  const {cards,xs,ys}=layout.state;
  // 분할 위치는 격자 인덱스로 유지하고, 표시 비율은 미리보기에서 정한다.
  el.style.gridTemplateColumns=xs.slice(1).map((_,column)=>
    cards.some(c=>!aside(c.id)&&c.c0<=column&&column<c.c1)?'minmax(0,1fr)':'minmax(0,.22fr)').join(' ');
  el.style.gridTemplateRows=`repeat(${ys.length-1},minmax(0,1fr))`;
  for(const card of cards) {
    const pane=element('div','library-preview__pane');
    pane.dataset.cardId=card.id;
    pane.style.gridArea=`${card.r0+1} / ${card.c0+1} / ${card.r1+1} / ${card.c1+1}`;
    // 기본값: 자리 카드는 data 가 null 이므로 탭이 없다.
    const tabs=(card.data?.tabs ?? []).filter(t=>hasPlugin(t.plugin));
    // 기본값: 활성 탭의 플러그인이 설치되지 않아 걸러졌으면 남은 첫 탭을 미리 본다.
    const active=tabs.find(t=>t.id===card.data?.activeId) ?? tabs[0];
    // 기본값: 설치된 플러그인의 탭이 없는 카드는 플러그인이 없다(빈 문자열).
    pane.dataset.plugin=aside(card.id)?'sidebar':active?.plugin ?? '';
    if(active) {
      const {ink}=plugin(active.plugin);
      if(ink) pane.style.setProperty('--preview-ink',`var(${ink})`);
      const mark=element('span','library-preview__mark');
      mark.innerHTML=`<svg viewBox="0 0 16 16">${plugin(active.plugin).svg}</svg>`;
      pane.append(mark);
    }
    el.append(pane);
  }
  return el;
}
