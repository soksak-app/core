# 플러그인과 애플리케이션 환경

[English](plugins.md)

워크벤치는 특정 플러그인을 참조하지 않는다. 각 애플리케이션은 `environment.json`에 플러그인과 기본값을 선언한다. 각 플러그인은 `plugin.json`에 자신을 선언한다. [`@soksak/plugin-api`](../../packages/plugin-api/index.js)가 두 형식, `sidecar.json` 형식, 스테이징 파일 배치, 페이지 import map을 정의한다. 워크벤치, 플러그인, 애플리케이션은 이 함수로 자기 파일을 검사한다.

## 작업 공간 구조

| 디렉터리 | 내용 |
| --- | --- |
| `packages/soksak` | 헤드리스 배치 라이브러리 |
| `packages/workbench` | 워크벤치 프런트엔드(코어): 프로젝트, 스페이스, 카드, 탭, 사이드바, 설정, 플러그인 로드, `soksak-stage` |
| `packages/plugin-api` | 선언 형식, 스테이징 배치, 페이지 import map, 플러그인 페이지 도구 |
| `packages/client` | 로컬 엔드포인트 클라이언트와 지연 시간 벤치마크 |
| `plugins/<id>` | 플러그인 하나: `plugin.json`, 페이지, 테스트 |
| `packages/host/<name>` | [네이티브 호스트](hosts.ko.md) 라이브러리(코어): Go의 `wailsv3`와 Rust의 `tauriv2` |
| `apps/<name>` | 애플리케이션 하나: `environment.json`, `runtime/`, 네이티브 진입점과 프레임워크 설정, 테스트 |
| `sidecars/<name>` | [사이드카](sidecars.ko.md) 하나: `sidecar.json`, 플러그인이 호스트를 통해 사용하는 네이티브 프로세스, 테스트 |
| `native/darwin` | 네이티브 호스트가 사용하는 macOS 공용 라이브러리 |
| `e2e` | 실행 중인 네이티브 애플리케이션의 창 검사 |

공통 기능은 워크벤치나 네이티브 호스트에 두어 플러그인이 다시 구현하지 않게 한다. 플러그인 기능은 워크벤치로 옮기지 않는다. 사이드카는 한 영역의 네이티브 기능을 담고 여러 플러그인에 제공할 수 있다. 메시지 전달 같은 일반 기능은 호스트에 둔다.

## plugin.json

