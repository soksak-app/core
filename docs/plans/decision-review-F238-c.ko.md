# 결정 검토 F238-c: 플러그인 테스트의 import(D1)와 소유자 분류(D3)

[English](decision-review-F238-c.md)

이 기록은 두 결정을 검토한다. 각 결정은 주장, 파일과 줄을 든 근거, 정확히 필요한 변경을 적는다. 새 감사자 하위 에이전트는 결정이 틀리거나 불완전한 곳만 이의를 제기하며, 각 이의에는 구체적인 해결책이 붙는다. 문구와 인용 정정은 바로 반영하며 이의가 아니다. 한 라운드의 두 감사자가 실질적 이의가 없다고 보고할 때까지 라운드를 반복한다. 기준은 근거가 있을 때만 바뀌며, 테스트가 도달하지 못한다는 이유로 낮추지 않는다.

검토 범위: 결정이 무엇을 정해야 하는지, 무엇이 실질적 이의인지, 범위 밖이 무엇인지(문구, 모든 구현이 같게 처리하는 경우, 단위 테스트가 정하는 세부 사항).

## 근거 기준

- 본류는 `origin/main`이다. 다른 브랜치는 `git show <branch>:<path>`로만 읽는다.
- 플러그인 저장소는 `../plugins/<id>` 형제 폴더의 `main` 브랜치다.
- 규칙 출처는 `AGENTS.md`(Structure)다: "Tests must not read another package's paths, SDK, build, or implementation names."와 "consumer tests use fakes or fixtures at the consumer boundary".

---

## D1. 플러그인 테스트는 SDK 코드를 import하지 않는다

### 결정

플러그인 저장소의 테스트는 `@soksak/*` 이름(SDK `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`, 공용 키트, 사이드카)을 import하거나 resolve하지 않고, 설치된 패키지 경로를 읽지 않는다. 플러그인 테스트는 그 플러그인의 코드, 매니페스트, 픽스처를 검사한다. 빌드와 검사 스크립트(테스트가 아님)는 SDK 검증기를 호출하고, `VIEW_IMPORTS`를 읽고, census를 실행할 수 있다. 빌드가 이를 실행하며 테스트 스위트는 실행하지 않는다.

### 주장

- 규칙은 테스트가 다른 패키지의 SDK나 구현을 읽는 것을 금한다. SDK는 형식과 뷰 브리지를 core에서 이미 검사한다: `packages/plugin-api/test/view-page.test.mjs`(`checkViewPage`), `view.test.mjs`(`createViewBridge`), `binder.test.mjs`(`createBinder`), `view-imports.test.mjs`(`VIEW_IMPORTS`), `view-core-targets.test.mjs`, 그리고 `events-check.test.mjs`(census 발견 사항, 147행과 161행의 `rs`, `go`, `m` 사례 포함). 플러그인 테스트가 이 검사를 되풀이하면 플러그인 저장소 안에서 SDK를 검사하는 것이다.
- 호스트 계약에 맞춘 플러그인 로컬 픽스처는 소비자 경계에서 플러그인을 검사한다. SDK 코드를 담지 않는다.

### 근거: `@soksak/*`을 import하거나 resolve하는 플러그인 테스트 파일(형제 `../plugins/*`, `main`)

테스트 파일 20개: `appview/test/manifest.test.mjs`, `browser/test/{address-input,empty-state,manifest,page}.test.mjs`(`page.test.mjs:5`가 `INTERACTIVE`를 import), `editor/test/{editor,manifest,view}.test.mjs`, `editor/test/view-host.mjs`, `editor/test/shared-modules.mjs`, `editor/test/fixtures/upper-gutter.mjs`, `files/test/manifest.test.mjs`, `flowmark/ui/view.test.mjs`, `hwp/test/hwp.test.mjs`, `shell/test/{manifest,view}.test.mjs`, `terminal/test/{census,manifest,terminal}.test.mjs`. 패키지 경로를 resolve하는 도우미: `flowmark/ui/view-host.mjs`(`require.resolve("@soksak/plugin-api")`), `editor/test/view-host.mjs`(설치된 SDK의 `view-start.js`를 읽음).

