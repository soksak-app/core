// 등록된 것들 — 플러그인과 섹션.
//
// 플러그인이 갖는 것은 둘이다: `+` 메뉴에 서는 자리와, 표면이 보여주는 것.
// 사이드바는 갖지 않는다 — 무엇이 사이드바에 서는지는 사람이 세트로 조합하고
// 설정에서 연결한다. 플러그인이 자기 사이드바를 소유하면 사람은 그것을 바꿀
// 수 없다.
//
// 섹션은 사이드바에 설 수 있는 기능 하나다. 등록되는 방식은 플러그인과 같고,
// 표면이 없다는 점만 다르다.

const registeredPlugins = [];
const registeredSections = [];

/**
 * 플러그인 하나를 등록한다.
 *
 * @param {object} plugin
 * @param {string} plugin.id    종류의 이름. 탭이 이 값을 갖는다
 * @param {string} plugin.name  `+` 메뉴에 보이는 이름
 * @param {string} plugin.mark  메뉴의 오른쪽 표시이자 탭 제목의 접두
 * @param {string} plugin.svg   16×16 뷰박스 안의 아이콘 경로
 * @param {(cardId: string) => {url: string} | {page: string}} plugin.surface
 *        표면이 보여주는 것. `url` 은 어디든 가리키는 주소, `page` 는 이
 *        호스트가 서비스하는 문서다. 호스트는 이 둘만 구분하면 되고 종류의
 *        이름은 알 필요가 없다
 */
export function registerPlugin(plugin) {
  if (registeredPlugins.some((p) => p.id === plugin.id)) {
    throw new Error(`plugin already registered: ${plugin.id}`);
  }
  registeredPlugins.push(plugin);
}

/**
 * 사이드바에 설 수 있는 기능 하나를 등록한다.
 *
 * @param {object} section
 * @param {string} section.id    세트가 이 값으로 담는다
 * @param {string} section.name  사이드바에 보이는 이름
 */
export function registerSection(section) {
  if (registeredSections.some((s) => s.id === section.id)) {
    throw new Error(`section already registered: ${section.id}`);
  }
  registeredSections.push(section);
}

/** 등록 순서대로. `+` 메뉴가 이 순서로 선다. */
export const plugins = () => registeredPlugins;

/** 등록 순서대로. 세트를 조합할 때 고르는 목록이다. */
export const sections = () => registeredSections;

/** 이름으로 찾는다. 없는 이름은 부르는 쪽의 잘못이므로 실패한다. */
export function plugin(id) {
  const found = registeredPlugins.find((p) => p.id === id);
  if (!found) throw new Error(`unknown plugin: ${id}`);
  return found;
}

/** 그 종류의 레일 카드 id. 레일은 종류마다 하나다. */
export const railId = (id) => `rail-${id}`;

/** 레일 카드 id 가 가리키는 종류. 레일이 아니면 null. */
export const railKind = (place) => {
  const found = registeredPlugins.find((p) => railId(p.id) === place);
  return found ? found.id : null;
};

/** 고정된 자리인가 — 좌·우와 레일들. 나머지 카드는 탭을 담는다. */
export const isPlace = (id) =>
  id === "left" || id === "right" || railKind(id) !== null;

/** 이름으로 찾는다. 없는 이름은 부르는 쪽의 잘못이므로 실패한다. */
export function section(id) {
  const found = registeredSections.find((s) => s.id === id);
  if (!found) throw new Error(`unknown section: ${id}`);
  return found;
}
