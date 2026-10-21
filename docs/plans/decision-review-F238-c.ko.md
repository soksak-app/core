# 결정 검토 F238-c: 플러그인 테스트의 import(D1)와 소유자 분류(D3)

[English](decision-review-F238-c.md)

이 기록은 두 결정을 검토한다. 각 결정은 주장, 파일과 줄을 든 근거, 정확히 필요한 변경을 적는다. 새 감사자 하위 에이전트는 결정이 틀리거나 불완전한 곳만 이의를 제기하며, 각 이의에는 구체적인 해결책이 붙는다. 문구와 인용 정정은 바로 반영하며 이의가 아니다. 한 라운드의 두 감사자가 실질적 이의가 없다고 보고할 때까지 라운드를 반복한다. 기준은 근거가 있을 때만 바뀌며, 테스트가 도달하지 못한다는 이유로 낮추지 않는다.

검토 범위: 각 결정이 정해야 하는 것; 실질적 이의(잘못된 전제, 규칙이 여전히 깨는 사례, 규칙을 이룰 수 없는 필요 변경, 거짓인 인용 사실, AGENTS.md와의 충돌). 범위 밖: 문구, 모든 구현이 같게 처리하는 사례, 단위 테스트가 정하는 세부 사항.

## 근거 기준

- 본류는 `origin/main`이다. 다른 브랜치는 `git show <branch>:<path>`로만 읽는다.
- 플러그인 저장소는 `../plugins/<id>` 형제 폴더의 `main` 브랜치다.
- 규칙 출처는 `AGENTS.md`(Structure)다: "Tests must not read another package's paths, SDK, build, or implementation names."와 "consumer tests use fakes or fixtures at the consumer boundary".

---

## D1. 플러그인 테스트는 SDK 코드를 import하지 않는다

### 결정

플러그인 저장소의 테스트는 `@soksak/*` 이름을 import하거나 resolve하지 않고, 설치된 패키지 경로를 읽지 않으며, SDK 바이트를 적재하지 않는다. SDK의 `@soksak/*` 이름은 `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`와 사이드카 이름이다. 플러그인 테스트는 그 플러그인의 코드, 매니페스트, 픽스처를 검사한다.

두 가지는 SDK가 아니며 테스트가 적재할 수 있다: (a) `devDependencies`에 선언된 제3자 패키지, (b) 플러그인 자신의 `build-vendor`가 `ui/vendor/`에 쓰는 번들(CodeMirror와 그 확장 등 플러그인에 빌드된 제3자 패키지이며 SDK 코드가 아니다). 테스트는 (b)를 상대 경로로 적재한다.

`ui/` 아래의 구현 모듈은 페이지가 import map으로 적재하므로 `@soksak/*` 지정자를 그대로 둔다. 테스트는 `ui/` 소스를 import하지 않는다. 플러그인 빌드는 테스트 트리(`build/test/`)를 쓴다. 이 트리는 `ui/`를 복사하고 SDK 지정자를 플러그인이 작성한 픽스처(페이지가 쓰는 SDK 함수를 소비자 경계의 가짜로 구현하며 SDK 코드를 담지 않는다)로 바꾼다. 각 플러그인의 `test` 스크립트는 테스트 트리 빌드를 먼저 실행한다: `node scripts/build-test.mjs && node --test test/`.

SDK 동작은 소유 패키지에서만 검사한다. 플러그인 테스트가 SDK 값을 단언하면 그 단언은 소유 core 테스트로 옮기고, 플러그인은 리터럴 상수나 단언되는 가짜를 쓴다.

명령 분리: `make test`는 플러그인 테스트 스크립트만 실행한다. `make check`는 SDK를 읽는 도구(`soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`), check 스크립트에 기록된 상수와 SDK `view-start.js`의 SHA-256을 비교하는 검사, 픽스처가 담은 값의 리터럴 일치 검사(`VIEW_IMPORTS` 항목, 화면 메시지 벡터), `build-vendor --check`를 실행한다. 모든 플러그인 저장소는 Makefile에 `check` 대상을 가지며 `pack`은 `check`에 의존한다. 빌드와 검사 스크립트(테스트가 아님)는 SDK 검증기를 호출할 수 있다.

가짜가 SDK에 충실하도록 적합성 검사를 둔다. core가 `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`의 export 표면 스냅샷(이름, 인자 수, 선언된 타입)을 커밋한다. 각 플러그인의 `check` 대상은 테스트 트리가 쓰는 모든 가짜의 export 이름과 인자 수를 그 스냅샷과 비교하고, 어긋나면 실패한다. 검사는 SDK 파일을 읽을 수 있고, 테스트는 읽을 수 없다.

결정은 각 플러그인 저장소에서 그 저장소의 sub-item이 들어갈 때 효력을 가진다. 그 전까지 현재 형태는 준수가 아니라 소유자가 있는 열린 결함이다.

