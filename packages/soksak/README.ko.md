# soksak

[English](README.md)

공유 격자선과 선택적 DOM 바인딩을 제공하는 헤드리스 분할 배치 라이브러리다. 런타임 의존성은 없다. 라이브러리는 카드 좌표를 계산하고 애플리케이션은 콘텐츠, 스타일, 네이티브 뷰를 제공한다.

```sh
pnpm add "github:soksak-app/core#path:packages/soksak"
```

Git 의존성에 `dist/`를 포함한다. 패키지는 ESM을 사용한다.

```js
import { Soksak, SoksakView } from "soksak";

const grid = new Soksak();
const view = new SoksakView(document.querySelector("#stage"), grid, {
  createCard: () => document.createElement("article"),
});
view.render();
```

`#stage`에 크기와 `position: relative`를 지정하고 카드에 `box-sizing: border-box`를 지정한다.

- [배치 규칙과 API](docs/layout.ko.md)

이 디렉터리에서 `pnpm test`, `pnpm breaks`, `pnpm fuzz`, `pnpm mutate`를 실행한다. MIT 라이선스: [LICENSE](LICENSE).
