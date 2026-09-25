// 설정 창의 플러그인 검색(docs/spec/settings.md 의 플러그인 절).

/** id, 이름, 설명에 검색어가 들어 있는 플러그인을 순서대로 반환한다. 대소문자를 가리지 않고, 빈 검색어는 모두다. */
export function matchPlugins(units, query) {
  const needle = query.toLowerCase();
  return units.filter((u) => [u.id, u.name, u.description].some((text) => text.toLowerCase().includes(needle)));
}