### 주장

- SDK는 형식과 뷰 브리지를 core에서 이미 검사한다: `packages/plugin-api/test/view-page.test.mjs`(`checkViewPage`), `view.test.mjs`(`createViewBridge`), `binder.test.mjs`(`createBinder`), `view-imports.test.mjs`(`VIEW_IMPORTS`), `view-core-targets.test.mjs`, `events-check.test.mjs`(census 발견 사항, `:26`, `:147`, `:161`), `packages/log-contract/test/screen-hash.test.mjs`(화면 해시 벡터).
- `ui/` 소스를 import하는 테스트는 그 소스를 통해 SDK를 resolve한다. 빌드 출력에서 테스트에 보이는 SDK 지정자를 다시 쓰는 것이 SDK 코드를 테스트 실행에서 빼는 유일한 방법이다.
- SDK 파일이나 core 데이터의 사본을 담은 픽스처는 테스트 실행에 SDK 바이트를 넣는다. `make check`가 core 파일과 비교하는 리터럴은 허용하지만, 사본은 허용하지 않는다.

### 근거(형제 `../plugins/*`, `main` 브랜치)

테스트나 테스트 도우미에서 `@soksak/plugin-api`를 import하는 파일(17개): `appview/test/manifest.test.mjs`; `browser/test/{address-input,empty-state,manifest,page}.test.mjs`(`page.test.mjs:5`가 `INTERACTIVE`를, `address-input:5`와 `empty-state:5`가 `createBinder`를 import); `editor/test/{editor,view,manifest}.test.mjs`(`editor.test.mjs:6`이 `createBinder`를, `view.test.mjs:7`이 `VIEW_IMPORTS`와 `checkViewPage`를 import); `editor/test/view-host.mjs`; `files/test/manifest.test.mjs`; `hwp/test/hwp.test.mjs:6`(`createBinder`, `validateManifest`; `:158`이 `validateManifest`를 호출); `shell/test/{manifest,view}.test.mjs`(`view.test.mjs:7`이 `VIEW_IMPORTS`와 `checkViewPage`); `terminal/test/{census,manifest,terminal}.test.mjs`(`terminal.test.mjs:4`가 `createBinder`, `manifest.test.mjs:4`가 `validateDiagnostics`와 `validateManifest`를 import); `flowmark/ui/view.test.mjs:7`(`VIEW_IMPORTS`, `checkViewPage`).

`@soksak/shared` 지정자를 쓰는 테스트 파일: `editor/test/editor.test.mjs:184`와 `:198`; `editor/test/fixtures/upper-gutter.mjs:2`; `editor/test/shared-modules.mjs`.

테스트가 적재하고 SDK를 import하는 구현 모듈(간접): `terminal/ui/terminal.js:1-2`(`@soksak/plugin-api`, `@soksak/plugin-api/screen-hash`), `terminal/test/terminal.test.mjs:6`이 적재; `browser/ui/sections/tabs.js:3`과 `history.js:3`(`drawList`), `browser/test/section-lists.test.mjs:22`가 적재; `files/ui/sections/tree-horizontal.js:2`, `files/test/section-lists.test.mjs:43`이 적재; `editor/ui/view.js:7-8`과 `flowmark/ui/view.js:7`.

플러그인 테스트의 SDK 값 단언: `terminal/test/terminal.test.mjs:3874-3885`(골든 벡터 `vector.hash`), `:3880-3888`(페이지가 쓰는 프레임 레코드 필드), `:3903-3911`(`terminal.screen.alter`가 해시 전에 다음 메시지를 바꾼다).

플러그인 픽스처의 core 데이터 사본: `terminal/test/terminal.test.mjs:3853`은 `test/fixtures/screen-message.json`이 `packages/log-contract/fixtures/replay/screen-message.json`의 사본이라고 적고, 테스트가 이를 적재한다.

플러그인 호스트가 적재하는 SDK 바이트: `packages/plugin-api/view-start.js:1-12`는 주입되는 시작 스크립트다. `editor/test/view-host.mjs:14`와 `flowmark/ui/view-host.mjs:13`이 이를 읽는다.

resolver hook: `editor/test/shared-modules.mjs:4-18`(`registerHooks`, `POINT` `@soksak/shared/editor.extension/`), `editor/package.json:23`이 `--import`로 실행.

`make test` 안의 SDK 도구: `editor/Makefile:16-20`과 `terminal/Makefile:16-20`(`soksak-exposure`, `soksak-engines`, `soksak-events --census`); `flowmark/Makefile:10-14`(`soksak-engines`, `soksak-events`, `soksak-records`). `build-vendor --check`는 `editor/package.json:22`와 `files/package.json`의 `scripts.test`에서 실행된다.

Makefile: 어떤 저장소도 `check` 대상을 정의하지 않는다(각 `Makefile` 확인).

