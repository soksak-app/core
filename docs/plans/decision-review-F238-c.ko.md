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

플러그인 저장소의 테스트는 `@soksak/*` 이름(SDK `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`, 공용 키트, 사이드카)을 import하거나 resolve하지 않고, 설치된 패키지 경로를 읽지 않으며, SDK 코드의 사본을 적재하지 않는다. 플러그인 테스트는 그 플러그인의 코드, 매니페스트, 픽스처를 검사한다.

`ui/` 아래의 구현 모듈은 페이지가 import map으로 적재하므로 `@soksak/*` 지정자를 그대로 둔다. 테스트는 `ui/` 소스를 import하지 않는다. 플러그인 빌드는 테스트 트리(`build/test/`)를 쓴다. 이 트리는 `ui/`를 복사하고 각 `@soksak/*` 지정자를 플러그인이 작성한 픽스처 모듈(페이지가 쓰는 SDK 함수의 소비자 경계 가짜이며 SDK 코드를 담지 않는다) 또는 `plugin.json`이 이름 붙인 vendor 파일로 바꾼다. 테스트는 이 트리, 플러그인이 작성한 픽스처, `devDependencies`에 선언된 제3자 공개 패키지만 import한다.

각 플러그인의 `test` 스크립트는 테스트 트리 빌드를 먼저 실행한다(`node scripts/build-test.mjs && node --test test/`). 그래서 새 체크아웃도 테스트 전에 빌드된다.

SDK 동작은 소유 패키지에서만 검사한다. 플러그인 테스트가 SDK 값을 단언하거나 SDK 함수를 import하면 그 단언은 소유 core 테스트로 옮기고, 플러그인은 리터럴 상수나 가짜를 쓴다.

명령 분리: `make test`는 플러그인 테스트 스크립트만 실행한다. `make check`는 SDK를 읽는 도구(`soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`), check 스크립트에 기록된 상수와 SDK `view-start.js`의 SHA-256을 비교하는 검사, `build-vendor --check`, 테스트 픽스처가 담은 `VIEW_IMPORTS` 항목의 리터럴 일치 검사를 실행한다. 빌드와 검사 스크립트(테스트가 아님)는 SDK 검증기를 호출하고 `VIEW_IMPORTS`를 읽을 수 있다.

결정은 각 플러그인 저장소에서 그 저장소의 sub-item이 들어갈 때 효력을 가진다. 그 전까지 현재 형태는 준수가 아니라 소유자가 있는 열린 결함으로 기록한다.

### 주장

- 규칙은 테스트가 다른 패키지의 SDK나 구현을 읽는 것을 금한다. SDK는 형식과 뷰 브리지를 core에서 이미 검사한다: `packages/plugin-api/test/view-page.test.mjs`(`checkViewPage`), `view.test.mjs`(`createViewBridge`), `binder.test.mjs`(`createBinder`), `view-imports.test.mjs`(`VIEW_IMPORTS`), `view-core-targets.test.mjs`, `events-check.test.mjs`(census 발견 사항, `:26`, `:147`, `:161`), 그리고 `packages/log-contract/test/screen-hash.test.mjs`(화면 해시 계약).
- `ui/` 소스를 import하는 테스트는 그 소스를 통해 SDK를 resolve한다. 빌드 출력에서 테스트에 보이는 지정자를 다시 쓰는 것이 SDK 코드를 테스트 실행에서 빼는 유일한 방법이며, 이는 규칙이 허용하는 빌드 단계다.
- SDK 파일이나 그 사본을 담은 테스트 픽스처는 테스트 실행에서 SDK 코드를 실행한다. 따라서 어떤 픽스처도 SDK 바이트를 담지 않는다. 픽스처는 `make check`가 SDK와 비교하는 리터럴 값을 담을 수 있다.

### 근거(형제 `../plugins/*`, `main` 브랜치)