테스트 대상이 실행하는 빌드와 검사 명령: `editor/package.json:22-23`(`scripts.test`가 `build-vendor --check`와 `--import ./test/shared-modules.mjs`를 실행), `editor/Makefile:16-20`과 `terminal/Makefile:16-20`(`test`가 `pnpm exec soksak-exposure`, `soksak-engines`, `soksak-events --census`를 실행), `flowmark/Makefile:10-14`(`test`가 `soksak-engines`, `soksak-events`, `soksak-records`를 실행), `files/package.json`의 `scripts.test`가 `build-vendor --check`를 실행.

배포 파일: `flowmark/package.json`의 `files`는 `plugin.json`, `events.json`, `ui`다. 테스트 스크립트는 `node --test ui/`이므로 flowmark 테스트와 도우미가 배포 폴더 안에 있다.

`editor/ui/editor.js:5-12`와 `ui/vendor/libraries.js`는 `@soksak/shared/...`를 import한다. 테스트는 `test/shared-modules.mjs`의 hook으로 그 지정자를 resolve한다.

### 필요한 변경

1. SDK import를 리터럴 픽스처로 바꾼다. import map 픽스처는 뷰 import map의 네 항목과 그 대상을 명세가 적는 그대로 나열한다. `docs/spec/plugins.md`(Page 절, `origin/main:171`)에 같은 변경으로 대상 목록을 추가한다.
2. 뷰 브리지와 binder 가짜는 플러그인의 `test/fixtures/` 아래 플러그인 로컬 픽스처 모듈이다. 호스트 계약의 호출 이름만 구현한다. SDK 코드나 SDK 파일의 사본을 담지 않는다.
3. `editor`와 `flowmark`의 view-host 도우미는 SDK `view-start.js`를 실행하지 않는다. 페이지가 쓰는 시작 값의 플러그인 로컬 픽스처 `test/fixtures/view-start-fixture.js`를 읽는다. 빌드는 `--check`를 위해서만 SDK 파일을 `build/`로 복사하며 이 `--check`가 사본과 SDK 파일을 비교한다. 어떤 테스트도 그 사본을 실행하지 않는다.
4. flowmark는 테스트와 도우미를 `ui/`에서 `test/`로 옮기고, `package.json`의 `test` 스크립트를 `node --test test/`로 바꾼다. `ui/`에는 페이지 파일만 남아 테스트 코드가 `files` 목록에 들어가지 않는다.
5. `terminal/test/census.test.mjs`를 삭제한다(두 테스트 `:24`와 `:29` 모두). 플러그인 소스의 census는 `check` 대상(`soksak-events --census`)에서 실행한다. 프로브 사례는 `packages/plugin-api/test/events-check.test.mjs`(`:26`, `:147`, `:161`)가 다룬다.
6. `editor`와 `terminal`의 `test` 대상은 `pnpm test`만 남긴다. `soksak-exposure`, `soksak-engines`, `soksak-events`, `soksak-records` 줄은 `check` 대상으로 옮기고, `make test` 항목이 `pnpm test`보다 먼저 실행한다. `build-vendor --check` 단계는 `scripts.test`에서 `check`로 옮기며, `files`도 같다. 각 플러그인의 `test` 스크립트는 `node --test`만 실행한다.
7. `editor/test/editor.test.mjs`와 `editor/test/view.test.mjs`는 소스 트리가 아니라 빌드 결과를 실행한다. 빌드는 `ui/`의 `@soksak/shared` 지정자를 vendor 트리로 풀어 쓰고, 테스트는 그 파일을 상대 경로로 import한다. 이 빌드 변경이 들어가기 전까지 hook은 이름이 붙은 예외이며 자체 sub-item을 가진다. 조용히 유지하지 않는다. vendor 트리가 들어가면 `shared-modules.mjs`를 삭제한다.
8. `editor.test.mjs`는 `EditorView`를 npm `@codemirror/view`가 아니라 vendor 파일(`ui/vendor/...`)에서 가져온다. facet과 DOM 조회가 하나의 모듈 인스턴스를 쓰게 하기 위함이다. vendor 인스턴스를 검사하는 단언(`EditorView.darkTheme`, `findFromDOM`)은 의미를 유지한다.
9. `browser/test/page.test.mjs`는 `INTERACTIVE` import를 리터럴 상수 픽스처로 바꾼다. binder 계약은 `packages/plugin-api/test/binder.test.mjs`가 계속 검사한다.
10. 매니페스트와 진단 검증(`validateManifest`, `validateDiagnostics`)은 SDK 검증기로 플러그인 빌드에서 실행한다. 매니페스트 테스트는 빌드 결과를 읽고 값을 리터럴로 검사한다.
11. 각 플러그인 `test/`에 규칙 테스트를 둔다. `test/**` 아래의 파일과 `ui/**/*.test.mjs`가 `@soksak/` 지정자를 이름으로 가리키지 않음을 검사한다. `ui/` 구현 파일은 검사하지 않는다.
12. 명세: `docs/spec/plugins.md:40`("테스트를 위해 `@soksak/plugin-api`에 의존")은 "플러그인 저장소는 `@soksak/plugin-api`를 빌드 의존성으로만 두며, 빌드가 매니페스트를 검증하고 픽스처를 쓰는 데 쓴다"로 바꾼다. `docs/spec/plugins.md:171`("플러그인 저장소 테스트가 `checkViewPage`를 호출")은 "플러그인 빌드가 `checkViewPage`를 호출"로 바꾼다. 소유자는 core `main`이며 `.ko.md` 대응 문서도 함께 바꾼다.