CI: `ci.yml:23`이 `appview`, `browser`, `editor`, `files`, `hwp`, `shell`, `terminal`에서 `make test`를 실행한다. `release.yml`은 `appview`, `browser`, `editor`, `files`, `hwp`, `terminal`에 있다. `shell`에는 릴리스 워크플로가 없다. `flowmark`에는 `.github` 폴더가 없다.

빌드 스크립트: `browser`, `appview`, `shell`, `terminal`, `flowmark`에는 `build` 스크립트가 없다. `editor`와 `files`에는 `build-vendor`만 실행하는 스크립트가 있다.

배포 파일: `flowmark/package.json`의 `files`는 `plugin.json`, `events.json`, `ui`이며, 테스트 스크립트는 `node --test ui/`다.

### 필요한 변경

1. 테스트 트리: 각 플러그인에 `scripts/build-test.mjs`를 두어 `build/test/`를 쓴다. `ui/`를 복사하고, SDK 지정자(`@soksak/plugin-api`, `@soksak/plugin-api/*`, `@soksak/runtime`, `@soksak/workbench`)를 SDK 코드가 없는 플러그인 작성 픽스처 모듈로 바꾼다. 제3자 지정자와 `ui/vendor/` 번들은 그대로 둔다. 플러그인의 `test` 스크립트가 이를 먼저 실행한다. 소유자: 각 플러그인 저장소, 저장소마다 sub-item 하나. `build` 스크립트가 없는 `shell`과 `flowmark`를 포함해 `browser`, `appview`, `terminal`도 이 스크립트를 가진다.
2. 테스트 규칙, 플러그인의 `test/` 디렉터리마다: `test/**`의 어떤 줄과 `ui/**/*.test.mjs`의 어떤 줄도 SDK 찾을 문자열을 포함하지 않는다. 테스트는 찾을 문자열을 조각으로 만들어(예: `"@" + "soksak/"`) 자기 소스와 일치하지 않게 한다. 규칙은 SDK와 공용 키트의 `@soksak/` 지정자를 다루며, 5번 변경으로 상대 경로가 되는 `@soksak/shared/editor.extension/` 번들 지정자는 제외한다. 테스트는 SDK 파일을 읽지 않는다. `view-start.js` 비교는 `make check`에서만 실행한다.
3. resolver hook: `editor/test/shared-modules.mjs`는 변경 1이 들어가면 삭제하며, `editor/package.json:23`의 `--import`도 뺀다. 그 전까지 hook은 소유자(editor 저장소)가 있는 열린 결함이다.
4. `editor/test/editor.test.mjs:184`와 `:198`, `editor/test/fixtures/upper-gutter.mjs:2`는 vendor 번들을 상대 경로(`ui/vendor/...`)로 import한다. 각 단언은 의미를 유지한다.
5. 뷰 호스트 픽스처(`editor/test/view-host.mjs`, `flowmark/ui/view-host.mjs`)는 SDK 파일을 읽지 않고 SDK 스크립트를 실행하지 않는다. `docs/spec/plugins.md:171`이 이름 붙인 시작 값의 플러그인 작성 리터럴과 플러그인이 쓴 `sokView` 스텁을 쓴다. `view-start.js`의 브리지 동작은 `packages/plugin-api/test/view.test.mjs`만 검사한다.
6. terminal(`terminal/test/terminal.test.mjs`):
   - 골든 벡터 단언(`:3874-3885`)은 가짜 `screenHash`가 리터럴을 돌려준다고 단언한다. 해시 값의 일치는 `packages/log-contract/test/screen-hash.test.mjs`의 벡터 루프에 이름으로 대응시켜, 같은 벡터에서 SDK 해시를 단언한다.
   - 페이지 연결 단언(`:3880-3888`의 프레임 필드와 `:3903-3911`의 바뀐 화면이 해시에 도달함)은 `terminal/test/`에 남고, 플러그인이 작성한 가짜 `screenHash`(입력을 기록한다)에 대해 실행한다. core에 이들의 자리가 없으므로 core 행에 대응시키지 않는다.
   - `terminal/test/fixtures/screen-message.json`(`:3853`의 core 데이터 사본)은 테스트가 쓰는 벡터 하나의 플러그인 작성 리터럴로 바꾼다. `make check`가 그 리터럴을 `packages/log-contract/fixtures/replay/screen-message.json`과 비교한다.
   - `ui/terminal.js`의 `@soksak/plugin-api/screen-hash` import는 변경 1이 가짜로 바꾼다.