`@soksak/plugin-api`를 테스트나 테스트 도우미에서 import하는 파일(17개): `appview/test/manifest.test.mjs`; `browser/test/{address-input,empty-state,manifest,page}.test.mjs`(`page.test.mjs:5`가 `INTERACTIVE`를 import, `address-input:5`와 `empty-state:5`가 `createBinder`를 import); `editor/test/{editor,view,manifest}.test.mjs`(`editor.test.mjs:6`이 `createBinder`를 import, `view.test.mjs:7`이 `VIEW_IMPORTS`와 `checkViewPage`를 import); `editor/test/view-host.mjs`; `files/test/manifest.test.mjs`; `hwp/test/hwp.test.mjs:6`(`createBinder`를 import); `shell/test/{manifest,view}.test.mjs`(`view.test.mjs:7`이 `VIEW_IMPORTS`와 `checkViewPage`를 import); `terminal/test/{census,manifest,terminal}.test.mjs`(`terminal.test.mjs:4`가 `createBinder`를 import); `flowmark/ui/view.test.mjs:7`(`VIEW_IMPORTS`와 `checkViewPage`를 import).

`@soksak/shared` 지정자를 import하는 테스트 파일: `editor/test/editor.test.mjs:184`와 `:198`; `editor/test/fixtures/upper-gutter.mjs:2`(`@soksak/shared/editor.extension/@codemirror/view.js`); `editor/test/shared-modules.mjs`.

SDK import를 거쳐 테스트가 적재하는 구현 모듈(간접): `terminal/ui/terminal.js:1-2`(`@soksak/plugin-api`, `@soksak/plugin-api/screen-hash`), `terminal/test/terminal.test.mjs:6`이 적재; `browser/ui/sections/tabs.js:3`과 `history.js:3`(`drawList`), `browser/test/section-lists.test.mjs:22`가 적재; `files/ui/sections/tree-horizontal.js:2`, `files/test/section-lists.test.mjs:43`이 적재; `editor/ui/view.js:7-8`과 `flowmark/ui/view.js:7`, `editor/test/view.test.mjs`와 `flowmark/ui/view.test.mjs`가 적재.

플러그인 테스트의 SDK 값 단언: `terminal/test/terminal.test.mjs:3874-3885`(SDK 골든 벡터 해시 `vector.hash`)와 `:3909-3911`(변경된 메시지의 해시가 다름). 이는 SDK 계약 검사이므로 `packages/log-contract/test/screen-hash.test.mjs`로 옮긴다.

플러그인 호스트가 적재하는 SDK 바이트: `packages/plugin-api/view-start.js:1-12`는 주입되는 시작 스크립트다. `editor/test/view-host.mjs:14`와 `flowmark/ui/view-host.mjs:13`이 이를 읽고 창에서 실행한다.

resolver hook: `editor/test/shared-modules.mjs:4-18`(`registerHooks`, `POINT` `@soksak/shared/editor.extension/`), `editor/package.json:23`이 `--import`로 실행.

`make test` 안에서 SDK 도구를 실행하는 Makefile 대상: `editor/Makefile:16-20`과 `terminal/Makefile:16-20`(`soksak-exposure`, `soksak-engines`, `soksak-events --census`); `flowmark/Makefile:10-14`(`soksak-engines`, `soksak-events`, `soksak-records`). `build-vendor --check`는 `editor/package.json:22`와 `files/package.json`의 `scripts.test`에서 실행된다.

CI: `ci.yml:23`이 `appview`, `browser`, `editor`, `files`, `hwp`, `shell`, `terminal`에서 `make test`를 실행한다. 릴리스 워크플로(`release.yml`)는 `appview`, `browser`, `editor`, `files`, `hwp`, `terminal`에 있다. `shell`에는 릴리스 워크플로가 없다. `flowmark`에는 `.github` 폴더가 없다.

빌드 스크립트: `browser`, `appview`, `shell`, `terminal`, `flowmark`에는 `build` 스크립트가 없다. `editor`와 `files`에는 `build-vendor`만 실행하는 스크립트가 있다.

