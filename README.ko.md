# soksak

[English](README.md)

공유 격자선과 선택적 DOM 바인딩을 제공하는 헤드리스 분할 배치 라이브러리다. 런타임 의존성은 없다. 라이브러리는 카드 좌표를 계산하고 애플리케이션은 콘텐츠, 스타일, 네이티브 뷰를 제공한다.

```sh
pnpm add github:min-median-max/soksak
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

`#stage`에 크기와 `position: relative`를 지정하고 카드에 `box-sizing: border-box`를 설정한다.

- [배치 규칙과 API](docs/spec/layout.ko.md)
- [예제 애플리케이션](examples/README.ko.md)
- [네이티브 표면 배치](docs/spec/native-surfaces.ko.md)
- [data-native-modal](docs/spec/native-modals.ko.md)
- [구현·검증·배포 상태](docs/features.ko.md)
- [변경 기록](CHANGELOG.ko.md)
- [개발 및 필수 검사](AGENTS.ko.md)

MIT 라이선스: [LICENSE](LICENSE).
