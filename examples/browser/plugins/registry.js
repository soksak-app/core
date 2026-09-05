// 플러그인과 섹션의 등록소.
//
// 플러그인은 `+` 메뉴 항목과 표면 두 가지를 갖고 사이드바는 갖지 않는다. 사이드바
// 구성은 사용자가 세트로 조합하고 설정에서 연결한다. 플러그인이 사이드바를 소유하면
// 사용자가 변경할 수 없다.
//
// 섹션은 사이드바에 표시할 수 있는 항목 하나다. 등록 방식은 플러그인과 같고 표면이
// 없다는 점만 다르다.

const registeredPlugins = [];
const registeredSections = [];

/**
 * 플러그인 하나를 등록한다.
 *
 * @param {object} plugin
 * @param {string} plugin.id    플러그인 종류의 id. 탭이 이 값을 갖는다
 * @param {string} plugin.name  `+` 메뉴에 표시할 이름
 * @param {string} plugin.mark  메뉴 오른쪽 표시이자 탭 제목의 접두사
 * @param {string} plugin.svg   16×16 뷰박스 기준 아이콘 경로
 * @param {(cardId: string) => {url: string} | {page: string}} plugin.surface
 *        표면이 표시할 대상. `url` 은 외부 주소, `page` 는 이 호스트가 서비스하는
 *        문서다. 호스트는 둘만 구분하고 플러그인 종류는 알지 않는다
 */
export function registerPlugin(plugin) {
  if (registeredPlugins.some((p) => p.id === plugin.id)) {
    throw new Error(`plugin already registered: ${plugin.id}`);
  }
  registeredPlugins.push(plugin);
}

/**
 * 사이드바에 표시할 수 있는 섹션 하나를 등록한다.
 *
 * @param {object} section
 * @param {string} section.id    세트가 이 id 로 참조한다
 * @param {string} section.name  사이드바에 표시할 이름
 */
export function registerSection(section) {
  if (registeredSections.some((s) => s.id === section.id)) {
    throw new Error(`section already registered: ${section.id}`);
  }
  registeredSections.push(section);
}

/** 플러그인을 등록 순서로 반환한다. `+` 메뉴가 이 순서를 사용한다. */
export const plugins = () => registeredPlugins;

/** 섹션을 등록 순서로 반환한다. 세트 조합 시 선택 목록으로 사용한다. */
export const sections = () => registeredSections;

/** id 로 조회한다. 등록되지 않은 id 면 예외를 던진다. */
export function plugin(id) {
  const found = registeredPlugins.find((p) => p.id === id);
  if (!found) throw new Error(`unknown plugin: ${id}`);
  return found;
}

/** 해당 플러그인의 레일 카드 id 를 반환한다. 레일은 플러그인마다 하나다. */
export const railId = (id) => `rail-${id}`;

/** 레일 카드 id 의 플러그인 종류를 반환한다. 레일이 아니면 null. */
export const railKind = (place) => {
  const found = registeredPlugins.find((p) => railId(p.id) === place);
  return found ? found.id : null;
};

/** 고정 자리(좌·우·레일)인지 반환한다. 나머지 카드는 탭을 담는다. */
export const isPlace = (id) =>
  id === "left" || id === "right" || railKind(id) !== null;

/** id 로 조회한다. 등록되지 않은 id 면 예외를 던진다. */
export function section(id) {
  const found = registeredSections.find((s) => s.id === id);
  if (!found) throw new Error(`unknown section: ${id}`);
  return found;
}
