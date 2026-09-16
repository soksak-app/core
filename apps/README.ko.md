# 애플리케이션

[English](README.md)

각 애플리케이션은 같은 워크벤치를 자기 `environment.json`의 플러그인과 기본값으로 조립한다. 브라우저 애플리케이션은 네이티브 호스트가 없어 플러그인 표면 자리만 표시한다. Wails와 Tauri 애플리케이션은 플러그인 표면을 네이티브 웹뷰로 표시한다.

```sh
make prepare
pnpm example
```

브라우저 애플리케이션은 `http://localhost:8749/index.html`에서 연다. macOS 네이티브 애플리케이션 빌드와 실행:

```sh
make wails
make tauri
```

앱 시작 시 프로젝트 라이브러리를 표시한다. 프로젝트를 생성하거나 저장된 프로젝트를 선택하여 같은 창에서 작업을 시작한다. 제목 표시줄의 프로젝트 목록 버튼은 현재 작업을 유지하면서 라이브러리로 돌아간다. macOS Dock 메뉴를 포함한 새 창 동작은 다른 창에 라이브러리를 표시한다. 공통 열기 방식은 이미 프로젝트가 있는 창에서 적용한다. 공통 설정은 앱 설정 디렉터리에, 폴더 재정의는 프로젝트 내부의 `.soksak/settings.json`에 저장한다.

설정은 `data-native-modal="dialog"`, 추가·분할 선택 메뉴는 `data-native-modal="menu"`를 사용한다. 네이티브 호스트는 기존 DOM 요소를 메인 OS 창 내부의 웹뷰로 렌더링한다.

- [프로젝트·설정·창](../docs/spec/projects.ko.md)
- [예제 모델](../docs/spec/example-model.ko.md)
- [플러그인과 애플리케이션 환경](../docs/spec/plugins.ko.md)
- [네이티브 호스트 인터페이스](../docs/spec/native-host.ko.md)
- [data-native-modal 사용과 동작](../docs/spec/native-modals.ko.md)
- [네이티브 표면 배치](../docs/spec/native-surfaces.ko.md)
- [빌드·실행·검증](../docs/operations/examples.ko.md)
- [구현 및 플랫폼 상태](../docs/features.ko.md)