| 필드 | 필수 | 의미 |
| --- | --- | --- |
| `id` | 예 | 소문자 식별자. 탭과 설정이 참조한다 |
| `name` | 예 | 표시 이름 |
| `surface` | 아니오 | `{ "page": "ui/page.html" }`: 패키지 안의 문서. 페이지는 [문서 영역](native-surfaces.ko.md#문서-영역)에 웹 문서를 표시하며, 웹 주소는 표면이 아니다 |
| `home` | 아니오 | 표면 페이지가 처음 여는 `http` 또는 `https` 주소. `surface`가 필요하다 |
| `mark` | `surface`가 있으면 | 추가 메뉴와 새 탭 제목에 표시하는 짧은 텍스트 |
| `icon` | `surface`가 있으면 | 16×16 뷰박스용 SVG 요소 |
| `sections` | 아니오 | 사이드바 섹션 `{ "id": "<플러그인 id>.<이름>", "name" }` |
| `preview` | 아니오 | `{ "ink": "--<토큰>" }`: 라이브러리 미리보기에서 플러그인 카드의 색을 정하는 테마 토큰 이름. `surface`가 필요하다 |
| `sidecars` | 아니오 | 표면 페이지가 사용하는 [사이드카](sidecars.ko.md)의 패키지 이름. `surface`가 필요하다. 각각 플러그인 `package.json`의 의존성이어야 한다 |

플러그인은 `surface`와 `sections` 중 하나 이상이 필요하다. 표면이 있는 플러그인만 추가 메뉴에 표시되고 레일을 갖는다. 워크벤치는 `page` 표면을 `modules/<패키지 이름>/<page>?id=<탭 id>`로 연다. 정의되지 않은 필드는 거부한다.

## environment.json

| 필드 | 의미 |
| --- | --- |
| `runtime` | 런타임 모듈 `index.js`를 포함한 애플리케이션 안의 디렉터리 |
| `plugins` | 플러그인 패키지 이름. 각각 애플리케이션 패키지의 의존성이어야 한다. 순서가 추가 메뉴 순서다 |
| `workspace.grid` | 새 스페이스의 격자선과 카드. `tabs`가 있는 카드는 `{ plugin, title }` 항목을 나열한다 |
| `workspace.focus` | 새 스페이스에서 포커스할 카드. 탭이 있어야 한다 |
| `sidebars.sets` | 기본 섹션 세트 |
| `sidebars.links` | 세트를 `left`(`plugin: null`), `right`, `rail`(플러그인 id 포함)에 연결하는 기본값 |

워크벤치는 설정을 읽거나 스페이스를 만들기 전에 `environment.json`과 나열된 모든 `plugin.json`을 로드한다. 표면이 없는 플러그인을 가리키는 탭이나 연결, 알 수 없는 섹션을 가리키는 세트가 있으면 등록 전에 로드가 실패한다.

## 스테이징 배치

`soksak-stage <출력> [--executables <디렉터리>] [--diagnostics]`는 애플리케이션 디렉터리에서 실행하고 Node 모듈 해석으로 패키지를 찾는다. 파일 내용을 바꾸지 않고 복사한다.

| 경로 | 원본 |
| --- | --- |
| `/` | `@soksak/workbench`의 `files` |
| `/modules/<패키지>/` | `soksak`, `@soksak/plugin-api`, 나열된 각 플러그인의 `files` |
| `/runtime/` | 애플리케이션의 `runtime` 디렉터리 |
| `/environment.json` | 애플리케이션의 `environment.json` |
| `/modules/<사이드카>/sidecar.json` | 플러그인의 `sidecars`에 나열된 각 사이드카 패키지의 `sidecar.json` |
| `/diagnostics.js` | `--diagnostics`이면 워크벤치의 `observe.js`(페이지 진단 메서드), 아니면 빈 모듈 |

`--executables <디렉터리>`를 지정하면 각 사이드카의 빌드된 `executable` 파일을 파일 이름 그대로 `<디렉터리>`에 복사하고, 파일이 빌드되지 않았으면 실패한다. 디버그 스테이징 대상 `frontend-wailsv3`, `frontend-tauriv2`와 릴리스 빌드 대상은 모든 사이드카 패키지를 빌드하는 `sidecars` 대상을 실행한 뒤 애플리케이션 실행 파일의 디렉터리(`target/debug` 또는 `target/release`)를 `--executables`로 지정해 `apps/<app>/src/frontend`에 스테이징한다. 디버그 대상은 `--diagnostics`를 더하며, 릴리스 빌드에는 페이지 진단 코드가 없다.

모든 페이지는 `PAGE_IMPORTS`와 같은 import map 하나를 선언한다. 항목은 `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/page`, `@soksak/runtime`, `@soksak/workbench/`다.

## 런타임 모듈

`runtime/index.js`는 다음을 내보낸다.

| 내보내는 값 | 의미 |
| --- | --- |
| `host` | 메인 페이지 호스트 인터페이스(`call`, `on`, `page`, `draggable`). 네이티브 호스트가 없으면 `null` |
| `page` | 표면·모달 페이지 인터페이스(`theme`, `sidecar`, `exposure`, `document`, `modal`). 네이티브 호스트가 없으면 `null` |
| `openStore()` | 작업 공간 저장소를 반환한다. 브라우저 애플리케이션은 IndexedDB를, 네이티브 애플리케이션은 `HostWorkspaceStore`를 사용한다 |
| `windows` | 창과 프로젝트 폴더 인터페이스. 네이티브 애플리케이션은 `@soksak/workbench/host-windows.js`의 `hostWindows(host)`를, 브라우저 애플리케이션은 자체 구현을 내보낸다 |

`windows`의 멤버는 다음과 같다.

| 멤버 | 의미 |
| --- | --- |
| `createsFolders` | `chooseFolder`와 `createFolder`를 사용할 수 있으면 `true` |
| `newWindow()` | 새 창을 연다. 브라우저 애플리케이션은 탭을 연다 |
| `onActivate(fn)` | 호스트가 창에 프로젝트 표시를 요청하면 `fn`을 호출한다 |
| `onCloseRequest(fn)` | 호스트가 창에 닫기를 요청하면 `fn`을 호출한다 |
| `ready()` | 창이 요청을 받을 수 있음을 알린다 |
| `close()` | 창을 닫는다 |
| `state()` | 창 좌표를 반환한다. 런타임에 창 좌표가 없으면 `null` |
| `folder(root)` | 프로젝트 디렉터리의 `{ root, identity }`를 반환한다. 브라우저 애플리케이션은 앞뒤 공백을 제거한 경로와 식별자 `path:<공백 제거 경로>`를 반환한다 |
| `chooseFolder()` | 폴더 선택 대화상자를 표시한다. 브라우저 애플리케이션은 호출을 거부한다 |
| `createFolder({ parent, name })` | 프로젝트 폴더를 만든다. 브라우저 애플리케이션은 호출을 거부한다 |
| `openProject({ id, root, title, geometry, separate, current })` | 프로젝트를 열고 `{ local }`을 반환한다. 호출한 창이 프로젝트를 표시하면 `local`은 `true`다. 브라우저 애플리케이션은 별도 창으로 여는 프로젝트를 새 탭에서 연다 |
| `releaseProject(id)` | 호출한 창의 프로젝트 소유를 해제한다 |

워크벤치는 이 내보내는 값만 사용하고 런타임에 따라 분기하지 않는다.

플러그인 페이지는 `@soksak/plugin-api/page`에서 다음을 가져오고 워크벤치 파일을 가져오지 않는다: `followTheme`, `page`, `expose`([공개 항목](exposure.ko.md)), `ownManifest()`(검사한 페이지의 `plugin.json`), `attachDocument(element, name)`(요소의 [문서 영역](native-surfaces.ko.md#문서-영역). 네이티브 호스트가 없으면 `null`).

## 테스트

각 디렉터리는 `pnpm test`로 자기 테스트를 실행한다. 패키지는 fixture로 자기 경계를 검사하고 다른 패키지의 소스나 실제 이름을 읽지 않는다. 플러그인 API는 형식을, 워크벤치는 fixture 파일로 로드를, 각 플러그인은 자기 `plugin.json`과 페이지를, 각 애플리케이션은 실제 플러그인 의존성으로 `environment.json`이 해석되는지를 검사한다. 워크벤치는 각 플러그인의 `preview.ink`로 라이브러리 미리보기 색을 정하고 플러그인별 CSS를 두지 않는다.

`node scripts/check-boundaries.mjs`는 소스 파일의 경계 규칙을 검사한다. 코어 패키지는 플러그인·사이드카 패키지 이름과 플러그인 id를 적지 않고, 플러그인과 사이드카는 자기 `package.json`에 선언한 패키지 이름만 적는다. `apps/`, `e2e/`, 선언 파일(`package.json`, `plugin.json`, `sidecar.json`), `.md` 파일은 검사하지 않는다.
