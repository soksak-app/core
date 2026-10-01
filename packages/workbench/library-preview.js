// 라이브러리의 프로젝트 미리보기. 활성 스페이스의 저장 배치를 카드 격자로 그린다.
import { isPlace, plugin } from "./registry.js";
import { checkStoredLayout } from "./stored-layout.js";

/** className 을 가진 요소를 만든다. */
function part(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

// 미리보기의 창 사이드바 열은 내용 카드와 구분한다.
const aside=(id)=>isPlace(id);

export function preview(project) {
  const el=part('div','library-preview'); el.setAttribute('aria-hidden','true');
  const layout=project.spaces.find(s=>s.id===project.activeSpaceId)?.layout;
  if (!layout) return el;
  // 여는 것과 같은 검사로 열 수 없는 배치는 그리지 않고 그 이유를 보인다.
  try {
    checkStoredLayout(layout);
  } catch (error) {
    el.dataset.error=error.message;
    const reason=part('p','library-preview__error');
    reason.textContent=error.message;
    el.append(reason);
    return el;
  }
  const {cards,xs,ys}=layout.state;
  // 분할 위치는 격자 인덱스로 유지하고, 표시 비율은 미리보기에서 정한다.
  el.style.gridTemplateColumns=xs.slice(1).map((_,column)=>
    cards.some(c=>!aside(c.id)&&c.c0<=column&&column<c.c1)?'minmax(0,1fr)':'minmax(0,.22fr)').join(' ');
  el.style.gridTemplateRows=`repeat(${ys.length-1},minmax(0,1fr))`;
  for(const card of cards) {
    const pane=part('div','library-preview__pane');
    pane.dataset.cardId=card.id;
    pane.style.gridArea=`${card.r0+1} / ${card.c0+1} / ${card.r1+1} / ${card.c1+1}`;
    // 기본값: 자리 카드는 data 가 null 이므로 탭이 없다.
    const tabs=card.data?.tabs ?? [];
    // 검사를 통과한 내용 카드에는 등록된 플러그인의 활성 탭이 있다. 자리 카드에는 탭이 없다.
    const active=tabs.find(t=>t.id===card.data?.activeId);
    pane.dataset.plugin=aside(card.id)?'sidebar':active.plugin;
    if(active) {
      const {ink}=plugin(active.plugin);
      if(ink) pane.style.setProperty('--preview-ink',`var(${ink})`);
      const mark=part('span','library-preview__mark');
      mark.innerHTML=`<svg viewBox="0 0 16 16">${plugin(active.plugin).svg}</svg>`;
      pane.append(mark);
    }
    el.append(pane);
  }
  return el;
}