### 범위 확인

제거되는 각 플러그인 단언은 core 테스트 또는 플러그인 픽스처 단언에 대응한다. 대응표는 테스트를 삭제하기 전에 sub-item에 쓴다. 플러그인 파일과 테스트 이름, 그리고 core 테스트 파일과 이름 또는 새 픽스처 단언을 한 행씩 적는다. 행이 없는 단언은 버리지 않는다.

### 범위 밖

픽스처 주석 문구, 정확한 픽스처 파일 이름(sub-item에서 정한다), `editor` vendor 트리 빌드 변경(자체 sub-item이며 소유자는 editor 저장소).

---

## D3. 선언된 이름으로 소유자를 분류한다

### 결정

소유자 감사(`scripts/check-test-parity.mjs`의 `packageOwner`)는 이름 접두사로 분류하지 않으며 이름 목록을 가지지 않는다. 소유자는 선언에서 얻는다.

1. core 이름은 `packages/*/package.json`과 `packages/host/*/package.json`의 `name`이다(`scripts/check-boundaries.mjs`의 `components()`가 만드는 집합).
2. 플러그인과 사이드카 이름은 `scripts/workspace-registry.json`이 선언한 폴더(`plugins`, `sidecars`)의 `package.json` `name`이다. `check-boundaries.mjs`와 같이 `scripts/workspace-registry.mjs`를 통해 읽는다. `package.json`이 없는 선언 폴더는 실패한다.
3. 참조는 두 세그먼트 기준(`@scope/name`)이 정확히 같을 때만 소유자와 일치한다. `@soksak/plugin-api-x`는 `@soksak/plugin-api`가 아니다.
4. `packages/**` 소스에 있는 `@soksak/plugin-*` 또는 `@soksak/sidecar-*` 형태의 패키지 이름이 core 이름도 선언된 이름도 아니면 감사가 실패한다. 다른 scope는 소유자가 아니며 분류하지 않는다. 선언되지 않은 평범한 플러그인 id는 탐지하지 않는다. `docs/spec/plugins.md`(Repositories)가 이 한계를 적는다.
5. `packages/**` 아래 픽스처는 `@scope/` 형태를 쓴다. 이미 있는 `@soksak/sidecar-vt` 픽스처는 같은 변경에서 이름을 바꾼다(필요한 변경 참조).