7. 플러그인 테스트의 직접 SDK import를 뺀다(17개 파일 전체):
   - `createBinder` 사용처(`editor/test/editor.test.mjs:6`, `browser/test/address-input.test.mjs:5`, `browser/test/empty-state.test.mjs:5`, `hwp/test/hwp.test.mjs:6`, `terminal/test/terminal.test.mjs:4`)는 `build/test/`의 다시 쓴 binder 픽스처를 import한다. binder 계약 단언마다 `packages/plugin-api/test/binder.test.mjs`로 가는 대응 행이 있다. 플러그인 자신의 binder 연결을 검사하는 단언은 픽스처 기반 단언으로 남긴다.
   - `VIEW_IMPORTS`와 `checkViewPage` 사용처(`editor/test/view.test.mjs:7`, `shell/test/view.test.mjs:7`, `flowmark/ui/view.test.mjs:7`): 테스트는 import map의 네 항목을 담은 리터럴 사본을 읽고, `make check`가 그 리터럴을 `VIEW_IMPORTS`와 비교한다. `checkViewPage`는 8번 변경의 플러그인 빌드 스크립트에서 실행한다. 대응 행은 `packages/plugin-api/test/view-imports.test.mjs`와 `view-page.test.mjs`다.
   - `browser/test/page.test.mjs:5`의 `INTERACTIVE`는 리터럴 상수다. 대응 행은 `packages/plugin-api/test/binder.test.mjs`다.
8. SDK 검증기는 테스트가 아니라 플러그인 빌드 스크립트(`scripts/build-test.mjs` 또는 기존 빌드)에서 실행한다:
   - `validateManifest`는 `appview`, `browser`, `editor`, `files`, `hwp`(`hwp/test/hwp.test.mjs:158`), `shell`, `terminal`(`manifest.test.mjs:22`)에서; `validateDiagnostics`는 `terminal`(`manifest.test.mjs:4`)에서. 매니페스트 테스트는 빌드 출력을 읽고 값을 리터럴로 검사한다.
   - `checkViewPage`는 뷰 페이지가 있는 `editor`, `shell`, `flowmark`에서 빌드가 호출한다.
9. `terminal/test/census.test.mjs`를 삭제한다(`:24`, `:29`). 플러그인 소스의 census는 `make check`에서 실행한다. 프로브 사례는 `packages/plugin-api/test/events-check.test.mjs`(`:26`, `:147`, `:161`)가 다룬다.
10. flowmark는 테스트와 도우미를 `ui/`에서 `test/`로 옮기고, `test` 스크립트를 `node scripts/build-test.mjs && node --test test/`로 바꾼다. `ui/`에는 페이지 파일만 배포한다.
11. Makefile: 각 플러그인 저장소(`appview`, `browser`, `editor`, `files`, `hwp`, `shell`, `terminal`, `flowmark`)는 12번 목록을 실행하는 `check` 대상을 추가한다. `pack`은 `check`를 선행 조건으로 가진다. `pack`이 이미 `studio`에 의존하는 `hwp`는 `pack: studio check`다.
12. `make check`는 `soksak-exposure`, `soksak-engines`, `soksak-events --census`, `soksak-records`, view-start SHA-256 비교, 2번·5번·6번·7번 변경의 리터럴 일치 검사, `build-vendor --check`를 실행한다. 각 저장소의 `check` 대상은 자기 파일이 필요로 하는 부분집합을 실행하며, 명세가 저장소와 부분집합을 적는다.
13. CI와 릴리스는 저장소별로 적는다(파일이 없는 저장소에는 파일이 있다고 가정하지 않는다).
    - `appview`, `browser`, `editor`, `files`, `hwp`, `terminal`: `ci.yml`과 `release.yml`이 `make test` 뒤에 `make check`를 실행한다.
    - `shell`: `ci.yml`이 `make test` 뒤에 `make check`를 실행한다. `release.yml`이 없으므로 sub-item은 이를 소유자 `shell`의 열린 결함으로 기록하며, `make pack`은 손으로만 실행된다.
    - `flowmark`: `.github` 폴더가 없다. sub-item은 `make test`와 `make check`를 실행하는 `ci.yml`을 추가하거나, 그 부재를 소유자 `flowmark`의 열린 결함으로 기록한다.
14. 명세: `docs/spec/plugins.md:40`의 "`make test`가 플러그인 저장소의 테스트를 실행"과 "테스트를 위해 `@soksak/plugin-api`에 의존"을 다음으로 바꾼다. `make test`는 플러그인 테스트를 실행하고, `make check`는 SDK 도구를 실행하며, 플러그인 저장소는 `@soksak/plugin-api`를 빌드 의존성으로 둔다. `docs/spec/plugins.md:171`("플러그인 저장소 테스트가 `checkViewPage`를 호출")은 "플러그인 빌드가 `checkViewPage`를 호출"로 바꾼다. 소유자는 core `main`이며 `.ko.md` 대응 문서도 함께 바꾼다.


