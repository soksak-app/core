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

플러그인 저장소의 테스트는 `@soksak/*` 이름(SDK `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`, 공용 키트, 사이드카)을 import하거나 resolve하지 않고, 설치된 패키지 경로를 읽지 않는다. 플러그인 테스트는 그 플러그인의 코드, 매니페스트, 픽스처를 검사한다.

`ui/` 아래의 구현 모듈은 페이지가 import map으로 적재하므로 `@soksak/*` 지정자를 그대로 둔다. 테스트는 `ui/` 소스를 import하지 않는다. 빌드는 테스트 트리(`build/test/`)를 쓴다. 이 트리는 `ui/`를 복사하고 각 `@soksak/*` 지정자를 플러그인 로컬 픽스처(페이지가 쓰는 SDK 함수의 소비자 경계 가짜) 또는 `plugin.json`이 이름 붙인 vendor 파일로 바꾼다. 테스트는 이 트리, 플러그인 로컬 픽스처, `devDependencies`에 선언된 제3자 공개 패키지만 import한다.

명령 분리: `make test`는 `pnpm test`(`node --test`)만 실행한다. `make check`는 SDK를 읽는 도구(`soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`)와 `build-vendor --check`를 실행한다. `make pack`과 CI는 `make check`에 의존한다. 빌드와 검사 스크립트(테스트가 아님)는 SDK 검증기를 호출하고 `VIEW_IMPORTS`를 읽을 수 있다.

### 주장

- 규칙은 테스트가 다른 패키지의 SDK나 구현을 읽는 것을 금한다. SDK는 형식과 뷰 브리지를 core에서 이미 검사한다: `packages/plugin-api/test/view-page.test.mjs`(`checkViewPage`), `view.test.mjs`(`createViewBridge`), `binder.test.mjs`(`createBinder`), `view-imports.test.mjs`(`VIEW_IMPORTS`), `view-core-targets.test.mjs`, 그리고 `events-check.test.mjs`(census 발견 사항, `:26`, `:147`, `:161`).
- `ui/` 소스를 import하는 테스트는 그 소스를 통해 SDK를 resolve한다. 테스트에 보이는 지정자를 다시 쓰는 것이 SDK 코드를 테스트 실행에서 빼는 유일한 방법이며, 다시 쓰기는 규칙이 허용하는 빌드 단계다.
- 호스트 계약에 맞춘 플러그인 로컬 픽스처는 소비자 경계에서 플러그인을 검사하며 SDK 코드를 담지 않는다.

### 근거(형제 `../plugins/*`, `main` 브랜치)

`@soksak/*`를 import하거나 resolve하는 테스트 파일(20개): `appview/test/manifest.test.mjs`; `browser/test/{address-input,empty-state,manifest,page}.test.mjs`(`page.test.mjs:5`가 `INTERACTIVE`를 import); `editor/test/{editor,manifest,view}.test.mjs`(`editor.test.mjs:6`이 `createBinder`를 import, `:184`와 `:198`이 `@soksak/shared` 지정자를 이름으로 가리킴); `editor/test/view-host.mjs`; `editor/test/shared-modules.mjs`; `editor/test/fixtures/upper-gutter.mjs:2`(`@soksak/shared/editor.extension/@codemirror/view.js` import); `files/test/manifest.test.mjs`; `flowmark/ui/view.test.mjs`; `hwp/test/hwp.test.mjs`; `shell/test/{manifest,view}.test.mjs`; `terminal/test/{census,manifest,terminal}.test.mjs`(`terminal.test.mjs:4`이 `@soksak/plugin-api`를 import).

SDK import를 거쳐 테스트가 적재하는 구현 모듈(간접): `terminal/ui/terminal.js:1-2`(`@soksak/plugin-api`, `@soksak/plugin-api/screen-hash`), `terminal/test/terminal.test.mjs:6`이 적재; `browser/ui/sections/tabs.js:3`과 `history.js:3`(`drawList`), `browser/test/section-lists.test.mjs:22`가 적재; `files/ui/sections/tree-horizontal.js:2`, `files/test/section-lists.test.mjs:43`이 적재; `editor/ui/view.js:7-8`과 `flowmark/ui/view.js:7`, `editor/test/view.test.mjs`와 `flowmark/ui/view.test.mjs`가 적재.