### 주장

- 접두사는 계약이 아니다. `docs/spec/plugins.md`는 GitHub 저장소 이름을 적고 npm 이름 규칙은 적지 않는다. core의 접두사는 core 안의 플러그인 지식이며 경계 규칙이 금하는 것이다.
- 선언 집합은 이미 있고 `check-boundaries.mjs`가 이미 읽는다(`origin/main:scripts/check-boundaries.mjs:27-40`). 이를 재사용하면 저장소 간 새 읽기가 추가되지 않는다.
- `startsWith` 접두사 검사는 `@soksak/plugin-api-x`를 플러그인으로 분류한다. 정확 일치는 그렇지 않다.

### 근거

- `origin/main:scripts/check-test-parity.mjs:4514-4522`: `packageOwner`에 core 리터럴 `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`(`:4516`), 플러그인 이름 목록 `@soksak/plugin-browser`, `@soksak/plugin-files`, `@soksak/plugin-shell`, `@soksak/plugin-terminal`(`:4517-4519`), 사이드카 이름 목록 `@soksak/sidecar-files`, `@soksak/sidecar-shell`, `@soksak/sidecar-vt-alacritty`, `@soksak/sidecar-vt-core`(`:4520-4522`). 같은 리터럴과 접두사 검사가 `fix/decouple-F236:scripts/check-test-parity.mjs:4482-4491`(`:4484-4486`)에도 있다.
- `origin/main:scripts/check-boundaries.mjs:27-40`은 `packages/`, `packages/host/`와 선언 폴더에서 `workspace-registry.mjs`를 거쳐 components를 만든다.
- `origin/main:scripts/workspace-registry.json`은 플러그인 `browser, editor, files, hwp, terminal`과 사이드카 `files`, `vt-alacritty`를 선언한다.
- `origin/main:docs/spec/plugins.md:34`는 플러그인을 `browser, terminal, files`와 `shell`로 적는다. 이 목록은 registry와 다르며 필요한 변경에서 고친다.
- 선언되지 않아 rule 4에 걸리는 기존 `@soksak/sidecar-vt` 픽스처: `origin/main:packages/workbench/test/library-plugins.test.mjs:35`(`name: "@soksak/sidecar-vt"`), `:98`(`"사이드카 @soksak/sidecar-vt 0.1.2"`), `origin/main:packages/workbench/test/plugin-operations.test.mjs:63`(`const vt = "@soksak/sidecar-vt"`).
- core에 이미 있는 `@scope/sidecar-probe` 픽스처: `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### 필요한 변경

1. `scripts/check-test-parity.mjs`: core 리터럴 세 개, 플러그인 이름 목록, 사이드카 이름 목록, 접두사 분기를 제거한다(`main`의 `:4514-4522`, `fix/decouple-F236`의 `:4484-4486`). `packageOwner`는 core 패키지와 선언 폴더(`workspace-registry.mjs` 경유)로 만든 두 집합에서 이름을 찾는다. `package.json`이 없는 선언 폴더는 명시적 메시지로 실패한다. `main` 변경과 `fix/decouple-F236` 변경은 별도 커밋이며, 브랜치 변경은 `main` 변경 위에 적용된다.
2. 4번 규칙을 같은 함수에 구현한다. 선언되지 않은 `@soksak/plugin-*` 또는 `@soksak/sidecar-*` 이름은 파일, 줄, 이름과 함께 실패한다.
3. `library-plugins.test.mjs`(`:35`, `:98`)와 `plugin-operations.test.mjs`(`:63`)의 `@soksak/sidecar-vt`를 `@scope/sidecar-vt`로 바꾼다. 이 테스트는 실제 사이드카를 검사하지 않으므로 선언된 이름 `@soksak/sidecar-vt-alacritty`를 쓰지 않는다.
4. `scripts/test/`의 테스트가 다음을 다룬다. 정확 일치(`@soksak/plugin-api-x`는 소유자가 아님), `packages/**`의 선언되지 않은 `@soksak/plugin-foo`는 실패, core 구현의 선언된 플러그인 이름은 실패, 이름을 바꾼 `@scope/sidecar-vt` 픽스처는 통과, `package.json`이 없는 선언 폴더는 실패. 현재 코드에서 Red여야 한다. 접두사 분기가 선언 검사 없이 `@soksak/plugin-foo`를 소유자로 분류하기 때문이다.
5. `docs/spec/plugins.md:34`(Repositories)를 registry의 목록으로 고치고(선언된 플러그인은 `browser, editor, files, hwp, terminal`, 선언되지 않은 저장소는 따로 적는다), 문장을 추가한다. core는 플러그인이나 사이드카 이름을 적지 않으며, 소유자는 선언된 폴더이고, 선언되지 않은 평범한 플러그인 id는 탐지하지 않는다. 소유자는 core `main`이며 `.ko.md`도 바꾼다.

### 범위 밖

`check-test-parity.mjs`의 lane과 개수 행(개수는 편집을 하는 변경에서 `make parity-check`로 바뀐다).

---

## 라운드 기록

### 라운드 1

감사자: 새 Haiku 하위 에이전트 2개가 두 결정과 근거를 받았다. 두 감사자 모두 실질적 이의를 보고했다. 각 이의는 파일과 대조했으며 답변은 다음과 같다.

- D1 view-start 사본이 SDK 코드를 실행한다(감사자 2, D1-A): 수용. 필요한 변경 3은 플러그인 로컬 픽스처를 읽도록 바꾸고, 사본은 `--check`로만 비교한다.
- D1 flowmark 테스트가 배포되는 `ui/` 폴더에 있다(감사자 1 D1-1, 감사자 2): 수용. flowmark 이동은 필요한 변경 4다.
- D1 editor shared-module hook과 npm `@codemirror/view` 인스턴스(감사자 2 D1-B): 수용. hook은 sub-item을 가진 이름 붙은 예외이며, 테스트는 vendor 파일을 import한다(필요한 변경 7, 8).
- D1 `check` 대상이 SDK 검증기를 여전히 실행한다(감사자 2 D1-C): 수용. 필요한 변경 6이 줄을 든다(`editor/Makefile:16-20`, `terminal/Makefile:16-20`, `flowmark/Makefile:10-14`).
- D1 census 두 번째 테스트와 `INTERACTIVE` import(감사자 2 D1-D): 수용. 필요한 변경 5와 9.
- D1 대응표 누락(감사자 1 D1-2): 수용. 범위 확인 절이 삭제 전에 대응표를 요구한다.
- D3 픽스처 인용이 틀렸다. `library-plugins.test.mjs:98`에 `@scope/sidecar-probe`가 없다(감사자 1 D3-1, 감사자 2 D3-A): 수용. 인용을 고치고 실제 `@soksak/sidecar-vt` 픽스처 세 개의 이름을 바꾼다(필요한 변경 3).
- D3 `main` 목록을 조건부로 적었다(감사자 2 D3-B): `origin/main:4514-4522`에 있음을 확인했으므로 있다고 적는다.
- D3 명세가 registry와 다르게 `shell`을 적는다(감사자 2 D3-C): 수용. 필요한 변경 5.

상태: 라운드 2 대기. 라운드 2 감사자는 이 수정본을 받는다.