배포 파일: `flowmark/package.json`의 `files`는 `plugin.json`, `events.json`, `ui`이며, 테스트 스크립트는 `node --test ui/`다.

### 필요한 변경

1. 테스트 트리 빌드: 각 플러그인에 `scripts/build-test.mjs`를 두어 `build/test/`를 쓴다. `ui/`를 복사하고, 모든 `@soksak/*` 지정자를 플러그인이 작성한 픽스처 모듈(페이지가 쓰는 SDK 이름을 호스트 호출 이름으로 구현하며 SDK 코드는 없다) 또는 `plugin.json` `extends.extension.modules`가 이름 붙인 vendor 파일로 바꾼다. 플러그인의 `test` 스크립트는 이를 먼저 실행한 뒤 `node --test test/`를 실행한다. 소유자: 각 플러그인 저장소, 저장소마다 sub-item 하나.
2. 테스트 규칙: 각 플러그인 `test/`의 테스트는 찾을 문자열을 조각으로 만든다(예: `"@" + "soksak/"`). 그래야 자기 소스와 일치하지 않는다. 규칙은 `test/**`의 줄과 `ui/**/*.test.mjs`의 줄이 플러그인이 담은 표식 목록(`@soksak/` 찾을 문자열과 `view-start.js`의 첫 줄)의 어떤 줄과도 같지 않음을 단언한다. 이 테스트는 SDK 파일을 읽지 않는다. `view-start.js`의 SHA-256 비교는 설치된 패키지를 읽어도 되는 `make check`에서만 실행한다.
3. resolver hook: `editor/test/shared-modules.mjs`는 변경 1의 테스트 트리가 들어가면 삭제하며, `editor/package.json:23`의 `--import`도 뺀다. 그 전까지 hook은 소유자(editor 저장소)가 있는 열린 결함이다.
4. `editor/test/editor.test.mjs:184`와 `:198`, `editor/test/fixtures/upper-gutter.mjs:2`는 테스트 트리를 통해 vendor 파일을 import한다. 각 단언은 의미를 유지한다.
5. 뷰 호스트 픽스처(`editor/test/view-host.mjs`, `flowmark/ui/view-host.mjs`)는 `packages/plugin-api/view-start.js`를 읽거나 실행하지 않는다. `docs/spec/plugins.md:171`이 이름 붙인 시작 값(`window.sokSurface` `{surface, params, origin, project, declarations}`)의 플러그인 작성 리터럴과 플러그인이 쓴 `sokView` 스텁을 쓴다. `test/`에는 SDK 파일을 쓰지 않는다. `view-start.js`의 브리지 동작은 `packages/plugin-api/test/view.test.mjs`만 검사한다.
6. `terminal/test/terminal.test.mjs:3874-3885`와 `:3909-3911`의 골든 벡터와 변경 메시지 단언은 `packages/log-contract/test/screen-hash.test.mjs`로 옮긴다. 이 파일은 이미 화면 해시 계약을 가진다. terminal에서는 변경 1이 `ui/terminal.js`의 `@soksak/plugin-api/screen-hash`를 플러그인 작성 가짜 `screenHash`로 다시 쓰며, 플러그인 테스트는 그 결과를 리터럴 상수로 단언한다.
7. 플러그인 테스트의 직접 SDK import(라운드 4 목록의 변경 13을 여기에 적용): 위 17개 파일의 모든 `@soksak/*` import를 뺀다.
   - `createBinder` 사용처(`editor/test/editor.test.mjs:6`, `browser/test/address-input.test.mjs:5`, `browser/test/empty-state.test.mjs:5`, `hwp/test/hwp.test.mjs:6`, `terminal/test/terminal.test.mjs:4`)는 `build/test/`의 다시 쓴 binder 픽스처를 import한다. binder 계약에 관한 각 단언은 `packages/plugin-api/test/binder.test.mjs`로 가는 범위 확인 행을 가진다. 플러그인 자체의 binder 연결을 검사하는 단언은 픽스처 기반 단언으로 남긴다.
   - `VIEW_IMPORTS`와 `checkViewPage` 사용처(`editor/test/view.test.mjs:7`, `shell/test/view.test.mjs:7`, `flowmark/ui/view.test.mjs:7`): `checkViewPage`는 플러그인 빌드에서 실행한다(변경 11). 테스트는 import map의 네 항목을 담은 리터럴 사본을 읽고, `make check`가 그 리터럴을 `VIEW_IMPORTS`와 비교한다.
   - `browser/test/page.test.mjs:5`의 `INTERACTIVE`는 리터럴 상수다.