15. 적합성: core가 생성된 export 표면 스냅샷(이름, 인자 수, 선언된 타입)을 `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`에 대해 커밋한다. 각 플러그인의 `check` 대상은 테스트 트리의 모든 가짜를 그 스냅샷과 비교하고, 어긋나면 실패한다. 소유자: 스냅샷은 core `main`, 비교는 각 플러그인 저장소.

### 범위 확인

제거되는 각 단언은 core 테스트, 플러그인 내 가짜 기반 단언, 또는 `make check`의 리터럴 검사에 대응한다. 대응표는 테스트를 삭제하기 전에 sub-item에 쓴다. 처음부터 필요한 행: `terminal/test/terminal.test.mjs:3874-3885`(해시 값 일치는 `screen-hash.test.mjs` 벡터에, 페이지 연결은 terminal에 남김), `:3880-3911`(가짜 기반으로 남김), `terminal/test/census.test.mjs:24,29`(`events-check.test.mjs`로), `browser/test/page.test.mjs:5`(`binder.test.mjs`로), binder 단언 `editor/test/editor.test.mjs:6`, `browser/test/address-input.test.mjs:5`, `browser/test/empty-state.test.mjs:5`, `hwp/test/hwp.test.mjs:6`, `terminal/test/terminal.test.mjs:4`(`binder.test.mjs`로), `VIEW_IMPORTS`/`checkViewPage` 단언 `editor/test/view.test.mjs:7`, `shell/test/view.test.mjs:7`, `flowmark/ui/view.test.mjs:7`(`view-imports.test.mjs`와 `view-page.test.mjs`로), 검증기 단언 `hwp/test/hwp.test.mjs:158`과 `terminal/test/manifest.test.mjs:4,22`(`packages/plugin-api/test/` 매니페스트와 진단 테스트로). 행이 없는 단언은 버리지 않는다.

### 범위 밖

픽스처 주석 문구와 정확한 픽스처 파일 이름(sub-item에서 정한다).

---

## D3. 선언된 이름으로 소유자를 분류한다

### 결정

플러그인과 사이드카 이름의 소유자는 선언에서 정한다. core 이름은 `packages/*/package.json`과 `packages/host/*/package.json`에서 온다. 플러그인이나 사이드카 이름은 core 이름이 아닌 `@soksak/plugin-*` 또는 `@soksak/sidecar-*` 기준이다.

1. `scripts/check-boundaries.mjs`(선언된 폴더를 읽고, core가 플러그인이나 사이드카 이름을 적지 않는다고 이미 밝힌다)는 루프에 패턴 규칙 하나를 더한다. core 소스(`packages/**`, 검사가 읽는 모든 확장자 포함: `.ts`, `.tsx`, `.cjs`)에 core 패키지 이름도 아니고 선언된 구성요소 이름도 아닌 `@soksak/` 기준이 있으면 실패한다. 접두사를 쓰지 않으므로 선언되지 않은 플러그인은 어떤 이름이든(`@soksak/hwp` 포함) 실패한다. 이 규칙은 새 경로를 읽지 않는다. `allowed` 면제(`check-boundaries.mjs:33-35`)는 이 이름들에 대해 제거한다. 이런 이름을 적는 core `package.json`은 core 이름인 `@soksak/plugin-api`뿐이다.
2. `scripts/check-test-parity.mjs`는 플러그인과 사이드카 코드의 소유자 검사를 유지한다. 한 소유자의 구현이나 테스트가 다른 소유자의 구현을 참조하면 발견 사항이다. 기준의 소유자는 `scripts/workspace-registry.json`을 읽는 `check-boundaries.mjs`의 `components()`에서, `package.json` 이름이 그 기준과 같은 선언 구성요소의 `kind`다. 플러그인이나 사이드카 코드에 있는 선언되지 않은 `@soksak/` 기준은 발견 사항("undeclared")이며, 어떤 접두사도 이를 분류하지 않는다.
3. 정확 일치: 기준은 core 패키지 이름과 정확히 같을 때만 core 이름이다. `@soksak/plugin-api-x`는 `@soksak/plugin-api`가 아니다.
4. `@soksak/` scope 밖의 이름은 소유자가 아니며 검사하지 않는다. `docs/spec/plugins.md`(Repositories)가 이 한계를 적는다(변경 6).
5. private 경로 규칙(선언 기반): `check-test-parity.mjs`의 `auditOwnership`에서 하위 경로를 가진 `@soksak/` 참조는, 대상 패키지 `package.json`의 `exports` 맵에 그 하위 경로가 없거나(`exports` 맵이 없는 패키지는 하위 경로를 노출하지 않는다), 참조가 참조하는 패키지 자신의 선언된 이름이 아니면 "private"으로 실패한다. 대상 패키지는 선언된 워크스페이스 패키지에서 읽고, 참조하는 이름은 파일 위의 가장 가까운 `package.json`의 `name`이다. 둘 다 주입된 읽기 함수로 읽는다. 세그먼트 목록과 core 목록은 쓰지 않는다.
6. 참조 추출은 `import`, `from`, `require(`, `import(`와 맨 `require.resolve("@soksak/...")` 형태를 포함한다. 맨 형태의 private 하위 경로 참조도 같은 패턴으로 찾는다.
7. core 테스트 픽스처는 `@scope/`를 쓴다. 이미 있는 `@soksak/sidecar-vt` 픽스처는 이름을 바꾼다. `-example` 절은 제거한다.

