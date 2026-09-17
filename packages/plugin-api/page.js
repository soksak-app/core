// 플러그인 페이지와 모달 페이지가 사용하는 인터페이스.
//
// 표면과 모달은 각각 별도 문서라 메인 페이지의 스타일시트를 상속하지 않는다. 호스트가
// 보낸 테마 토큰을 자기 루트에 설정한다.
import { page } from "@soksak/runtime";
import {
  MANIFEST, createExpose, declarationMap, modulePath, pagePackage, validateManifest,
} from "@soksak/plugin-api";

export { page };

/**
 * 받은 테마를 이 문서의 루트에 설정한다. 값이 바뀌면 다시 호출된다.
 *
 * 반환한 promise 는 첫 테마를 설정한 뒤 이행된다. 공개 항목을 그 뒤에 등록하면
 * 등록된 문서는 테마가 적용된 문서다.
 */
export function followTheme() {
  return new Promise((applied) => {
    page.theme((theme) => {
      const root = document.documentElement;
      root.style.colorScheme = theme.scheme;
      for (const [token, value] of Object.entries(theme.tokens)) {
        root.style.setProperty(token, value);
      }
      applied();
    });
  });
}

/**
 * 이 문서의 plugin.json 이 선언한 공개 항목. 문서는 `modules/<패키지>/...` 에 있으므로
 * 같은 패키지의 plugin.json 을 읽는다.
 */
async function ownDeclarations() {
  const name = pagePackage(location.pathname);
  if (!name) throw new Error(`${location.pathname} is not a plugin page`);
  const response = await fetch(`/${modulePath(name, MANIFEST)}`);
  if (!response.ok) throw new Error(`failed to load ${MANIFEST} of ${name}: ${response.status}`);
  return declarationMap(validateManifest(await response.json()).exposes ?? {});
}

/** 표면 페이지의 공개 항목 등록 함수. 네이티브 호스트가 없으면 null 이다. */
export const expose = page?.exposure ? createExpose(page.exposure, ownDeclarations) : null;
