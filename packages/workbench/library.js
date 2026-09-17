// 프로젝트 목록과 생성·열기 화면. 콘텐츠 웹뷰와 셸은 프로젝트를 열 때 생성한다.
import * as projects from "./projects.js";
import { fresh } from "./plane.js";
import { windows } from "@soksak/runtime";
import { icon } from "./icons.js";
import { isPlace, plugin } from "./registry.js";

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
        <label class="select-field library-sort"><select aria-label="프로젝트 정렬" data-expose="core.library.sort"><option value="saved">저장 순서</option><option value="name">이름</option><option value="recent">최근</option><option value="open">열림</option></select></label>
        <label class="library-search"><span class="sr-only">프로젝트 검색</span><input class="text-field" type="search" data-expose="core.library.search" placeholder="이름 또는 폴더 검색" autocomplete="off"></label>
      </header>
      <div class="library-error" role="alert" hidden></div>
      <div class="library-form" hidden></div>
      <div class="library-empty" hidden><h2>프로젝트를 시작하세요</h2><p>새 프로젝트를 만들거나 기존 폴더를 여세요.</p></div>
      <div class="library-grid" role="list"></div>
    </main>
    <footer class="library-footer"><span class="library-count"></span><button type="button" class="library-return" data-expose="core.library.return" hidden>작업 화면으로 돌아가기</button><button type="button" data-action="window" data-expose="core.library.window">＋ 새 창</button></footer>`;
  const grid = root.querySelector('.library-grid');
  const search = root.querySelector('input[type=search]');
  const sort = root.querySelector('select');
  const form = root.querySelector('.library-form');
  const error = root.querySelector('.library-error');
  const back = root.querySelector('.library-return');
  let pending = false;

  const fail = (reason) => { error.textContent = String(reason.message ?? reason); error.hidden = false; };
  async function perform(work) {
    if (pending) return;
    pending = true; error.hidden = true;
    root.setAttribute('aria-busy', 'true');
    try { await work(); } catch (reason) { fail(reason); }
    finally { pending = false; root.removeAttribute('aria-busy'); render(); }
  }
  function record(root) {
    return projects.open({ root, color:TINTS.find(t=>!projects.all().some(p=>p.color===t)) ?? TINTS[0], layout:fresh() });
  }
  function showForm() {
    error.hidden = true;
    form.hidden = false;
    form.innerHTML = '';
    const creates = windows.createsFolders;
    const heading = element('h2', '', creates?'새 프로젝트':'폴더 열기');
    const fields = element('form', 'library-fields');
    function field(name, title, placeholder, expose) {
      const label=element('label','',title), input=element('input','text-field');
      input.name=name; input.dataset.expose=expose; input.placeholder=placeholder; input.required=true; input.autocomplete='off';
      label.append(input); fields.append(label); return input;
    }
    const name=creates?field('name','프로젝트 폴더 이름','my-project','core.library.form.name'):null;
    const parent=field('parent',creates?'생성 위치':'폴더 경로','/Users/…','core.library.form.parent');
    if (creates) {
      const choose=element('button','ui-button','폴더 선택'); choose.type='button'; choose.dataset.expose='core.library.form.choose';
      choose.onclick=()=>perform(async()=>{ const path=await windows.chooseFolder(); if(path) parent.value=path; });
      parent.parentElement.append(choose);
    }
    const actions=element('div','library-form__actions');
    const cancel=element('button','ui-button','취소'); cancel.type='button'; cancel.dataset.expose='core.library.form.cancel'; cancel.onclick=()=>{form.hidden=true;rendered();};
    const submit=element('button','ui-button library-primary',creates?'생성 후 열기':'열기'); submit.type='submit'; submit.dataset.expose='core.library.form.submit';
    actions.append(cancel,submit); fields.append(actions); form.append(heading,fields);
    fields.onsubmit=(event)=>{event.preventDefault();perform(async()=>{
      let root=parent.value.trim();
      if(creates) root=(await windows.createFolder({parent:root,name:name.value.trim()})).root;
      await record(root); form.hidden=true;
    });};
    fields.querySelector('input').focus();
    rendered();
  }
  root.querySelector('[data-action=window]').onclick=()=>perform(()=>projects.newWindow());
  back.onclick=()=>perform(()=>projects.activate(projects.active().id));
  search.oninput=render; sort.onchange=render;

  function render() {
    if (!projects.inLibrary()) return;
    const all=projects.all(), open=all.filter(p=>projects.isOpen(p.id));
    root.querySelector('.library-count').textContent=`프로젝트 ${all.length} · 열림 ${open.length}`;
    back.hidden=!projects.active();
    const query=search.value.trim().toLocaleLowerCase();
    const shown=all.filter(p=>`${p.title} ${p.root}`.toLocaleLowerCase().includes(query));
    if(sort.value==='name') shown.sort((a,b)=>a.title.localeCompare(b.title));
    if(sort.value==='recent') shown.sort((a,b)=>(b.lastOpened??0)-(a.lastOpened??0));
    if(sort.value==='open') shown.sort((a,b)=>Number(projects.isOpen(b.id))-Number(projects.isOpen(a.id)));
    grid.replaceChildren();
    for(const project of shown) {
      const card=element('article','library-project'); card.dataset.projectId=project.id; card.setAttribute('role','listitem');
      card.dataset.open=String(projects.isOpen(project.id));
      const choose=element('button','library-project__open'); choose.type='button'; choose.title=project.root; choose.dataset.expose='core.library.open';
      choose.setAttribute('aria-label',`${project.title} 열기`);
      choose.onclick=()=>perform(()=>projects.activate(project.id));
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
      pin.onclick=()=>perform(()=>projects.pin(project.id,!project.pinned));
      card.append(choose,pin); grid.append(card);
    }
    const add=element('button','library-add',windows.createsFolders?'＋ 새 프로젝트':'＋ 폴더 열기');add.type='button';add.dataset.action='create';add.dataset.expose='core.library.add';
    add.onclick=showForm;grid.append(add);
    const empty=root.querySelector('.library-empty');empty.hidden=all.length>0;
    if(!shown.length&&all.length) grid.prepend(element('p','library-no-results','일치하는 프로젝트가 없습니다.'));
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
    return {
      shown:[...grid.querySelectorAll('.library-project')].map(card=>card.dataset.projectId),
      count:root.querySelector('.library-count').textContent,
      query:search.value, sort:sort.value, form:!form.hidden,
      error:error.hidden?null:error.textContent, previews,
    };
  }
  return {render, state, search:()=>search.focus()};
}

function preview(project) {
  const el=element('div','library-preview'); el.setAttribute('aria-hidden','true');
  const layout=project.spaces.find(s=>s.id===project.activeSpaceId)?.layout;
  if (!layout) return el;
  const {cards,xs,ys}=layout.state;
  // 분할 위치는 격자 인덱스로 유지하고, 표시 비율은 미리보기에서 정한다.
  el.style.gridTemplateColumns=xs.slice(1).map((_,column)=>
    cards.some(c=>!isPlace(c.id)&&c.c0<=column&&column<c.c1)?'minmax(0,1fr)':'minmax(0,.22fr)').join(' ');
  el.style.gridTemplateRows=`repeat(${ys.length-1},minmax(0,1fr))`;
  for(const card of cards) {
    const pane=element('div','library-preview__pane');
    pane.dataset.cardId=card.id;
    pane.style.gridArea=`${card.r0+1} / ${card.c0+1} / ${card.r1+1} / ${card.c1+1}`;
    const tabs=card.data?.tabs ?? [];
    const active=tabs.find(t=>t.id===card.data?.activeId) ?? tabs[0];
    pane.dataset.plugin=isPlace(card.id)?'sidebar':active?.plugin ?? '';
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