resolver hook: `editor/test/shared-modules.mjs:4-18`(`registerHooks`, `POINT` `@soksak/shared/editor.extension/`), `editor/package.json:23`이 `--import`로 실행. SDK를 resolve하거나 읽는 도우미: `flowmark/ui/view-host.mjs`(`require.resolve("@soksak/plugin-api")`), `editor/test/view-host.mjs`(설치된 SDK의 `view-start.js`를 읽음).

`make test` 안에서 SDK 도구를 실행하는 Makefile 대상: `editor/Makefile:16-20`과 `terminal/Makefile:16-20`(`soksak-exposure`, `soksak-engines`, `soksak-events --census`); `flowmark/Makefile:10-14`(`soksak-engines`, `soksak-events`, `soksak-records`). `build-vendor --check`는 `editor/package.json:22`와 `files/package.json`의 `scripts.test`에서 실행된다.

배포 파일: `flowmark/package.json`의 `files`는 `plugin.json`, `events.json`, `ui`이며, 테스트 스크립트는 `node --test ui/`다.

### 필요한 변경

1. 테스트 트리 빌드: `build/test/`는 플러그인 빌드가 쓴다. `ui/`와 `test/fixtures/`를 복사하고, 모든 `@soksak/*` 지정자를 플러그인 로컬 픽스처 모듈(페이지가 쓰는 SDK 이름에 대해) 또는 `plugin.json`의 `extends.extension.modules`가 이름 붙인 vendor 파일로 바꾼다. 테스트는 `build/test/`를 상대 경로로 import한다. 픽스처는 호스트 호출 이름과 페이지가 호출하는 SDK 함수를 구현하며 SDK 코드를 담지 않는다.
2. 테스트 규칙: 각 플러그인 `test/`의 테스트는 찾을 문자열을 조각으로 만든다(예: `"@" + "soksak/"`). 그래야 자기 소스와 일치하지 않는다. 이 테스트는 `test/**`의 모든 파일과 `ui/**/*.test.mjs`에 `@soksak/` 지정자가 없음을 검사한다. 테스트가 import하는 `ui/` 코드는 빌드 결과뿐이다.
3. resolver hook: `editor/test/shared-modules.mjs`는 변경 1의 테스트 트리가 들어가면 삭제하며, `editor/package.json:23`의 `--import`도 뺀다. 그 전까지 hook은 이름이 붙은 예외이며 자체 sub-item과 소유자(editor 저장소)를 가진다. 조용히 유지하지 않는다.
4. `editor/test/editor.test.mjs:184`와 `:198`, `editor/test/fixtures/upper-gutter.mjs:2`는 테스트 트리를 통해 vendor 파일을 import한다. 각 단언은 의미를 유지한다.
5. `editor/test/view-host.mjs`와 `flowmark/ui/view-host.mjs`는 `build/test/` 또는 시작 값의 픽스처를 적재하며 설치된 SDK를 읽지 않는다. 빌드는 `test/fixtures/view-start-fixture.js`를 쓰고, `--check`는 SDK `view-start.js`를 픽스처가 기록한 해시와 비교한다.
6. flowmark는 테스트와 도우미를 `ui/`에서 `test/`로 옮기고, `test` 스크립트를 `node --test test/`로 바꾼다. `ui/`에는 페이지 파일만 배포한다.
7. `terminal/test/census.test.mjs`를 삭제한다(`:24`와 `:29`). 플러그인 소스의 census는 `make check`에서 실행한다. 프로브 사례는 `packages/plugin-api/test/events-check.test.mjs`(`:26`, `:147`, `:161`)가 다룬다.
8. `make test`는 `pnpm test`만 실행한다. `make check`는 `soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`, `build-vendor --check`를 실행한다. `make pack`과 CI는 `make check`에 의존한다. `editor/package.json:22-23`과 `files/package.json`의 `scripts.test`는 `node --test`만 남긴다.
9. `browser/test/page.test.mjs:5`의 `INTERACTIVE` import를 리터럴 상수 픽스처로 바꾼다. binder 계약은 `packages/plugin-api/test/binder.test.mjs`가 계속 검사한다.
10. 매니페스트와 진단 검증은 플러그인 빌드에서 SDK 검증기로 실행한다. 매니페스트 테스트는 빌드 결과를 읽고 값을 리터럴로 검사한다.
11. 명세: `docs/spec/plugins.md:40`의 "`make test`가 플러그인 저장소의 테스트를 실행"과 "테스트를 위해 `@soksak/plugin-api`에 의존"을 다음으로 바꾼다. `make test`는 플러그인 테스트를 실행하고, `make check`는 SDK 도구를 실행하며, 플러그인 저장소는 `@soksak/plugin-api`를 빌드 의존성으로만 둔다. `docs/spec/plugins.md:171`("플러그인 저장소 테스트가 `checkViewPage`를 호출")은 "플러그인 빌드가 `checkViewPage`를 호출"로 바꾼다. 소유자는 core `main`이며 `.ko.md` 대응 문서도 함께 바꾼다.

