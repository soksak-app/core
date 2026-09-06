// 애플리케이션 없이 브라우저에서 실행하는 경우.
//
// 호스트가 없으므로 페이지가 표면을 직접 그린다. 표면과 모달 페이지는 열리지 않는다.

/** 요구 조건이 없으므로 항상 true 를 반환한다. 목록의 마지막에 위치한다. */
export const present = () => true;

export const host = () => null;
export const page = () => null;