8. 매니페스트 테스트(`appview`, `browser`, `editor`, `files`, `shell`, `terminal`)는 플러그인 빌드가 검증한 매니페스트를 읽고 값을 리터럴로 검사한다. 검증기는 빌드에서 SDK 검증기로 실행한다.
9. `terminal/test/census.test.mjs`를 삭제한다(`:24`와 `:29`). 플러그인 소스의 census는 `make check`에서 실행한다. 프로브 사례는 `packages/plugin-api/test/events-check.test.mjs`(`:26`, `:147`, `:161`)가 다룬다.
10. flowmark는 테스트와 도우미를 `ui/`에서 `test/`로 옮기고, `test` 스크립트를 `node scripts/build-test.mjs && node --test test/`로 바꾼다. `ui/`에는 페이지 파일만 배포한다.
11. 명세: `docs/spec/plugins.md:40`의 "`make test`가 플러그인 저장소의 테스트를 실행"과 "테스트를 위해 `@soksak/plugin-api`에 의존"을 다음으로 바꾼다. `make test`는 플러그인 테스트를 실행하고, `make check`는 SDK 도구를 실행하며, 플러그인 저장소는 `@soksak/plugin-api`를 빌드 의존성으로 둔다. `docs/spec/plugins.md:171`("플러그인 저장소 테스트가 `checkViewPage`를 호출")은 "플러그인 빌드가 `checkViewPage`를 호출"로 바꾼다. 소유자는 core `main`이며 `.ko.md` 대응 문서도 함께 바꾼다.
12. `make test`는 플러그인 테스트 스크립트만 실행한다. `make check`는 `soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`, view start 해시 검사, `VIEW_IMPORTS` 리터럴 검사, `build-vendor --check`를 실행한다.
13. CI와 릴리스는 저장소별로 적는다(파일이 없는 저장소에는 파일이 있다고 가정하지 않는다).
    - `appview`, `browser`, `editor`, `files`, `hwp`, `terminal`: `.github/workflows/ci.yml`과 `release.yml`이 각각 `make test` 뒤에 `make check`를 실행한다. `make pack`은 `make check`에 의존한다.
    - `shell`: `ci.yml`이 `make test` 뒤에 `make check`를 실행한다. `release.yml`이 없으므로 sub-item은 릴리스 워크플로가 없음을 기록한다. 따라서 `make pack`은 손으로만 실행되며 이는 소유자 `shell`의 열린 결함이다.
    - `flowmark`: `.github` 폴더가 없다. sub-item은 `make test`와 `make check`를 실행하는 `ci.yml`을 추가하거나, 그 부재를 소유자 `flowmark`의 열린 결함으로 기록한다. flowmark의 SDK 도구는 현재 `make test`에서 실행되며(`flowmark/Makefile:10-14`), 이는 변경 12가 `make check`로 옮긴다.

### 범위 확인

