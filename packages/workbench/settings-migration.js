// 이전 형식으로 저장한 설정을 현재 형식으로 바꾼다(docs/spec/settings.md). 설정 저장소를 연결할 때 한 번 쓴다.

/* 이전 형식에서 쓰던 설정 키. 지금은 설정이 아니므로 지운다. */
const REMOVED_KEYS = ["cardSidebar", "rail", "railWidth", "sidebarFoldedWidth", "latency", "skew"];

/**
 * 연결 하나를 현재 형식으로 바꾼다. rail 연결은 카드 왼쪽 연결(card-left)이 되었고, 플러그인을 가리키는 left, right
 * 연결은 창 사이드바 덮어쓰기(window-left, window-right)가 되었다. 세트가 null 인 플러그인 연결(사용 안 함)은 지금
 * 형식으로 나타낼 수 없으므로 버리며, 그 플러그인에는 일반 내용이 보인다. 반환값은 { link, note } 이고 link 가 null 이면
 * 버린 것이다. 바꿀 것이 없으면 note 는 null 이다.
 */
function migrateLink(link) {
  if (link.place === "rail") {
    return { link: { ...link, place: "card-left" }, note: `the rail link of ${link.plugin} became card-left` };
  }
  if ((link.place === "left" || link.place === "right") && link.plugin !== null) {
    if (link.set === null) {
      return { link: null, note: `the ${link.place} link of ${link.plugin} without a set was dropped because a window override requires a set` };
    }
    return { link: { ...link, place: `window-${link.place}` }, note: `the ${link.place} link of ${link.plugin} became window-${link.place}` };
  }
  return { link, note: null };
}

/**
 * 저장된 설정 값 하나(공통 설정 또는 프로젝트 설정)를 바꾼다. known 은 그 범위의 연결이 가리킬 수 있는 세트 id 다.
 * 그 밖의 세트를 가리키는 연결은 이전 선언과 함께 사라진 세트를 고르므로 지운다. 반환값은 { patch, notes } 이다. patch
 * 는 저장소의 settings(id, patch) 에 넘길 변경이며 지울 키의 값은 undefined 다. 바꿀 것이 없으면 patch 는 비어 있다.
 */
export function migrateSettings(values, known) {
  const patch = {}, notes = [];
  const removed = REMOVED_KEYS.filter((key) => Object.hasOwn(values, key));
  for (const key of removed) patch[key] = undefined;
  if (removed.length) notes.push(`removed ${removed.join(", ")} because they are no longer settings`);
  if (Array.isArray(values.links)) {
    const links = [], linkNotes = [];
    for (const stored of values.links) {
      const { link, note } = migrateLink(stored);
      if (note) linkNotes.push(note);
      if (!link) continue;
      if (link.set !== null && !known.has(link.set)) {
        linkNotes.push(`the ${link.place} link${link.plugin === null ? "" : ` of ${link.plugin}`} was dropped because its set ${link.set} no longer exists`);
        continue;
      }
      links.push(link);
    }
    if (linkNotes.length) { patch.links = links; notes.push(...linkNotes); }
  }
  return { patch, notes };
}
