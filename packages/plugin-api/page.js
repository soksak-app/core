// 플러그인 페이지와 모달 페이지가 사용하는 인터페이스.
//
// 표면과 모달은 각각 별도 문서라 메인 페이지의 스타일시트를 상속하지 않는다. 호스트가
// 보낸 테마 토큰을 자기 루트에 설정한다.
import { page } from "@soksak/runtime";

export { page };

/** 받은 테마를 이 문서의 루트에 설정한다. 값이 바뀌면 다시 호출된다. */
export function followTheme() {
  page.theme((theme) => {
    const root = document.documentElement;
    root.style.colorScheme = theme.scheme;
    for (const [token, value] of Object.entries(theme.tokens)) {
      root.style.setProperty(token, value);
    }
  });
}