### 범위 확인

제거되는 각 플러그인 단언은 core 테스트 또는 플러그인 픽스처 단언에 대응한다. 대응표는 테스트를 삭제하기 전에 sub-item에 쓴다. 플러그인 파일과 테스트 이름, 그리고 core 테스트 파일과 이름 또는 새 픽스처 단언을 한 행씩 적는다. 행이 없는 단언은 버리지 않는다.

### 범위 밖

픽스처 주석 문구와 정확한 픽스처 파일 이름(sub-item에서 정한다). 변경 1의 테스트 트리 변경은 자체 sub-item이며 소유자는 editor와 flowmark 저장소다.

---

## D3. 선언된 이름으로 소유자를 분류한다

### 결정

`@soksak/plugin-*`와 `@soksak/sidecar-*` 이름 규칙은 `scripts/check-boundaries.mjs`로 옮긴다. 이 스크립트는 이미 선언된 폴더를 읽고, 헤더에서 core가 플러그인이나 사이드카 이름을 적지 않는다고 밝힌다. `scripts/check-test-parity.mjs`는 경로 기준 소유자 루트만 유지하며 더는 이름을 분류하지 않는다.

1. core 이름은 `packages/*/package.json`과 `packages/host/*/package.json`의 `name`이다(`check-boundaries.mjs`의 `components()`).
2. `packages/**` 소스에 있는 `@soksak/plugin-*` 또는 `@soksak/sidecar-*` 패키지 이름이 core 이름이 아니면, 선언되었는지와 관계없이 검사가 실패한다. 선언된 집합은 면제가 아니다.
3. 참조는 두 세그먼트 기준(`@scope/name`)이 정확히 같을 때 일치한다. `@soksak/plugin-api-x`는 `@soksak/plugin-api`가 아니다.
4. 다른 scope는 소유자가 아니며 분류하지 않는다. 선언되지 않은 평범한 플러그인 id는 탐지하지 않는다. `docs/spec/plugins.md`(Repositories)가 이 한계를 적는다(변경 5).
5. core 테스트 픽스처는 `@scope/`를 쓴다. 이미 있는 `@soksak/sidecar-vt` 픽스처는 이름을 바꾼다.
6. `-example` 절은 제거한다. `@soksak/sidecar-example` 같은 이름은 면제가 아니며, 그 형태의 픽스처가 `packages/**` 아래 있으면 2번 규칙으로 실패한다.

### 주장

