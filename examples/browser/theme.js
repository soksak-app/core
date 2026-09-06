// 이 애플리케이션이 서비스하는 문서에 테마를 적용한다.
//
// 표면과 모달은 각각 별도 문서라 메인 페이지의 스타일시트를 상속하지 않는다. 토큰
// 값을 받아 자기 루트에 설정한다. 두 문서가 같은 값을 같은 방법으로 적용해야 하므로
// 여기에 둔다.
import { page } from "./framework/index.js";

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
