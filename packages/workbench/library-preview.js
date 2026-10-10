// The project preview of the library. It draws the stored layout of the active space as a card grid.
import { hasPlugin, isPlace, plugin } from "./registry.js";
import { checkStoredLayout } from "./stored-layout.js";
import { showError } from "./shown-errors.js";

/** Creates an element that has className. */
function part(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

// The window sidebar column of the preview is distinguished from content cards.
const aside=(id)=>isPlace(id);

export function preview(project) {
  const el=part('div','library-preview'); el.setAttribute('aria-hidden','true');
  const layout=project.spaces.find(s=>s.id===project.activeSpaceId)?.layout;
  if (!layout) return el;
  // A layout that cannot be opened by the same check that opens it is not drawn, and the reason is shown.
  try {
    checkStoredLayout(layout);
  } catch (error) {
    const text=`projects.json: project ${project.root} space ${project.activeSpaceId}: ${error.message}`;
    el.dataset.previewError=text;
    const reason=part('p','library-preview__error');
    el.append(reason);
    showError(reason, `library preview ${project.id}`, text);
    return el;
  }
  const {cards,xs,ys}=layout.state;
  // The split position is kept as a grid index, and the display ratio is decided in the preview.
  el.style.gridTemplateColumns=xs.slice(1).map((_,column)=>
    cards.some(c=>!aside(c.id)&&c.c0<=column&&column<c.c1)?'minmax(0,1fr)':'minmax(0,.22fr)').join(' ');
  el.style.gridTemplateRows=`repeat(${ys.length-1},minmax(0,1fr))`;
  for(const card of cards) {
    const pane=part('div','library-preview__pane');
    pane.dataset.cardId=card.id;
    pane.style.gridArea=`${card.r0+1} / ${card.c0+1} / ${card.r1+1} / ${card.c1+1}`;
    // default: a place card has data null, so it has no tab.
    const tabs=card.data?.tabs ?? [];
    // A content card that passed the check has the active tab of a registered plugin. A place card has no tab.
    const active=tabs.find(t=>t.id===card.data?.activeId);
    pane.dataset.plugin=aside(card.id)?'sidebar':active.plugin;
    // A tab of a plugin that is not loaded is drawn as a placeholder slot without a display (docs/spec/plugins.md).
    if(active&&!hasPlugin(active.plugin)) pane.dataset.placeholder='true';
    else if(active) {
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