### 주장

- 접두사는 계약이 아니며 `docs/spec/plugins.md`는 npm 이름 규칙을 적지 않는다. core에 플러그인 이름 목록을 두는 것은 core 안의 플러그인 지식이며 경계 규칙이 금하는 것이다. 1번 규칙은 접두사가 필요 없다. core의 모든 `@soksak/` 기준이 core 이름도 선언된 이름도 아니면 발견 사항이므로, 모양과 무관하게 선언되지 않은 이름은 실패한다. 2번 규칙은 선언된 종류로만 분류하며, 선언되지 않은 참조는 발견 사항으로 보고한다.
- `check-boundaries.mjs`는 이미 선언된 폴더를 읽는다(`origin/main:scripts/check-boundaries.mjs:25-44`). 1번 규칙은 기존 루프의 패턴 하나이며 새 경로를 읽지 않는다. 2번 규칙은 `check-test-parity`가 이미 하는 소유자 검사이며, 이제 리터럴 대신 선언된 이름을 같은 `components()` 함수로 읽는다.
- 세그먼트 목록도 계약이 아니다. `PRIVATE_SEGMENT`는 이름이 적히지 않은 `@soksak/runtime/lib/x.js`와 `@soksak/workbench/internal.js`를 통과시키므로, 공개되는 하위 경로는 선언된 `exports` 맵이 정한다.
- private 규칙은 소유자 분류와 독립이다. 이 규칙이 없으면 플러그인이 core 패키지의 private 하위 경로를 import해도 통과하고, `check-boundaries`가 검사하지 않는 `apps/`와 `e2e/`가 발견 없이 빠진다.
- `startsWith`는 `@soksak/plugin-api-x`를 플러그인으로 분류한다. 두 세그먼트 기준의 정확 일치는 그렇지 않으며, 1번 규칙은 `@soksak/plugin-api-x`를 기준이 core 이름이 아니므로 실패시킨다.

### 근거

- `origin/main:scripts/check-test-parity.mjs:4514-4523`: `packageOwner`는 core 리터럴 `@soksak/plugin-api`, `@soksak/runtime`, `@soksak/workbench`에 `core`를 준다(`:4516`). 플러그인 목록 `:4517-4519`과 사이드카 목록 `:4520-4522`는 각각 `-example` 절과 함께 소유자를 준다. 그 밖에는 `null`을 돌려준다(`:4523`). 따라서 main에서 `@soksak/plugin-foo`는 소유자가 없다. `fix/decouple-F236`에서는 `:4484-4486`의 접두사 분기가 모든 `@soksak/plugin-*`와 `@soksak/sidecar-*` 이름을 분류한다.
- `origin/main:scripts/check-test-parity.mjs:4553-4563`: 참조된 소유자가 참조하는 쪽 소유자와 다르면 private 오류가 발생한다(`:4556-4557`). 플러그인이나 사이드카 참조가 다른 소유자의 구현을 가리키면 `:4563`에서 발견 사항이다. main에서 플러그인이 `@soksak/plugin-api/src/private.js`를 import하면 발견된다.
- `origin/main:scripts/check-test-parity.mjs:4527-4531`(`ownerReferences`)은 `IMPORT_SPECIFIER`와 `PACKAGE_REFERENCE` 일치를 모은다. `PACKAGE_REFERENCE`(`:4504`)는 `plugin-`와 `sidecar-` 이름만 맞으므로, 맨 `require.resolve("@soksak/runtime/src/x.js")`는 main에서 놓친다.
- `origin/main:scripts/check-boundaries.mjs:17`: `SOURCE`는 `/\.(js|mjs|html|css|json|go|rs|m|h|toml)$/`이며 `.ts`, `.tsx`, `.cjs`를 제외한다. main에는 `packages/soksak/src/*.ts`(8개)와 `packages/soksak/dist/*.d.ts`(9개)가 있다.
- `origin/main:scripts/check-boundaries.mjs:1-5`(헤더); `:25-44`(`components()`); `:33-35`(`allowed`); `:58-93`(선언된 루프, 가져올 때 실행된다).
- `origin/main:scripts/workspace-registry.mjs:170`은 진입 가드(`import.meta.url`과 `process.argv[1]` 비교)를 쓴다.
- `origin/main:scripts/test/test-parity.test.mjs:195-218`은 `plugins/example/ui/module.js`가 `@soksak/sidecar-example`을 import하면 "sidecar" 발견(`:203-209`)을, `@soksak/sidecar-example/src/private.js`에는 "private" 발견(`:215-218`)을 단언한다.
- `origin/main:scripts/workspace-registry.json`은 플러그인 `browser, editor, files, hwp, terminal`과 사이드카 `files`, `vt-alacritty`를 선언한다.
- `origin/main:docs/spec/plugins.md:34`는 `browser, terminal, files`와 `shell`을 적는다. registry와 다르며 변경 8에서 고친다.
- 선언되지 않은 `@soksak/sidecar-vt` 픽스처: `origin/main:packages/workbench/test/library-plugins.test.mjs:35`와 `:98`; `origin/main:packages/workbench/test/plugin-operations.test.mjs:63`. core에 이미 있는 `@scope/sidecar-probe` 픽스처: `origin/main:packages/workbench/test/plugin-states.test.mjs:54,63,90`.

