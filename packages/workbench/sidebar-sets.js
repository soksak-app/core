// 사이드바 세트 목록의 만들기, 편집, 삭제(docs/spec/settings.md).
//
// 목록을 받아 새 목록을 반환한다. 저장은 설정의 set() 이 한다. 받은 목록은 바꾸지 않는다.

const LAYOUTS = ["list", "tabs"];
const TITLE_MAX = 40;

/** 제목 "새 세트", 배치 list, 섹션이 없는 세트를 끝에 더한다. id 는 쓰지 않은 가장 작은 set-<n> 이다. */
export function createSet(sets) {
  const used = new Set(sets.map((s) => s.id));
  let n = 1;
  while (used.has(`set-${n}`)) n++;
  return [...sets, { id: `set-${n}`, title: "새 세트", sections: [], layout: "list" }];
}

/**
 * 세트 하나의 제목, 배치, 또는 섹션 하나를 바꾼다.
 *
 *   change.title    1자에서 40자 사이의 문자열
 *   change.layout   list 또는 tabs
 *   change.section  섹션 id. change.on 이 true 면 끝에 더하고 false 면 뺀다
 */
export function updateSet(sets, id, change) {
  const index = sets.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`unknown set ${id}`);
  const next = structuredClone(sets[index]);
  if (change.title !== undefined) {
    if (typeof change.title !== "string" || change.title.length < 1 || change.title.length > TITLE_MAX) {
      throw new Error(`set title must be 1 to ${TITLE_MAX} characters`);
    }
    next.title = change.title;
  }
  if (change.layout !== undefined) {
    if (!LAYOUTS.includes(change.layout)) throw new Error(`set layout must be ${LAYOUTS.join(" or ")}`);
    next.layout = change.layout;
  }
  if (change.section !== undefined) {
    if (typeof change.section !== "string" || typeof change.on !== "boolean") {
      throw new Error("a section change requires a section id and on");
    }
    next.sections = next.sections.filter((s) => s !== change.section);
    if (change.on) next.sections.push(change.section);
  }
  return sets.map((s, i) => (i === index ? next : s));
}

/** 세트와 그 세트를 가리키는 연결을 함께 뺀다. */
export function deleteSet(sets, links, id) {
  if (!sets.some((s) => s.id === id)) throw new Error(`unknown set ${id}`);
  return { sets: sets.filter((s) => s.id !== id), links: links.filter((l) => l.set !== id) };
}