- 접두사는 계약이 아니다. `docs/spec/plugins.md`는 GitHub 저장소 이름을 적고 npm 이름 규칙은 적지 않는다. core의 목록은 core 안의 플러그인 지식이며 경계 규칙이 금하는 것이다.
- `check-boundaries.mjs`는 이미 선언된 폴더의 `package.json` 이름과 `plugin.json` id를 읽고(`origin/main:scripts/check-boundaries.mjs:27-40`), 헤더에 규칙을 적는다. 이름 규칙을 여기에 두면 저장소 간 새 읽기가 추가되지 않는다. `check-test-parity.mjs`에 두면 새 읽기가 생기므로 그곳에 두지 않는다.
- 2번 규칙은 면제를 위해 선언 집합이 필요하지 않다. core의 선언된 이름도 선언되지 않은 이름과 같은 규칙으로 거부된다.
- `startsWith`는 `@soksak/plugin-api-x`를 플러그인으로 분류한다. 두 세그먼트 기준의 정확 일치는 그렇지 않다.

### 근거

- `origin/main:scripts/check-test-parity.mjs:4514-4522`: `packageOwner`에 core 리터럴 `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`(`:4516`), 플러그인 목록 `:4517-4519`와 `base.endsWith("-example")`(`:4517`), 사이드카 목록 `:4520-4522`와 `base.endsWith("-example")`(`:4520`). `fix/decouple-F236:scripts/check-test-parity.mjs:4482-4491`에는 접두사 분기가 `:4484-4486`에 있다.
- `origin/main:scripts/check-boundaries.mjs:1-5`(헤더: core가 플러그인이나 사이드카를 적지 않는다). `:27-40`(`packages/`, `packages/host/`와 선언된 폴더에서 `workspace-registry.mjs`를 거쳐 `components()`를 만든다).
- `origin/main:scripts/test/test-parity.test.mjs:195-204`는 이름 분류에서 나온 `@soksak/sidecar-example`의 "sidecar" 오류를 단언한다. `:215-218`은 `@soksak/sidecar-example/src/private.js`의 "private" 오류를 단언한다. 이 이름 단언은 이름 규칙과 함께 옮긴다.
- `origin/main:scripts/workspace-registry.json`은 플러그인 `browser, editor, files, hwp, terminal`과 사이드카 `files`, `vt-alacritty`를 선언한다.
- `origin/main:docs/spec/plugins.md:34`는 플러그인을 `browser, terminal, files`와 `shell`로 적는다. registry와 다르며 변경 5에서 고친다.
- 선언되지 않은 `@soksak/sidecar-vt` 픽스처: `origin/main:packages/workbench/test/library-plugins.test.mjs:35`와 `:98`; `origin/main:packages/workbench/test/plugin-operations.test.mjs:63`. core에 이미 있는 `@scope/sidecar-probe` 픽스처: `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### 필요한 변경

1. `scripts/check-boundaries.mjs`: `components()`를 export하고, 2번과 3번 규칙을 구현하는 순수 함수 `checkNames(components, files)`를 export한다. 최상위 실행은 그대로 둔다. 이 검사는 이미 선언된 형제 매니페스트를 읽는 `make boundaries` lane에서 실행한다.
2. `scripts/check-test-parity.mjs`(`main`의 `:4514-4522`; `fix/decouple-F236`의 `:4482-4491`): `packageOwner`의 이름 분류(core 리터럴, 플러그인과 사이드카 목록, `-example`과 접두사 분기)를 제거한다. 경로 기준 소유자 루트(`OWNER_ROOTS`)는 유지한다. `main` 변경과 `fix/decouple-F236` 변경은 별도 커밋이다.
3. `scripts/test/test-parity.test.mjs:195-218`의 이름 단언을 주입된 파일 집합을 쓰는 `check-boundaries.mjs` 테스트로 옮긴다. 경로 기준 단언은 남긴다.
4. `library-plugins.test.mjs:35,98`과 `plugin-operations.test.mjs:63`의 `@soksak/sidecar-vt` 픽스처를 `@scope/sidecar-vt`로 바꾼다. 이 테스트들은 실제 사이드카를 검사하지 않는다.
5. `docs/spec/plugins.md:34`(Repositories)를 registry 목록으로 고친다(선언된 플러그인 `browser, editor, files, hwp, terminal`, 선언되지 않은 저장소는 따로 적는다). 같은 절에 다음을 추가한다: core는 플러그인이나 사이드카 이름을 적지 않는다. 선언되지 않은 평범한 플러그인 id는 탐지하지 않는다. 소유자는 core `main`이며 `.ko.md`도 바꾼다.
6. `checkNames`의 `scripts/test/` 테스트: 두 세그먼트 기준 정확 일치(`@soksak/plugin-api-x`는 소유자가 아님). `packages/**`의 선언되지 않은 `@soksak/plugin-foo`는 실패. `packages/**`의 `@soksak/sidecar-vt-alacritty` 같은 선언된 이름도 실패. `@soksak/sidecar-example`은 실패. `@scope/sidecar-vt`는 통과. core의 `@soksak/plugin-api`는 통과. 현재 코드에서 Red여야 한다. `packageOwner`가 `-example` 이름을 면제하고 `@soksak/plugin-foo`를 접두사로 분류하기 때문이다.

### 범위 밖

`check-test-parity.mjs`의 lane과 개수 행(개수는 이 파일을 고치는 변경에서 `make parity-check`로 바뀐다).

---

## 라운드 기록

### 라운드 1

감사자: 새 Haiku 하위 에이전트 2개. 이의와 답변은 커밋된 기록의 라운드 1 절에 있다.

### 라운드 2

감사자: 수정된 텍스트를 받은 새 Haiku 하위 에이전트 2개. 둘 다 실질적 이의를 보고했다. 각 이의는 파일과 대조했으며 다음과 같이 답했다.

- D1 `ui/` 모듈을 통한 SDK의 간접 resolve(감사자 A, D1-A): 수용. 변경 1이 지정자를 다시 쓴 테스트 트리를 만들고, 테스트 규칙은 변경 2다.
- D1 `make test`가 SDK 도구를 실행(감사자 A, D1-B): 수용. 변경 8이 `make test`와 `make check`를 나눈다.
- D1 규칙 테스트가 자기 자신과 일치(감사자 A, D1-C; 감사자 B, O1): 수용. 변경 2는 찾을 문자열을 조각으로 만들며 제외 규칙이 없다.
- D1 editor 지정자와 공용 모듈 hook(감사자 B, O1-O2): 수용. 현재 테스트가 npm `@codemirror/view`를 쓴다는 전제는 틀렸다. 현재 테스트는 `plugin.json`을 통해 vendor 파일을 resolve한다. 빌드 출력 경로는 변경 1에 적었고, hook은 소유자를 가진 예외다(변경 3).
- D1 `ui/` 빌드 출력이 없다(감사자 B, O3): 수용. 변경 1이 출력 경로 `build/test/`를 적는다.
- D3 규칙 4와 테스트 4의 모순(감사자 B, O4): 수용. 2번 규칙은 선언되었거나 선언되지 않은 이름에 같게 적용되며, 선언된 집합은 면제가 아니다.
- D3 `check-test-parity`의 새 저장소 간 읽기(감사자 B, O5): 수용. 이름 규칙은 이미 선언된 폴더를 읽는 `check-boundaries.mjs`로 옮긴다.
- D3 명세 문장이 아직 없다(감사자 B, O6): 수용. 결정은 "적는다"로 쓰고 변경 5가 문장을 추가한다.
- D3 `-example` 절과 그 단언(감사자 A, D3-A): `origin/main:4517,4520`과 `test-parity.test.mjs:195-218`에서 확인했다. 수용하여 변경 3과 규칙 6에 넣었다.

상태: 라운드 3 대기. 라운드 3 감사자는 이 텍스트를 받는다.
