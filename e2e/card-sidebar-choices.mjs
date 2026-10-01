// 창 검사가 카드 사이드바를 잠시 끄고, 검사 준비가 실패해도 원래 선택을 되돌리게 한다.

/**
 * 카드 card 의 네 변 사이드바를 off 로 바꾼다. 바꾸기 전에 저장된 선택을 읽고, 그 선택으로 되돌리는 정리를 먼저
 * 등록하므로 끄는 도중 실패해도 정리가 원래 선택을 복원한다. 명시 세트가 없던 변은 inherit 로 되돌린다.
 */
export async function turnOffCardSidebars(s, card) {
  const choices = (await s.get("core.layout")).state.cards.find((item) => item.id === card).data.sidebars;
  s.cleanup(async () => {
    for (const side of ["left", "right", "top", "bottom"]) {
      await s.run("core.card.sidebar.set", { card, side, set: choices?.[side]?.set ?? "inherit" });
    }
    await s.presented();
  });
  for (const side of ["left", "right", "top", "bottom"]) await s.run("core.card.sidebar.set", { card, side, set: "off" });
}
