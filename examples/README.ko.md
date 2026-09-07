# 예제

[English](README.md)

브라우저 페이지는 프로젝트, 스페이스, 카드, 탭, 사이드바, 플러그인 선택을 제공한다. Wails와 Tauri 애플리케이션은 같은 프런트엔드에 네이티브 브라우저·터미널 웹뷰를 사용한다.

```sh
make prepare
pnpm example
```

브라우저 예제는 `http://localhost:8749/examples/browser/index.html`에서 연다. macOS 네이티브 예제 빌드와 실행:

```sh
make wails
make tauri
```

설정은 `data-native-modal="dialog"`, 추가·분할 선택 메뉴는 `data-native-modal="menu"`를 사용한다. 네이티브 호스트는 기존 DOM 요소를 메인 OS 창 내부의 웹뷰로 렌더링한다.

- [예제 모델](../docs/spec/example-model.ko.md)
- [네이티브 호스트 인터페이스](../docs/spec/native-host.ko.md)
- [data-native-modal 사용과 동작](../docs/spec/native-modals.ko.md)
- [네이티브 표면 배치](../docs/spec/native-surfaces.ko.md)
- [빌드·실행·검증](../docs/operations/examples.ko.md)
- [구현 및 플랫폼 상태](../docs/features.ko.md)