### 필요한 변경

1. `scripts/check-boundaries.mjs`: `SOURCE`(`:17`)에 `ts`, `tsx`, `cjs`를 더한다. 최상위 실행을 진입 가드 `if (import.meta.url === pathToFileURL(process.argv[1]).href)`로 감싼다. `components()`와 `checkNames(components, files)`를 export한다. `checkNames`가 1번 규칙의 패턴을 루프에 더한다. 플러그인과 사이드카 이름의 `allowed` 면제를 제거하고, core 패키지도 선언된 구성요소도 아닌 모든 `@soksak/` 기준을 실패시키는 규칙을 추가한다.
2. `scripts/check-test-parity.mjs`(`main`의 `:4514-4523`; `fix/decouple-F236`의 `:4482-4491`): `packageOwner`에서 core 리터럴, 플러그인과 사이드카 목록, `-example`과 접두사 분기를 제거한다. 소유자 조회는 `check-boundaries.mjs`의 `components()`로 만든다(2번 규칙). `OWNER_ROOTS`는 유지한다. `auditOwnership`에 5번 private 규칙과 6번 추출 규칙을 주입된 읽기 함수(선언된 패키지의 `package.json` 이름과 `exports` 맵)와 함께 추가한다. `main` 변경과 `fix/decouple-F236` 변경은 별도 커밋이다.
3. `scripts/test/test-parity.test.mjs:195-218`: "sidecar" 단언은 2번 규칙의 소유자 검사 사례가 되고, "private" 단언은 5번 규칙 아래 남는다. 새 사례: 선언된 `sidecar-y`를 `plugins/x/ui/a.js`가 import하면 "sidecar"로 실패; `plugins/x/ui/a.js`가 `@soksak/plugin-api/src/private.js`를 import하면 "private"으로 실패; `require.resolve("@soksak/runtime/src/x.js")`는 "private"으로 실패; 하위 경로가 없는 `@soksak/plugin-api`는 통과; `apps/`와 `e2e/`의 private 경로는 실패; `exports` 맵에 없는 `@soksak/runtime/lib/x.js`는 "private"으로 실패하고, 맵에 있는 하위 경로는 통과; core 소스의 `@soksak/hwp`는 선언되지 않은 것으로 실패한다.
4. `library-plugins.test.mjs:35,98`과 `plugin-operations.test.mjs:63`의 `@soksak/sidecar-vt` 픽스처를 `@scope/sidecar-vt`로 바꾼다. 이 테스트들은 실제 사이드카를 검사하지 않는다.
5. `checkNames`의 `scripts/test/` 테스트: `packages/**/x.js`의 선언되지 않은 `@soksak/plugin-foo`는 실패; 같은 이름이 `packages/**/x.ts`에 있어도 실패; core에서 선언된 `@soksak/sidecar-vt-alacritty`는 실패; `@soksak/sidecar-example`은 실패; `@soksak/plugin-api-x`는 실패; 선언되지 않은 `@soksak/hwp`는 실패; `@scope/sidecar-vt`는 통과; core의 `@soksak/plugin-api`는 통과. 이 사례들은 `checkNames`, `.ts` 확장자, 규칙이 아직 없으므로 현재 코드에서만 실패한다. main에서 `packageOwner`는 `@soksak/plugin-foo`에 소유자를 주지 않으므로, 1번 규칙은 새 규칙이다. 접두사 결함은 `fix/decouple-F236`(`:4484-4486`)에 있다.
6. `docs/spec/plugins.md:34`(Repositories)를 registry 목록으로 고친다(선언된 플러그인 `browser, editor, files, hwp, terminal`, 선언되지 않은 저장소는 따로 적는다). 같은 절에 추가한다: core는 플러그인이나 사이드카 이름을 적지 않는다. core 소스에서 선언되지 않은 `@soksak/` 이름은 거부되고, 플러그인과 사이드카 코드의 선언되지 않은 참조는 발견 사항이다. `@soksak/` 밖의 이름은 검사하지 않는다. 소유자는 core `main`이며 `.ko.md`도 바꾼다.

