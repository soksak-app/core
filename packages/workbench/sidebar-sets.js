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

/** 세트 하나의 제목이나 배치를 바꾼다. 섹션은 changeRow 가 바꾼다. */
export function updateSet(sets, id, change) {
  for (const key of Object.keys(change)) {
    if (!["title", "layout"].includes(key)) throw new Error(`set update has unknown field ${key}`);
  }
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
  return sets.map((s, i) => (i === index ? next : s));
}

/**
 * 세트의 섹션 행 하나를 바꾼다(docs/spec/settings.md 의 사이드바 절).
 *
 *   choose  index 행을 section 으로 바꾼다
 *   up      index 행을 위 행과 바꾼다
 *   down    index 행을 아래 행과 바꾼다
 *   remove  index 행을 뺀다
 *   add     세트에 없는 등록 섹션 중 registered 순서로 첫 섹션을 끝에 더한다
 *
 * registered 는 등록된 섹션 id 를 플러그인과 선언 순서로 담는다. 같은 섹션이 두 번 들어가게 하는 변경은 거부한다.
 */
export function changeRow(sets, id, { action, index, section }, registered) {
  const at = sets.findIndex((s) => s.id === id);
  if (at < 0) throw new Error(`unknown set ${id}`);
  const rows = [...sets[at].sections];
  const row = () => {
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) throw new Error(`set ${id} has no row ${index}`);
  };
  if (action === "choose") {
    row();
    if (!registered.includes(section)) throw new Error(`unknown section ${section}`);
    if (rows.some((other, i) => i !== index && other === section)) throw new Error(`section ${section} is already in set ${id}`);
    rows[index] = section;
  } else if (action === "up") {
    row();
    if (index === 0) throw new Error(`row ${index} cannot move up`);
    [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]];
  } else if (action === "down") {
    row();
    if (index === rows.length - 1) throw new Error(`row ${index} cannot move down`);
    [rows[index], rows[index + 1]] = [rows[index + 1], rows[index]];
  } else if (action === "remove") {
    row();
    rows.splice(index, 1);
  } else if (action === "add") {
    const next = registered.find((candidate) => !rows.includes(candidate));
    if (!next) throw new Error(`set ${id} already contains every registered section`);
    rows.push(next);
  } else {
    throw new Error(`unknown row action ${action}`);
  }
  return sets.map((s, i) => (i === at ? { ...structuredClone(s), sections: rows } : s));
}

/**
 * 사이드바 선택 하나를 바꾼 연결 목록을 반환한다(docs/spec/settings.md 의 사이드바 선택).
 * choice 는 세트 id 또는 off 다. plugin 이 null 이면 left, right 의 일반 선택이다.
 */
export function chooseLink(links, place, plugin, choice) {
  if (!["left", "right", "window-left", "window-right", "card-left", "card-right", "card-top", "card-bottom"].includes(place)) throw new Error(`unknown place ${place}`);
  const general = place === "left" || place === "right";
  if (general ? plugin !== null : plugin === null) throw new Error(`invalid plugin for ${place}`);
  if (choice === "inherit") throw new Error(`${place} has no inherit choice`);
  const rest = links.filter(link => !(link.place === place && link.plugin === plugin));
  return choice === "off" ? rest : [...rest, { place, plugin, set: choice }];
}

/**
 * 사이드바에 보일 세트를 반환한다. 없거나 사용 안 함이면 null.
 * 일반 창, 플러그인 창, 카드 사방의 연결을 각각 독립적으로 선택한다.
 */
export function resolveSidebar(links, sets, place, plugin) {
  const chosen = links.find(link => link.place === place && link.plugin === plugin);
  if (!chosen) return null;
  const set = sets.find((s) => s.id === chosen.set);
  if (!set) throw new Error(`link points at a set that is gone: ${chosen.set}`);
  return set;
}

/** 세트와 그 세트를 가리키는 연결을 함께 뺀다. */
export function deleteSet(sets, links, id) {
  if (!sets.some((s) => s.id === id)) throw new Error(`unknown set ${id}`);
  return { sets: sets.filter((s) => s.id !== id), links: links.filter((l) => l.set !== id) };
}