제거되는 각 플러그인 단언은 core 테스트 또는 플러그인 픽스처 단언에 대응한다. 대응표는 테스트를 삭제하기 전에 sub-item에 쓴다. 처음부터 필요한 행은 `terminal/test/terminal.test.mjs:3874-3885`와 `:3909-3911`(`packages/log-contract/test/screen-hash.test.mjs`로), `terminal/test/census.test.mjs:24,29`(`events-check.test.mjs`로), `browser/test/page.test.mjs:5`(`binder.test.mjs`로), `editor/test/editor.test.mjs:6`, `browser/test/address-input.test.mjs:5`, `browser/test/empty-state.test.mjs:5`, `hwp/test/hwp.test.mjs:6`, `terminal/test/terminal.test.mjs:4`(binder 단언, `binder.test.mjs`로)다. 행이 없는 단언은 버리지 않는다.

### 범위 밖

픽스처 주석 문구와 정확한 픽스처 파일 이름(sub-item에서 정한다).

---

## D3. 선언된 이름으로 소유자를 분류한다

### 결정

`@soksak/plugin-*`와 `@soksak/sidecar-*` 이름 규칙은 `scripts/check-boundaries.mjs`에 둔다. 이 스크립트는 이미 선언된 폴더를 읽고, core가 플러그인이나 사이드카 이름을 적지 않는다고 헤더에 밝힌다. 기존 루프에 패턴 규칙 하나를 추가한다. `scripts/check-test-parity.mjs`는 경로 기준 소유자 루트를 유지하고, 이름과 무관한 private 경로 규칙을 추가한다. 더는 플러그인이나 사이드카 이름을 분류하지 않는다.

1. core 이름은 `packages/*/package.json`과 `packages/host/*/package.json`의 `name`이다(`check-boundaries.mjs`의 `components()`).
2. 패턴 규칙: core 소스(`packages/**`, 검사가 읽는 모든 확장자 포함: `.ts`, `.tsx`, `.cjs`)의 `@soksak/plugin-*` 또는 `@soksak/sidecar-*` 참조는 두 세그먼트 기준이 core 이름이 아니면, 선언되었는지와 관계없이 검사가 실패한다. 규칙은 기준에 `^@soksak/(plugin|sidecar)-` 패턴을 맞추므로 `@soksak/plugin-api-x`도 실패한다. 선언된 집합은 면제가 아니다. core 패키지 자신의 의존성 키에 의한 `allowed` 면제(`check-boundaries.mjs:33-35`)는 이 이름들에 대해 제거한다. core `package.json` 중 플러그인이나 사이드카 이름을 적는 것은 core 이름인 `@soksak/plugin-api`뿐이다.
3. 정확 일치: 참조는 두 세그먼트 기준(`@scope/name`)으로 core 이름과 정확히 비교한다. 기준이 core 패키지 이름과 정확히 같을 때만 core 이름이다.
4. 다른 scope는 소유자가 아니며 분류하지 않는다. 선언되지 않은 평범한 플러그인 id는 탐지하지 않는다. `docs/spec/plugins.md`(Repositories)가 이 한계를 적는다(변경 5). 2번 규칙의 접두사는 core 소스의 후보만 고르며, 어떤 참조도 소유자로 분류하지 않는다.
5. private 경로 규칙(이름과 무관): `scripts/check-test-parity.mjs`의 `auditOwnership`에서, private 하위 경로(`PRIVATE_SEGMENT`)를 가진 `@soksak/` 참조는 참조하는 패키지 자신의 선언된 이름이 아니면 "private"으로 실패한다. 이 검사는 core 이름을 면제하지 않는다. `plugins/x/ui/a.js`가 `@soksak/plugin-api/src/private.js`를 import하면 실패하고, 하위 경로가 없는 `@soksak/plugin-api`는 통과한다. core 이름은 변경 1과 같이 `packages/*/package.json`에서 읽는다.
6. core 테스트 픽스처는 `@scope/`를 쓴다. 이미 있는 `@soksak/sidecar-vt` 픽스처는 이름을 바꾼다.
7. `-example` 절은 제거한다. `@soksak/sidecar-example` 같은 이름은 면제가 아니며, `packages/**` 아래에서 2번 규칙으로 실패한다.