### 범위 밖

`check-test-parity.mjs`의 lane과 개수 행(개수는 이 파일을 고치는 변경에서 `make parity-check`로 바뀐다).

---

## 라운드 기록

### 라운드 1 ~ 4

이 파일의 커밋 기록(`docs/plans/decision-review-F238-c.md`의 git log, 라운드 1~4)에 있다. 각 라운드의 이의와 답변은 해당 커밋의 기록에 있다.

### 라운드 5

감사자: 새 Haiku 하위 에이전트 2개가 실질적 이의를 보고했다. 각 이의는 파일과 대조했다.

- D1 줄 일치 규칙은 `import ... from "@soksak/plugin-api"` 줄을 잡지 못한다(`@soksak/`가 줄의 부분 문자열이다): 수용. 규칙은 포함 여부를 검사한다.
- D1 `view-start.js`의 첫 줄을 리터럴로 두면 SDK 바이트를 복사한다: 수용. 표식 목록은 플러그인이 작성한 토큰만 담고, SHA-256 비교는 `make check`에 둔다.
- D1 `checkViewPage`를 아무 변경도 만들지 않는 빌드 단계로 옮김: 수용. 8번 변경이 뷰 페이지가 있는 플러그인의 빌드에 `checkViewPage`를 더하고, `shell`과 `flowmark`는 빌드 스크립트를 가진다(1번 변경).
- D1 어떤 Makefile에도 `check` 대상이 없음(각 Makefile에 `check:` 줄이 없음을 확인): 수용. 11번 변경이 저장소별로 추가하며 `pack: check`로 잇는다. `hwp`는 `pack: studio check`다.
- D1 terminal 단언이 페이지 연결을 시험할 수 없는 대상에 대응함(`terminal.test.mjs:3880-3911`): 수용. 해시 값 일치는 벡터 루프에 대응하고, 페이지 연결은 가짜 기반으로 terminal에 남긴다.
- D1 `terminal/test/fixtures/screen-message.json`이 core 데이터의 사본임(`:3853`에서 확인): 수용. 6번 변경이 `make check`가 검사하는 리터럴로 바꾼다.
- D1 "공용 키트"가 vendor 번들과 충돌함: 수용. 결정은 `ui/vendor/` 번들을 SDK가 아닌 플러그인에 빌드된 제3자 코드로 명시하고, 테스트는 상대 경로로 적재한다(4번 변경).
- D1 `hwp`와 `terminal`의 검증기가 빠짐(`hwp/test/hwp.test.mjs:158`, `terminal/test/manifest.test.mjs:4,22`에서 확인): 수용. 8번 변경이 이를 명시한다.
- D3 이름 소유자 검사가 변경 뒤 자리를 잃음(`test-parity.test.mjs:203-209`): 수용. 2번 규칙이 `check-test-parity`에 선언된 이름과, 선언되지 않은 참조에 대한 접두사 분류를 남긴다. 한계는 명시한다.
- D3 맨 `require.resolve` 형태를 `ownerReferences`가 놓침(`check-test-parity.mjs:4504`, `:4527-4531`): 수용. 6번 규칙이 맨 형태를 더한다.
- D3 자기 예외에 쓸 메커니즘이 없음(`auditOwnership`에 패키지 이름이 전달되지 않음): 수용. 5번 규칙이 주입된 가장 가까운 `package.json` 읽기 함수를 명시한다. 5번 규칙에서 "core 이름" 문구를 뺐으므로 이 규칙은 core 이름에 의존하지 않는다.

### 라운드 6

새 Haiku 감사자 2명이 결정 수준만 묻고(D1 또는 D3 자체가 틀렸는가) 이의를 보고했다:

- D1에는 플러그인 가짜가 SDK 표면과 맞는지 검사하는 것이 없어서, SDK 시그니처가 바뀌어도 플러그인 테스트가 모두 통과한다. 수용: 15번 변경이 core의 export 표면 스냅샷과 각 플러그인 `check` 대상의 비교를 추가한다.
- D3 5번 규칙은 세그먼트 목록 `PRIVATE_SEGMENT`를 써서 적히지 않은 하위 경로가 통과한다. 수용: 규칙은 선언된 `exports` 맵을 쓴다.
- D3 1번과 2번 규칙은 접두사로 이름을 고르므로, `@soksak/hwp` 같은 선언되지 않은 평범한 이름이 통과한다. 수용: 1번 규칙은 core 이름도 선언된 이름도 아닌 모든 `@soksak/` 기준을 실패시키고, 2번 규칙은 선언된 종류로만 분류한다.

상태: 라운드 7 대기. 라운드 7 감사자는 이 텍스트를 받는다.