### 주장

- 접두사는 계약이 아니다. `docs/spec/plugins.md`는 GitHub 저장소 이름을 적고 npm 이름 규칙은 적지 않는다. core의 목록은 core 안의 플러그인 지식이며 경계 규칙이 금하는 것이다. 2번 규칙의 접두사는 후보만 고르며 아무것도 분류하지 않는다.
- `check-boundaries.mjs`는 이미 선언된 폴더의 `package.json` 이름과 `plugin.json` id를 읽고(`origin/main:scripts/check-boundaries.mjs:25-44`), 이미 core 소스의 선언된 이름을 표시한다(`:58-93`). 2번 규칙은 그 루프에 추가되는 패턴 하나이며, 선언되지 않은 이름에도 적용된다. 새 경로를 읽지 않으므로 두 번째 검사가 아니다.
- private 규칙은 소유자 분류와 독립이다. 이 규칙이 없으면 플러그인이 core 패키지의 private 하위 경로를 import해도 통과하고, `check-boundaries`가 검사하지 않는 `apps/`와 `e2e/`는 발견 없이 빠진다.
- `startsWith`는 `@soksak/plugin-api-x`를 플러그인으로 분류한다. 두 세그먼트 기준의 정확 일치는 그렇지 않으며, 2번 규칙은 `@soksak/plugin-api-x`를 기준이 core 이름이 아니므로 실패시킨다.

### 근거

- `origin/main:scripts/check-test-parity.mjs:4514-4523`: main의 `packageOwner`는 core 리터럴 `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`에 `core`를 주고(`:4516`), 플러그인 목록 `:4517-4519`과 사이드카 목록 `:4520-4522`의 이름에 각각 `-example` 절과 함께 소유자를 주며, 그 밖의 이름에는 `null`을 돌려준다(`:4523`). 따라서 main에서 `@soksak/plugin-foo`는 소유자가 없다. `fix/decouple-F236`에서는 `:4484-4486`의 접두사 분기가 모든 `@soksak/plugin-*`와 `@soksak/sidecar-*` 이름을 분류한다.
- `origin/main:scripts/check-test-parity.mjs:4553-4561`: private 오류는 참조된 소유자가 참조하는 쪽 소유자와 다를 때 발생하며, 그 뒤의 core 건너뛰기는 `:4561`이다. 따라서 main에서는 플러그인이 `@soksak/plugin-api/src/private.js`를 import하면 발견된다. core 리터럴을 지우면 이 발견이 사라지며, 5번 규칙이 이를 막는다.
- `origin/main:scripts/check-boundaries.mjs:17`: `SOURCE`는 `/\.(js|mjs|html|css|json|go|rs|m|h|toml)$/`이며 `.ts`, `.tsx`, `.cjs`를 제외한다. main에는 `packages/soksak/src/*.ts`(8개)와 `packages/soksak/dist/*.d.ts`(9개)가 있다.
- `origin/main:scripts/check-boundaries.mjs:1-5`(헤더: core가 플러그인이나 사이드카 이름을 적지 않는다). `:25-44`(`components()`). `:33-35`(`allowed`). `:58-93`(선언된 components를 도는 루프이며 가져올 때 실행된다).
- `origin/main:scripts/workspace-registry.mjs:170`은 진입 가드(`import.meta.url`과 `process.argv[1]` 비교)를 쓴다. 변경 1이 같은 패턴을 적용한다.
- `origin/main:scripts/test/test-parity.test.mjs:195-204`는 이름 분류에서 나온 `@soksak/sidecar-example`의 "sidecar" 오류를 단언한다. `:215-218`은 `@soksak/sidecar-example/src/private.js`의 "private" 오류를 단언한다. private 단언은 5번 규칙과 함께 남기고, 이름 단언만 옮긴다.
- `origin/main:scripts/test/soksak-scripts.test.mjs:118-131`은 이미 `check-boundaries`의 선언된 이름 규칙을 검사한다.
- `origin/main:scripts/workspace-registry.json`은 플러그인 `browser, editor, files, hwp, terminal`과 사이드카 `files`, `vt-alacritty`를 선언한다.
- `origin/main:docs/spec/plugins.md:34`는 `browser, terminal, files`와 `shell`을 적는다. registry와 다르며 변경 5에서 고친다.
- 선언되지 않은 `@soksak/sidecar-vt` 픽스처: `origin/main:packages/workbench/test/library-plugins.test.mjs:35`와 `:98`; `origin/main:packages/workbench/test/plugin-operations.test.mjs:63`. core에 이미 있는 `@scope/sidecar-probe` 픽스처: `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### 필요한 변경

1. `scripts/check-boundaries.mjs`: `SOURCE`(`:17`)에 `ts`, `tsx`, `cjs`를 더한다. 최상위 실행(`:58-93`과 최종 보고)을 진입 가드 `if (import.meta.url === pathToFileURL(process.argv[1]).href)`로 감싸서, 테스트가 전체 저장소 검사를 실행하지 않고 모듈을 가져올 수 있게 한다. `components()`와 `checkNames(components, files)`를 export한다. `checkNames`는 2번 규칙의 패턴 규칙을 루프에 더한다. 이는 규칙 하나를 더하는 것이며 새 경로를 읽지 않는다. 플러그인과 사이드카 이름의 `allowed` 면제(`:33-35`와 그 사용처)를 제거한다.
2. `scripts/check-test-parity.mjs`(`main`의 `:4514-4523`; `fix/decouple-F236`의 `:4482-4491`): `packageOwner`의 이름 분류(core 리터럴, 플러그인과 사이드카 목록, `-example`과 접두사 분기)를 제거한다. `OWNER_ROOTS`와 경로 기준 참조는 유지한다. private 게이트는 5번 규칙으로 바꾸며, core 이름은 `packages/*/package.json`에서 읽는다. `main` 변경과 `fix/decouple-F236` 변경은 별도 커밋이다.
3. `scripts/test/test-parity.test.mjs:195-204`의 이름 단언을 주입된 파일 집합을 쓰는 `checkNames` 테스트로 옮긴다. private 단언(`:215-218`)은 5번 규칙 아래 `check-test-parity`에 남긴다. 사례를 추가한다: `plugins/x/ui/a.js`가 `@soksak/plugin-api/src/private.js`를 import하면 "private"으로 실패; 하위 경로가 없는 `@soksak/plugin-api`는 통과; `apps/`와 `e2e/`의 private 경로는 실패.
4. `library-plugins.test.mjs:35,98`과 `plugin-operations.test.mjs:63`의 `@soksak/sidecar-vt` 픽스처를 `@scope/sidecar-vt`로 바꾼다. 이 테스트들은 실제 사이드카를 검사하지 않는다.
5. `docs/spec/plugins.md:34`(Repositories)를 registry 목록으로 고친다(선언된 플러그인 `browser, editor, files, hwp, terminal`, 선언되지 않은 저장소는 따로 적는다). 같은 절에 다음을 추가한다: core는 플러그인이나 사이드카 이름을 적지 않는다. 선언되지 않은 평범한 플러그인 id는 탐지하지 않는다. core 소스의 `@soksak/plugin-*`와 `@soksak/sidecar-*` 이름은 거부된다. 소유자는 core `main`이며 `.ko.md`도 바꾼다.
6. `checkNames`의 `scripts/test/` 테스트: `packages/**/x.js`의 선언되지 않은 `@soksak/plugin-foo`는 실패; 같은 이름이 `packages/**/x.ts`에 있어도 실패; `@soksak/sidecar-vt-alacritty` 같은 선언된 이름은 실패; `@soksak/sidecar-example`은 실패; `@soksak/plugin-api-x`는 실패(기준이 core 이름이 아님); `@scope/sidecar-vt`는 통과; core의 `@soksak/plugin-api`는 통과. 이 사례들은 `checkNames`, `.ts` 확장자, 패턴 규칙이 아직 없으므로 현재 코드에서만 실패한다. main에서 `packageOwner`는 이미 `@soksak/plugin-foo`에 소유자를 주지 않으므로, 2번 규칙은 main 결함의 수정이 아니라 새 규칙이다. 접두사 결함은 `fix/decouple-F236`(`:4484-4486`)에 있다.

### 범위 밖

`check-test-parity.mjs`의 lane과 개수 행(개수는 이 파일을 고치는 변경에서 `make parity-check`로 바뀐다).

---

## 라운드 기록

### 라운드 1

감사자: 새 Haiku 하위 에이전트 2개. 이의와 답변은 커밋된 라운드 1 기록에 있다.

### 라운드 2

감사자: 새 Haiku 하위 에이전트 2개. 이의와 답변은 커밋된 라운드 2 기록에 있다(`ui/` 모듈을 통한 SDK 간접 resolve, `make test`가 SDK 도구를 실행, 자기 일치 규칙 테스트, editor 지정자와 공용 모듈 hook, `ui/` 빌드 출력 없음, 규칙 2와 4의 모순, `check-test-parity`의 중복 규칙, 명세 문장 누락, `-example` 절).

### 라운드 3

감사자: 새 Haiku 하위 에이전트 2개. 이의와 답변은 커밋된 라운드 3 기록에 있다(진입 가드 없음, `.ts` 제외, 거짓 Red 주장, private 경로 손실, 중복 규칙과 `allowed` 면제, 픽스처의 SDK 바이트, 빌드 단계 누락, 임시 hook, screen-hash 의존, CI가 `make check`를 실행하지 않음).

### 라운드 4

감사자: 새 Haiku 하위 에이전트 2개. 각 이의는 파일과 대조했고 다음과 같이 답했다.

- D3 규칙 2는 기존 루프를 확장하는 것만으로 이룰 수 없다. 루프의 규칙은 선언된 components에서만 만들어진다(`check-boundaries.mjs:59-68`): 수용. 규칙 2는 루프에 더하는 패턴 규칙으로 명시하며, 읽는 경로가 없다. "두 번째 규칙이 아니다"라는 주장은 철회한다.
- D3 선언되지 않은 `@soksak/plugin-api-x`의 모호함: 수용. 규칙 2가 실패한다고 명시하며, 변경 6에 사례가 있다.
- D3 private 규칙이 plugin에서 core로 가는 검사를 잃는다(`check-test-parity.mjs:4553-4561`): 수용. 5번 규칙은 이름과 무관하며 core 이름을 면제하지 않는다. 변경 3이 `@soksak/plugin-api/src/private.js` 사례를 추가한다.
- D1 테스트의 직접 SDK import가 다뤄지지 않음: 수용. 확인: `@soksak/plugin-api`는 플러그인 테스트와 테스트 도우미 17개 파일에서 import된다. 변경 7이 각 묶음(binder, view import, `INTERACTIVE`)을 다시 쓴 픽스처, 리터럴, 범위 확인 행에 대응시킨다.
- D1 CI 범위가 두 저장소에서 틀림: 수용. 확인: `flowmark`에는 `.github` 폴더가 없고, `shell`에는 `ci.yml`만 있고 `release.yml`이 없다. 변경 13이 저장소별 행을 주고 열린 결함을 기록한다.
- D1 "SDK 파일 바이트 없음"의 검사 방법이 없음: 수용. 변경 2는 테스트 안의 표식 목록 줄 비교를 쓰며 SDK 파일을 읽지 않는다. SHA-256 비교는 `make check`에서만 실행한다.

상태: 라운드 5 대기. 라운드 5 감사자는 이 텍스트를 받는다.
