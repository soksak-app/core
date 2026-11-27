# 설정 탭

[English](settings.md)

설정 탭은 애플리케이션의 설정과 플러그인 페이지의 계약이다. 메인 창의 프로젝트 탭 옆에 있는 탭이다. 범위와 저장 파일은 [프로젝트](projects.ko.md#설정)가, 탭의 그리기 규칙은 [네이티브 모달](native-modals.ko.md)이, 창 사이드바는 [외부 창 사이드바](external-sidebars.ko.md)가, 플러그인 선언은 [플러그인](plugins.ko.md)이, 플러그인 작업은 [애플리케이션의 플러그인 작업](installation.ko.md#애플리케이션-안의-plugin-작업)이 정의한다. 구현과 검증은 [기능](../features.ko.md)에 기록한다.

설정 탭은 메뉴 하나, 한 번에 보이는 페이지 하나, 내용 영역 하나를 가진다. 창이 살아 있는 동안 탭은 닫았다 다시 열어도 페이지, 플러그인 검색어, 선택한 플러그인, 편집 중인 세트를 유지한다. 어떤 파일도 이것들을 저장하지 않는다.

## 열기와 닫기

- `core.settings.open`은 프로젝트 탭 옆에 설정 탭을 연다. 열린 탭이 있으면 그 탭을 앞으로 가져온다. 탭에는 칩 `⚙ 설정`과 닫기 컨트롤이 있다. 크롬 버튼(요소 `core.chrome.settings`), 앱 메뉴 항목 설정…, `cmd+,`가 이 명령을 실행한다.
- 프로젝트 창마다 설정 탭이 하나 있다. 탭은 `projectTabs`의 모든 위치에서 프로젝트 탭 뒤에 놓인다. 탭의 범위는 창의 프로젝트다. 창이 프로젝트 홈을 보이면 선택된 프로젝트가 없으며, 페이지 머리에 범위 컨트롤이 없다([페이지 머리](#페이지-머리)).
- 칩의 닫기 컨트롤(요소 `core.settings-tab.close`)은 `core.settings.close`를 실행한다. 이 명령은 탭을 닫고 창의 작업 화면을 앞으로 가져온다.
- 설정 탭이 앞에 있는 동안 창의 표면은 그려지지 않는다. 표면은 숨겨진 탭이 세션을 유지하듯 세션을 유지한다.
- 제목줄은 앞에 있는 화면의 도구만 보여 준다. 작업 화면은 사이드바 토글 네 개, 구분선, ⚙ 버튼을 보여 준다. 프로젝트 홈은 ⚙ 버튼을 보여 준다. 앞에 있는 설정 탭은 도구를 보여 주지 않는다. ⚙ 버튼은 `core.settings.open`을 실행하므로 화면마다 설정 입구가 하나다.
- 설정 탭을 닫은 뒤에는 작업 화면의 오른쪽 아래에 안내가 보인다. 글자 `설정이 닫혀 있다`와 버튼 `설정 열기`(element `core.settings-tab.reopen`)이며, 버튼은 `core.settings.open`을 실행한다. 안내는 작업 화면이 앞에 있고 이 페이지가 설정 탭을 연 적이 있을 때만 보이므로, 한 번도 연 적 없는 창에는 보이지 않는다. 탭이 다시 열리면 안내가 숨는다.
- 설정 탭은 자기 드래그와 자기 사각형이 없다. 내용은 메인 창의 내용이다.

## 메뉴

메뉴는 탭의 왼쪽에 있다. 메뉴의 위쪽에는 검색칸이 있다.

| 요소 | 텍스트 | 명령 |
| --- | --- | --- |
| 검색칸 | placeholder `설정 찾기` | `core.settings-tab.find {query}` |

메뉴는 두 묶음과 플러그인 목록 하나로 이루어진다.

묶음 `설정`:

| 페이지 | 항목 | 배지 |
| --- | --- | --- |
| `look` | 모양 | 없음 |
| `workspace` | 작업 공간 | 없음 |
| `sets` | 사이드바 세트 | 없음 |
| `behavior` | 동작 | 없음 |
| `agents` | 에이전트 연동 | warn, 상태가 `ok`가 아닌 setup part의 개수 |
| `diag` | 진단 | 없음 |

묶음 `플러그인`:

| 페이지 | 항목 | 배지 |
| --- | --- | --- |
| `installed` | 설치됨 | 문제가 있는 플러그인이 있으면 warn, 제목 `문제 <n>`; 없고 업데이트가 있는 플러그인이 있으면 acc, 제목 `업데이트 <n>`; 둘 다 없으면 설치된 플러그인 수를 글자로 |
| `browse` | 찾아보기 | 카탈로그 개수를 글자로 |

카탈로그는 레지스트리 인덱스가 취소되지 않은 버전으로 나열하는 플러그인과, 설치되었거나 불러온 플러그인을 가진다([레지스트리 인덱스](installation.ko.md#registry-index)).

묶음 `설정이 있는 플러그인`: 설정이나 계정을 선언하고 불러와 켜진 플러그인마다 항목 하나를 둔다. 항목에는 플러그인 이름과 초록 점(제목 `사용 중`)이 있다. 이 묶음은 이런 플러그인만 나열하므로, 설치된 플러그인이 많아도 메뉴가 짧게 유지된다. 그 밖의 플러그인 페이지는 설치됨에서 연다.

페이지 항목은 `core.settings-tab.nav {page}`를 실행한다. `core.settings-tab.nav`는 선택 인자 `group`도 받는다. `group`은 그 페이지 묶음의 `id`([행](#행))이고, 페이지는 그 묶음의 맨 위를 보이는 영역으로 스크롤한다. 이 명령은 닫힌 탭에서도 설정 탭을 앞으로 가져온다(core.settings.open과 같다). 그래서 알림 센터의 ⚙가 이 명령을 실행할 수 있다. 알 수 없는 묶음은 -32602로 거부되고 페이지는 바뀌지 않는다. 플러그인 항목은 `core.settings-tab.plugin {plugin}`을 실행한다. 앞에 있는 페이지의 항목은 선택 상태가 된다. 배경은 강조색 연한 색이고 글자는 굵다. 검색 중에는 선택된 항목이 없다.

## 페이지 머리

페이지 머리는 제목, 한 줄 설명, 범위 컨트롤을 보여 준다.

- 범위 컨트롤은 세그먼트 `전역 | <project name> · <n>`이다. `<n>`은 페이지에서 선택한 프로젝트가 덮어쓴 설정의 개수다. 세그먼트는 `core.settings-tab.scope {scope}`를 실행하며 값은 `common` 또는 `project`다. 세그먼트는 프로젝트가 선택되어 있고 페이지에 프로젝트가 덮어쓸 수 있는 설정이 있을 때만 보인다. 프로젝트 홈에서는 선택된 프로젝트가 없으므로 세그먼트가 없다.
- 설정이 있지만 프로젝트가 덮어쓸 수 있는 설정이 없는 페이지는 세그먼트 대신 배지 `전역 전용`(neutral)을 보인다.
- 설정이 없는 페이지는 둘 다 보이지 않는다. 설치됨, 찾아보기, 설치 전의 플러그인 페이지가 그렇다.
- 플러그인 페이지는 제목 위에 뒤로 가기 링크를 보인다. 링크는 설치됨 또는 메뉴에서 열었으면 `‹ 설치된 플러그인`, 찾아보기에서 열었으면 `‹ 찾아보기`다. 링크는 `core.settings-tab.back`을 실행하며, 이 명령은 `back` 상태가 가리키는 페이지로 돌아간다.
- 프로젝트 범위에서는 범위 컨트롤 아래의 caption이 프로젝트의 폴더를 보여 준다(요소 `core.settings-tab.folder`). 폴더는 이 범위가 저장하는 프로젝트를 알리는 유일한 표시다. 두 프로젝트의 끝 이름이 같을 수 있으므로, caption은 경로 전체를 pane 폭 안에 보인다. 줄은 공백에서, 하이픈 뒤에서, 경로 구분자(`/` 또는 `\`) 뒤에서 바뀌고, 줄보다 긴 이름은 줄 끝에서 바뀐다. caption은 말줄임으로 줄이지 않고, pane 밖으로 넘치지 않으며, 잘리지 않는다.
- 값을 바꾸면 내용을 다시 그리고 스크롤 위치를 유지한다. 다른 페이지, 범위, 플러그인 페이지, 편집하는 세트를 보이면 맨 위에서 시작한다. `scroll` 상태가 위치를 보고한다.

## 행

설정 하나가 행 하나다. 행은 굵은 라벨, 라벨 아래의 설명, 오른쪽 컨트롤 칸의 컨트롤을 보여 준다. 컨트롤 칸의 폭은 260pt다. 라벨이 없는 행도 빈 라벨 칸을 유지하므로 컨트롤은 컨트롤 칸에 남는다. 넓은 컨트롤(테마 견본, 계정 목록, 설치 상태)은 행 전체를 쓴다. 단위는 컨트롤의 일부다.

모든 컨트롤은 키보드로 쓸 수 있고, 포커스가 보이고, 비활성 상태가 있다. 한국어 글은 띄어쓰기에서 줄을 바꾼다.

페이지의 묶음마다 `id`가 있다. `id`는 그 페이지 안에서 유일하고 `workbench.json`의 행 선언에 적는다. `id`는 `core.settings-tab.nav {page, group}`에서 묶음을 가리키고, 묶음 이름은 제목일 뿐이다.

### 컨트롤의 범위

설정의 모든 컨트롤은 탭 안에서도 창 chrome에서도 같은 규칙을 따른다. 컨트롤은 자기 설정의 적용 값과 그 값이 나온 범위를 보여 주고, 그 범위에 쓴다. 선택된 프로젝트가 덮어쓴 설정은 프로젝트 범위에서 값을 가져오고, 나머지 설정은 전역 범위에서 값을 가져온다.

- 프로젝트 범위에서 프로젝트가 덮어쓴 설정의 행은 배지 `<project> 값`(acc)과 ↺ 컨트롤을 보인다. ↺ 컨트롤의 제목은 `<label> 전역 값으로 되돌리기`다. ↺는 `core.settings.reset {key, scope}`를 실행하며, 프로젝트 값을 지운다. 컨트롤은 프로젝트 값을 보여 준다.
- 프로젝트 범위에서 프로젝트가 덮어쓰지 않은 설정의 행은 전역 값을 보여 준다. 그 행을 바꾸면 프로젝트 값이 더해진다.
- 프로젝트 범위에서 전역 전용 설정은 비활성이며 배지 `전역 전용`을 보인다.
- 전역 범위에서 선택된 프로젝트가 덮어쓴 설정의 행은 전역 값을 보여 주고, 행 끝에 칩 `<project>: <value>`(warn 배지)를 보인다. 칩은 `core.settings-tab.scope {scope: "project"}`를 실행해 프로젝트 범위를 연다. 칩의 요소 이름은 `core.settings-tab.applied`이고 키는 `applied:<setting>`이다.
- 전역 범위의 모든 컨트롤은 전역 값에 쓴다. 전역 범위는 프로젝트 값을 더하지도 지우지도 않는다.
- 연결 컨트롤은 `links`를 따르며 `links` 범위의 세트를 선택지로 쓴다. 세트 목록, 그 버튼, 세트 편집은 `sets`를 따른다. 테마 견본은 `theme`을 따른다. 순서 행은 자기 키를 따른다. `links`의 칩은 연결 컨트롤 뒤에, `sets`의 칩은 세트 목록 뒤에, `theme`의 칩은 견본 격자에, 순서의 칩은 첫 행에 놓인다.
- 창 chrome의 스위치도 같은 규칙을 따른다. 변 스위치와 창 사이드바의 접기 컨트롤은 자기 변을 따르고([창 도구](external-sidebars.ko.md#창-도구)), 창의 모드는 `mode`를 따른다.

## 저장과 되돌리기

- 바꾸는 즉시 저장한다. 페이지에는 저장 버튼이 없다.
- 탭의 바닥에는 체크 아이콘과 글 `바꾼 값은 바로 저장된다`가 보인다.
- 설정을 바꾸면 토스트 `<label>: <old> → <new>`와 버튼 `되돌리기`가 5초 동안(5000 ms) 보인다. 버튼 `되돌리기`(`core.settings-tab.undo`)는 바꾼 명령을 이전 값으로 실행하고 토스트를 지운다. 새 토스트는 보이는 토스트를 바꾼다. 토스트에는 닫기 컨트롤이 없고, 시간이 끝나면 사라진다.
- 사이드바 변 스위치의 토스트는 `왼쪽 사이드바 보이기: 켬 → 끔`이다. 사이드바 순서의 토스트는 `배치 순서: 왼쪽 → 오른쪽 → 위 → 아래`다. 플러그인 순서의 토스트는 `창 사이드바 배치 순서: <sides>` 또는 `카드 사이드바 배치 순서: <sides>`이며, `<sides>`는 변 이름을 ` → `로 잇는다.
- 슬라이더는 끄는 동안 토스트를 만들지 않는다. 끌기가 끝나면 토스트를 한 번 만든다.
- 토스트는 설정 탭에서만 보인다. 작업 화면에서 사이드바 단축키로 바꾼 값은 토스트 없이 같은 저장 값에 쓰인다.

## 검색

`core.settings-tab.find {query}`는 설정과 플러그인을 찾는다. 검색어는 앞뒤 공백을 뺀다. 대소문자를 구분하지 않고 부분 문자열로 맞춘다.

- 설정은 라벨, 설명, 묶음 이름, 키로 맞춘다. 핵심 설정의 키는 [값](#값) 표의 이름이다. 플러그인 설정은 라벨, 설명, 묶음, 플러그인 이름으로 맞춘다.
- 설치된 플러그인은 이름, id, 설명, 분류 이름으로 맞춘다.
- 설치되지 않은 카탈로그 플러그인은 이름, id, 설명으로 맞춘다. 이 플러그인은 목록에 나열하지 않고 개수로만 센다.

결과는 제목 `“<query>” 찾기`를 보인다. 제목 아래 줄은 `<N>개 설정`을 보이며, 플러그인이 맞으면 ` · 플러그인 <M>개`를 덧붙인다. 결과 설정 중 프로젝트가 덮어쓸 수 있는 설정이 있으면 범위 세그먼트가, 없으면 배지 `전역 전용`이 보인다.

- 설정 결과는 페이지별로 묶는다. 묶음 제목은 핵심 설정이면 페이지 이름(`모양`, `작업 공간`, `동작`, `에이전트 연동`, `진단`), 플러그인 설정이면 `플러그인 › <plugin name>`이다. 각 행은 위에 묶음 이름을, 아래에 라벨, 설명, 컨트롤을 보인다.
- 맞는 설치된 플러그인은 묶음 `설치된 플러그인`을 이루며, 설치됨의 행과 같은 모양이다.
- 맞는 설치되지 않은 카탈로그 플러그인은 카드 `찾아보기에 <N>개 더 있다`를 이룬다. 카드 아래 줄은 최대 네 개의 이름을 `, `로 잇고, 더 있으면 ` …`을 붙인다. 버튼 `찾아보기에서 보기`는 `core.settings-tab.browse {query}`를 실행해 검색어를 가지고 찾아보기를 연다.
- 맞는 것이 없으면 `일치하는 설정이 없다.`를 보인다.
- 검색은 사이드바 세트 목록이나 설치 목록의 내용과 맞추지 않는다.
- 검색 중에는 선택된 메뉴 항목이 없다. 검색어를 지우면 마지막 페이지로 돌아간다.
- 검색칸에는 단축키 표시가 없다. 이 검색칸에 연결된 단축키가 없기 때문이다.
- 검색은 입력 이벤트마다 불러온 데이터에서 실행한다. 타이머를 쓰지 않는다.

## 페이지

페이지는 메뉴의 순서를 따른다. 큰따옴표 안의 글은 사람이 보는 라벨이다.

### 모양

페이지 모양의 제목은 `모양`, 설명은 `테마와 모드, 카드의 간격·모서리·글꼴.`이다.

페이지 맨 위에는 미리보기가 있다. 적용된 테마, 통로, 모서리, 폰트, 글자 크기로 그린 샘플 카드 두 장이며, 머리는 `터미널`과 `브라우저`다. 샘플 글은 고정이다. 통로가 0이면 카드가 한 줄을 공유한다.

묶음 `테마`, 설명 `테마가 색과 형태의 기본값을 정하고, 모드는 그 테마의 밝은 쪽과 어두운 쪽을 고른다.`

| 라벨 | 컨트롤 | 선택지 | 기본값 | 범위 |
| --- | --- | --- | --- | --- |
| `테마` | 견본 | 열 개 테마 `midnight`, `nord`, `solar`, `forest`, `ember`, `slate`, `mist`, `grape`, `sand`, `paper`. 각 견본은 테마 색과 이름을 보인다 | `midnight` | 전역과 프로젝트 |
| `모드` | 세그먼트 | `어두움`(`dark`), `밝음`(`light`) | `어두움` | 전역과 프로젝트 |

묶음 `형태`, 설명 `테마가 준 값에서 시작한다.`

| 라벨 | 컨트롤 | 범위 | 기본값 | 범위 구분 |
| --- | --- | --- | --- | --- |
| `통로`(설명 `카드 사이 간격. 0이면 카드가 선 하나를 공유한다.`) | 단위 `px`가 붙은 슬라이더 | 0–48 | 테마 값 | 전역과 프로젝트 |
| `모서리`(설명 `카드 모서리의 둥글기.`) | 단위 `px`가 붙은 슬라이더 | 0–24 | 테마 값 | 전역과 프로젝트 |
| `폰트` | 셀렉트 | `시스템 고정폭`(`mono-system`), `SF Mono / Menlo`(`mono-sf`), `JetBrains Mono`(`mono-jet`), `시스템 비례`(`sans-system`), `Inter`(`sans-inter`) | 테마 값 | 전역과 프로젝트 |
| `글자 크기` | 단위 `px`가 붙은 스테퍼 `− value +` | 10–18 | 테마 값 | 전역과 프로젝트 |
| `textSize` | 글자 크기 단계의 셀렉트 | 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3 | 1 | 전역 전용 |

묶음 `표시`:

| 라벨 | 컨트롤 | 선택지 | 기본값 | 범위 |
| --- | --- | --- | --- | --- |
| `포커스 표시` | 세그먼트 | `border`, `corner` | `border` | 전역과 프로젝트 |
| `경계선` | 세그먼트 | `under`, `over`, `none` | `under` | 전역과 프로젝트 |
| `포커스 밖 흐리게` | 스위치 | 켬, 끔 | 끔 | 전역과 프로젝트 |

`focusInd`와 `fullRule`의 선택지는 페이지가 라벨을 정하지 않았으므로 값 그대로 보인다.

### 작업 공간

페이지 작업 공간의 제목은 `작업 공간`, 설명은 `프로젝트 창, 탭 위치, 사이드바 배치와 크기.`이다.

묶음 `프로젝트`, 설명 `프로젝트를 여는 방식. 모든 프로젝트에 적용되며, 이미 열린 창은 그대로 둔다.`

| 라벨 | 컨트롤 | 선택지 | 기본값 | 범위 |
| --- | --- | --- | --- | --- |
| `열기 방식` | 세그먼트 | `별도 창`(`windows`), `현재 창의 새 탭`(`tabs`) | `별도 창` | 전역 전용 |

묶음 `위치`, 설명 `프로젝트 탭이 놓이는 위치. 바꾸면 카드 배치도 함께 바뀐다.`

| 라벨 | 컨트롤 | 선택지 | 기본값 | 범위 |
| --- | --- | --- | --- | --- |
| `프로젝트 탭 위치` | 셀렉트 | `위`(`top`), `아래`(`bottom`), `왼쪽`(`left`), `오른쪽`(`right`) | `위` | 전역과 프로젝트 |

묶음 `사이드바`, 설명 `위에 있는 줄부터 자리를 잡는다. 먼저 놓인 변이 그 변의 전체 길이를 쓰고, 다음 변은 그만큼 빠진다. 끈 변도 자기 순서를 지킨다.`

묶음은 행 네 개의 목록을 보인다. 행 하나가 변 하나이며, 행 순서가 `sidebarOrder`에 저장된 배치 순서다. 각 행은 왼쪽부터 다음을 보인다.

1. 행 번호(1–4).
2. 변 이름 `왼쪽`, `오른쪽`, `위`, `아래`.
3. 프로젝트 범위에서 프로젝트가 행의 값을 덮어썼으면 배지 `<project> 값`(acc).
4. 변의 세트 셀렉트. 항목은 `사용 안 함`과 모든 세트다. 세트 항목은 힌트 `목록 · <n>` 또는 `탭 · <n>`을 보이며, `<n>`은 세트의 섹션 수다. 셀렉트는 `core.settings.link {place, plugin: null, set, scope}`를 실행하고, 변이 꺼져 있으면 비활성이다. 변이 꺼진 동안에도 저장된 연결은 남는다.
5. 변의 켬/끔 스위치. `left`, `right`, `top`, `bottom`에 대해 `core.settings.change {key, value, scope}`를 실행한다.
6. 제목 `위로`의 버튼 ↑. 행을 한 칸 위로 옮긴다. 첫 행에서는 비활성이다.
7. 제목 `아래로`의 버튼 ↓. 행을 한 칸 아래로 옮긴다. 마지막 행에서는 비활성이다.

6과 7의 버튼은 `core.settings.change {key: sidebarOrder, value, scope}`를 실행하며, `value`는 새 순서 전체다.

목록 아래의 글은 행 순서와 상관없이 고정된 순서로 단축키를 보인다: `⌘B 왼쪽 · ⌥⌘B 오른쪽 · ⇧⌘J 위 · ⌘J 아래`.

프로젝트 범위에서 프로젝트가 변 스위치, 전역 변 연결, `sidebarOrder`를 덮어쓰면 버튼 `<project> 값 지우기`(reset 아이콘)를 보인다. 버튼은 `core.settings.reset {key, scope: "project"}`를 이 키마다 한 번씩 실행한다.

묶음 `사이드바 크기`, 설명 `처음 폭은 최소 폭과 최대 폭 사이여야 한다. 위·아래 사이드바에는 높이로 적용된다.`

| 라벨 | 컨트롤 | 범위 | 기본값 | 설명 | 범위 구분 |
| --- | --- | --- | --- | --- | --- |
| `최소 폭` | 단위 `pt`가 붙은 슬라이더 | 60–800 | 120 | 없음 | 선언에 따름 |
| `최대 폭` | 단위 `pt`가 붙은 슬라이더 | 60–800 | 480 | 없음 | 선언에 따름 |
| `처음 폭` | 단위 `pt`가 붙은 슬라이더 | 60–800 | 190 | `카드 안 사이드바와 저장된 크기가 없는 창 사이드바가 여는 크기.` | 선언에 따름 |

세 폭은 현재 계약의 범위(전역과 프로젝트)를 그대로 쓴다. 저장된 프로젝트 설정이 각 값을 프로젝트별로 가지기 때문이다([배치 값](#배치-값)).

묶음은 범위의 적용 값을 검사한다. 프로젝트 값은 전역 값과 다를 수 있기 때문이다.

- 최소 폭이 최대 폭보다 작지 않으면 `최소 폭(<값>pt)이 최대 폭(<값>pt)보다 작아야 한다.` 줄을 보인다.
- 처음 폭이 최소 폭과 최대 폭의 범위 밖이면 `처음 폭 <값>pt가 범위 <최소>–<최대>pt 밖이다.` 줄과 버튼 `범위 안으로 맞추기`를 보인다. 버튼은 범위 안으로 자른 값으로 `core.settings.change {key: sidebarWidth, value, scope}`를 실행한다.

### 사이드바 세트

페이지 사이드바 세트의 제목은 `사이드바 세트`, 설명은 `사이드바에 보여 줄 섹션 묶음. 어느 변에 놓을지는 작업 공간과 플러그인에서 고른다.`이다. 세트는 범위 규칙을 따르므로 범위 컨트롤을 보인다.

페이지는 세트 목록을 보인다. 세트 행은 다음을 보인다.

- 이름. 이름이 비면 `(이름 없음)`.
- 배치 배지 `탭` 또는 `목록`(neutral).
- 링크가 세트를 쓰면 줄 `· 쓰는 곳: <list>`. 목록은 변(`왼쪽`)과 플러그인 창(`<plugin name> 창 <side>`)을 적는다. 세트를 쓰는 링크가 없으면 줄이 없다.
- 섹션 칩. 칩은 섹션 이름을 보인다. 불러오지 않은 플러그인의 섹션 칩은 흐린 점선 테두리와 취소선을 긋은 이름을 보이고, 툴팁은 `<name>(<id>) 플러그인 필요`다([없는 플러그인](plugins.ko.md#없는-플러그인)). 세트 줄은 칩 아래에 그런 플러그인마다 경고 줄 하나를 보인다([없는 플러그인](plugins.ko.md#없는-플러그인)). 섹션이 없는 세트는 `섹션 없음`을 보인다.
- 버튼 `편집`(secondary, sm)은 `core.settings-tab.edit {set}`을 실행하고, 버튼 `삭제`(ghost, sm)가 있다.

편집 중인 세트의 행은 `편집` 자리에 버튼 `완료`(primary, sm)를 보인다. `완료`는 `core.settings-tab.edit {set: null}`을 실행한다.

`삭제`를 누르면 `core.settings-tab.confirm {kind: "set", id, answer: "ask"}`가 실행되고, 행 아래에 확인이 나온다. 링크가 세트를 쓰면 `쓰는 곳은 “사용 안 함”이 된다.`, 아니면 `삭제할까?`다. 버튼은 `취소`(ghost, sm)와 `삭제`(danger, sm)다. `취소`는 `answer: "no"`로 같은 명령을 실행한다. `삭제`는 `answer: "yes"`로 같은 명령을 실행하며, `yes` 답은 `core.settings.sets.delete {id, scope}`를 실행한다.

버튼 `새 세트`(plus 아이콘)는 `core.settings.sets.create {scope}`를 실행한다. 이 명령은 제목 `새 세트`, 배치 `list`, 섹션 없는 세트를 더하고 그 세트의 편집기를 연다.

세트의 편집기는 다음을 보인다.

- `이름`: 글자 입력 칸. `core.settings.sets.update {id, title, scope}`를 실행한다. 이름이 비면 칸 아래에 `이름이 필요하다.` 줄을 보인다. 1–40자의 이름을 저장한다.
- `배치`: 세그먼트 `목록`(`list`)과 `탭`(`tabs`). `core.settings.sets.update {id, layout, scope}`를 실행한다.
- `섹션`: 세트의 섹션마다 칩 하나를 세트 순서대로 보인다. 칩은 섹션 이름과 버튼 × (`<section name> 빼기`)를 가진다. 불러오지 않은 플러그인의 섹션 칩은 흐린 점선 테두리와 취소선을 긋은 이름을 보이고, 툴팁은 `<name>(<id>) 플러그인 필요`다([없는 플러그인](plugins.ko.md#없는-플러그인)). 세트에 섹션이 없으면 `아직 섹션이 없다.` 줄을 보인다. 칩 뒤에는 셀렉트 `섹션 추가…`가 있다. 선택지는 세트가 가지지 않은 등록된 섹션이며, 각 선택지는 플러그인 id를 힌트로 보이고, 플러그인 순서와 선언 순서로 묶인다. 세트가 등록된 모든 섹션을 가지면 셀렉트는 비활성이다.
- 줄 `바꾼 값은 바로 저장된다. 같은 섹션은 한 세트에 한 번만 들어간다.`
- 버튼 `완료`.

섹션 컨트롤은 `core.settings.sets.row {id, action, index?, section?, scope}`를 실행한다.

| 컨트롤 | 명령 | 효과 |
| --- | --- | --- |
| `index` 칩의 × | `remove`, `index`와 함께 | `index` 위치의 섹션을 뺀다 |
| `섹션 추가…`의 선택지 | `add`, `section`과 함께 | `section`을 세트 끝에 더한다 |

칩에는 순서를 바꾸는 컨트롤이 없다. 섹션의 순서는 추가한 순서이며, 섹션을 옮기려면 뺀 뒤 다시 더한다. 세트에 같은 섹션이 다시 들어가는 변경은 -32602(invalid params)와 "section <id> is already in set <id>" 오류로 실패하고 아무것도 바꾸지 않는다. 등록되지 않은 `section`을 가진 `add`는 -32602와 "unknown section <id>"로 실패한다. 모든 변경은 [범위 규칙](#컨트롤의-범위)이 주는 `sets` 범위에 바로 저장된다.

### 동작

페이지 동작의 제목은 `동작`, 설명은 `언어, 메모리, 알림.`이다. `language`는 프로젝트가 덮어쓸 수 있으므로 범위 컨트롤을 보인다.

묶음 `언어`, 설명 `애플리케이션 메뉴의 언어. 자동은 시스템 언어를 따르고, 목록에 없으면 영어다.`

| 라벨 | 컨트롤 | 선택지 | 기본값 | 범위 |
| --- | --- | --- | --- | --- |
| `언어` | 세그먼트 | `자동 (시스템)`(`auto`), `한국어`(`ko`), `English`(`en`) | `auto` | 전역과 프로젝트 |

묶음 `카드`:

| 라벨 | 컨트롤 | 선택지 | 기본값 | 범위 |
| --- | --- | --- | --- | --- |
| `카드 자동 정렬`(설명 `resize는 배치를 지키며 카드 크기를 고르게 나눈다. even은 카드를 같은 격자로 놓는다.`) | 세그먼트 | `resize`, `even` | `resize` | 전역과 프로젝트 |

묶음 `메모리`, 설명 `메모리 절약을 켜면 숨긴 지 정한 시간이 지난 탭을 내리고, 다시 보일 때 저장된 상태로 연다.` 이 묶음의 행은 모두 전역 전용이다.

| 라벨 | 컨트롤 | 선택지 또는 범위 | 기본값 | 의존 |
| --- | --- | --- | --- | --- |
| `보기 프로세스`(설명 `새로 여는 보기부터 적용된다.`) | 세그먼트 | `플러그인마다 하나`(`plugin`), `카드마다 하나`(`view`) | `plugin` | 없음 |
| `메모리 절약` | 스위치 | 켬, 끔 | 켬 | 없음 |
| `숨긴 뒤 내리기까지` | 단위 `분`이 붙은 슬라이더 | 5–720 | 120 | 들여 쓴다. `메모리 절약`이 꺼지면 비활성 |

묶음 `알림`은 [알림](notifications.ko.md#설정)을 따른다. 이 묶음의 키는 `toastStyle`, `noticeCenterStyle`, `quietToasts`, `autoDismissProblemToasts`, `problemToastDismissSeconds`이며, 이 묶음의 행은 모두 전역 전용이다.

### 에이전트

<a id="agents"></a>페이지 에이전트 연동의 제목은 `에이전트 연동`, 설명은 `에이전트가 이 애플리케이션을 배우고 다루게 하는 항목.`, 배지는 `전역 전용`이다.

페이지는 컴퓨터의 에이전트가 애플리케이션을 배우고 그것에 연결하게 하는 setup part를 보인다([에이전트](cli.ko.md#에이전트)). 이 part는 프로젝트가 아니라 컴퓨터와 사람의 것이므로 페이지는 전역 전용이다. 페이지는 host call `setupState()`로 part를 읽는다. 이 call은 사람의 login shell 환경에서 사용자 PATH 등록과 다른 setup part를 보고한다. 페이지는 보일 때, 창이 key window가 될 때(`window-active`), 각 `setup-changed` 이벤트 뒤, `core.setup.check`를 실행할 때 part를 읽는다. 타이머는 다시 읽지 않는다.

묶음 `에이전트 연동`에는 넓은 행 `연동 상태` 하나가 있다.

- 요약은 배지 `<n>개 중 <m>개가 다름`(warn, 경고 아이콘)을 보인다. `<m>`은 `differs` 또는 `missing`인 part의 수다. 모든 part가 `ok`이면 `모두 설치됨`(ok)을 보인다.
- 버튼 `다시 확인`(refresh 아이콘, sm)은 `core.settings-tab.setup-check`를 실행하며, 이는 `core.setup.check`를 실행한다.
- 버튼 `모두 설치`(primary, sm)는 상태가 `ok`가 아닌 part가 있는 종류 `skill`과 `mcp`로 `core.settings-tab.setup-install-all`을 실행한다. 그런 part가 없으면 비활성이다.

part마다 행이 하나이며 part 순서를 따른다(요소 이름 `core.settings-tab.setup`). 행은 이름, 파일, 상태를 보인다.

| Part | 이름 | 파일 | 동작 |
| --- | --- | --- | --- |
| `path` | 명령 경로 | 애플리케이션 bundle의 `sok` | 켜져 있으면 `끄기`가 `core.settings-tab.setup-change {part: "path", enabled: false}`를 실행한다. 꺼져 있으면 상태에 `사용 안 함`을 보이고 `켜기`가 `enabled: true`로 같은 명령을 실행한다 |
| `skill` | 스킬 | 스킬 파일 | 상태 `missing`이고 사유가 `differs`이면 `고치기`, 그 밖의 `missing`이면 `설치`(sm). 각각 `core.settings-tab.setup-install {parts: ["skill"]}`을 실행한다 |
| `mcp` | MCP 등록 | 등록 파일 | `고치기` 또는 `설치`(sm). 각각 `core.settings-tab.setup-install {parts: ["mcp"]}`을 실행한다 |
| `hook` | 훅 | 훅 파일 | 없음. 설치 명령은 훅을 받지 않는다 |

상태 배지는 `설치됨`(ok, 상태 `ok`), `다름`(warn, 상태 `missing`과 사유 `differs` 또는 `<kind> differs`), `없음`(warn, 상태 `missing`과 사유 `absent`)이다. 상태가 `error`인 part는 [컨트롤](#컨트롤)의 오류 표시를 거쳐 오류 글을 보인다. 해당하지 않는 part에는 행이 없다. 행이 하나도 없으면 페이지는 `이 컴퓨터에서 설정할 에이전트 항목이 없습니다.`를 보인다.

`core.setup.check`는 매개변수 없이 part를 다시 읽고 `{parts}`로 답한다. `core.setup.install`은 `{parts}`를 받는다. `{parts}`는 반복 없는 `skill`과 `mcp`의 비지 않은 목록이며, host call `setupInstall`을 실행하고 그 `{parts}`로 답한다. 다른 목록이면 -32602(invalid params)로 실패한다. 설치가 실패하거나 다른 작업이 실행 중이면 host 오류로, host가 없으면 "setup operations need a native host"로 실패한다. 명령 `core.setup.change {part, enabled}`는 `part: "path"`와 불리언 `enabled`를 받는다. 같은 매개변수로 `setupChange`를 실행하고, preference를 저장해 적용한 뒤 `{parts}`로 답한다. 실패한 읽기나 작업은 오류 표시로 보이며, 오류 표시는 그것을 애플리케이션 log에 쓴다.

### 진단

페이지 진단의 제목은 `진단`, 설명은 `문제를 추적할 때만 켠다.`, 배지는 `전역 전용`이다.

묶음 `진단`, 설명 `켜면 성능 트레이스와 모든 로그 종류의 상세 기록이 남는다. 끄면 오류만 기록된다.` 행 `디버그 기록`은 `core.settings.debug {on}`을 실행하는 스위치 하나다. 스위치는 `diagnostics.performance`가 true이고 `diagnostics.log`의 모든 class가 `trace`일 때 켜져 보인다.

`diagnostics.performance`는 영구 성능 트레이스([성능 트레이스](performance-trace.ko.md))의 스위치다. 불리언이며 기본값은 false이므로, 사람이 켜지 않는 한 release는 trace를 기록하지 않는다. false인 동안 어떤 계층도 성능 기록 작업을 하지 않는다. event를 만들지도 저장하지도 않는다. true로 바꾸면 계층이 trace의 event를 `logs/` 아래 event 파일에 저장하고, 다시 false로 돌리면 다음 이벤트 경계에서 저장이 멈춘다. event 파일과 회전은 설정이 아니라 [event 계약](logging.ko.md#파일)이 정한다.

`diagnostics.log`는 event 로그의 [정책](logging.ko.md#정책)이다. `lifecycle`, `input`, `call`, `io`, `frame` 가운데 일부 class에 대해 저장할 가장 낮은 심각도(`off`, `error`, `warn`, `info`, `debug`, `trace`)를 이름 붙이는 객체다. 이름이 없는 class는 `error`만 저장하는 기본 정책을 따른다. 기본값 `{}`는 모든 class에서 `error`만 저장하므로, 표시 경로가 보이는 모든 오류의 기록이 남는다. 설정 파일로 지정하며, 다섯 class 밖의 이름과 여섯 수준 밖의 값은 설정 이름을 담은 오류로 거부된다. 페이지가 정책을 host에 보내면 host가 `<config-dir>/log-policy.json`을 쓰고, 모든 프로세스는 파일이 바뀔 때 이를 적용한다.

명령 `core.settings.debug {on}`은 두 설정을 함께 켜고 끈다. 켜면 `diagnostics.performance`를 true로, `diagnostics.log`를 모든 class에서 `trace`로 둔다. 끄면 `diagnostics.performance`를 false로, `diagnostics.log`를 `{}`로 둔다. 둘이 모두 꺼져 있는 동안 어떤 계층도 trace의 event나 `error` 아래의 event를 만들거나 저장하지 않는다.

## 플러그인

플러그인 페이지는 불러온 플러그인의 설정을 담는다. 플러그인의 설정, 섹션, 사이드바 선택은 불러온 manifest에서 오기 때문이다. 플러그인은 표면, 섹션, 설정, 계정을 함께 제공하는 한 단위다. 플러그인 참조를 담는 플러그인 설정의 각 컨트롤은, 값이 불러온 플러그인을 가리키지 않으면 배지 `<id> 필요`(warn)를 보인다([의존과 검증 규칙](#의존과-검증-규칙)). 불러오지 않은 플러그인은 창과 카드 선택자를 선언하지 않으므로, 플러그인 페이지는 정보 카드만 그리고 사이드바 묶음을 보이지 않는다.

플러그인 페이지는 설치됨, 찾아보기, 플러그인마다 한 페이지다. 페이지는 플러그인의 설명, 버전, 사이드카를 보여 주고 플러그인 작업을 실행한다. 플러그인 작업은 [애플리케이션의 플러그인 작업](installation.ko.md#애플리케이션-안의-plugin-작업)이, 작업이 적용하는 상태 변화는 [변경 적용](installation.ko.md#변경-적용)이 정의한다.

### 설치됨

페이지 설치됨의 제목은 `설치된 플러그인`, 설명은 `켜고 끄기, 업데이트, 문제 고치기. 하나를 누르면 그 플러그인의 정보와 설정이 한 페이지에 있다. 새로 찾는 일은 ‘찾아보기’ 화면에서 한다.`이며, 범위 컨트롤이 없다.

페이지는 `installed.json`이 나열하거나 창이 불러온 플러그인의 행을 보인다. 행 앞에는 해당할 때 다음 줄을 보인다.

- 레지스트리 인덱스가 더 새로운 core release를 나열하면 core 업데이트 행: `core: <running> → <available>`, 릴리스 페이지 링크(`core.app.release`를 실행), 버튼 `업데이트`(`core.app.update`를 실행). 이 행은 요소 `core.settings-tab.plugins.app`이고 링크는 `core.settings-tab.plugins.app-release`, 버튼은 `core.settings-tab.plugins.app-update`이며, 받을 수 있는 release에 맞지 않는 설치된 plugin마다 안내 요소 `core.settings-tab.plugins.incompatible`을 보인다. 업데이트 규칙은 [애플리케이션 업데이트](installation.ko.md#애플리케이션-업데이트)에 있다. 나열된 release가 맞지 않는 설치된 플러그인마다 알림 `<id> <installed> (<range>): <available>에 맞는 최신 버전 <version>`을 보인다. 맞는 버전이 없으면 `<id> <installed> (<range>): <available>에 맞는 버전 없음`이다. 알림은 요소 `core.settings-tab.plugins.incompatible`이다. 행의 링크는 요소 `core.settings-tab.plugins.app-release`이며 이름은 `릴리스 페이지`이고, 버튼은 요소 `core.settings-tab.plugins.app-update`다.
- 오래된 사이드카마다 `<running> → <installed>`와 버튼 `세션 <sessions>개를 끝내고 적용`. 선언되지 않은 사이드카에는 `세션 <sessions>개를 끝내고 종료`. 각 버튼은 `core.plugins.replace {sidecar}`를 실행한다. 선언되지 않은 사이드카의 실행 중인 서비스는 설치된 쪽을 `선언 없음`으로 보인다. 서비스가 version을 보고하지 않은 실행 쪽, 즉 이전 버전의 서비스는 `이전 버전`으로 보인다.

도구 행은 다음을 가진다.

- 검색칸, placeholder `설치된 플러그인 찾기`. `core.settings-tab.search {query}`를 실행한다. 검색은 플러그인의 이름, id, 설명, 분류 이름과 맞춘다.
- 세그먼트 거르기(라벨 `거르기`)의 선택지 `전체 <n>`, `사용 중 <n>`, `꺼짐 <n>`, `업데이트 <n>`, `문제 <n>`. 각 선택지는 `core.settings-tab.filter {filter}`를 `all`, `active`, `disabled`, `updates`, `problems` 중 하나로 실행한다. `updates` 필터는 `core.plugins.show-updates`가 고르는 필터다.
- 버튼 `모두 업데이트 (<n>)`(sm). 업데이트가 있는 플러그인이 있을 때 보인다. `core.plugins.update-all`을 실행한다.

행은 왼쪽부터 문자 아이콘(이름의 첫 글자, 강조색 토큰과 글자 토큰을 쓴다), 배지를 포함한 이름, 메타 줄 `분류 · 패키지 또는 키 · v<버전>`을 보인다. 메타 줄은 plugin이 선언한 plugin category, key, 알려진 경우의 version이며, 값이 없는 부분은 뺀다. registry index가 만든 이를 나열하지 않으므로 plugin의 만든 이는 보이지 않는다. 행의 오른쪽에는 다음 순서로 버튼이 있다.

1. 없는 필요 플러그인의 `<필요 이름> 설치`(sm). 필요 플러그인에 대해 `core.plugins.install {plugin}`을 실행한다.
2. 업데이트가 있으면 `업데이트`(sm). `core.plugins.update {plugin}`을 실행한다.
3. 스위치 `<이름> 사용`. 값에 따라 `core.plugins.enable {plugin}` 또는 `core.plugins.disable {plugin}`을 실행한다.
4. 아이콘 버튼 `<이름> 정보와 설정`(제목). `core.settings-tab.plugin {plugin}`을 실행해 플러그인 페이지를 연다.

행의 배지는 다음 순서로 나온다.

| 배지 | 톤 | 조건 |
| --- | --- | --- |
| `꺼짐` | neutral | `installed.json`이 플러그인을 끔으로 나열한다 |
| `업데이트 <latest>` | acc | 설치 버전이 `latest`보다 오래되었다 |
| `개발 빌드` | warn, 제목 `설치 <v> > 배포 <v>` | 설치 버전이 가장 새 배포 버전보다 새롭다. 버전은 숫자로 비교한다 |
| `<id> 필요` | warn | `dependencies`에 적힌 플러그인이 설치되지 않았다 |
| `필요한 플러그인 없음` | warn | 상태 `requires`: 창의 불러와 켜진 플러그인 가운데 이 플러그인이 요구하는 분류의 플러그인이 없다([플러그인 분류](plugins.ko.md#plugin-categories)) |
| `창을 다시 불러오면 적용` | warn | 상태 `reload`: `installed.json`이 창이 불러온 것과 다르다([변경 적용](installation.ko.md#변경-적용)) |
| `불러오지 못함` | warn | 상태 `refused`: 창이 플러그인의 항목이나 manifest를 거부했다 |

문제가 있는 행은 `dependencies`의 플러그인이 없거나, 상태가 `requires`이거나, 상태가 `refused`인 플러그인의 행이다. 필터 `문제`와 메뉴 배지는 문제가 있는 행을 센다.

행은 정렬한다. 문제가 있는 행이 먼저, 업데이트가 있는 행이 다음, 나머지가 마지막이다. 각 묶음 안에서는 `localeCompare`로 이름 순이다.

실행 중인 작업은 모든 행의 모든 동작을 비활성으로 만들고, 그 플러그인의 행에 `<plugin> <action> 진행 중`을 보인다. 실패한 작업의 오류는 행 아래에 보인다. host가 보류한 플러그인([영구 서비스](persistent-services.ko.md#updates))은 오류와 함께, 보류 항목의 동작에 따라 `세션 <n>개를 끝내고 업데이트`, `세션 <n>개를 끝내고 설치`, `세션 <n>개를 끝내고 사용` 가운데 하나의 버튼을 보인다. 이 버튼은 `{plugin, end: true}`로 `core.plugins.update`, `core.plugins.install` 또는 `core.plugins.enable`을 실행한다. `<n>`은 플러그인 사이드카의 `sessions` 합이다. 어떤 `sessions`가 `null`이면 버튼이 없다.

행 아래에는 점선 카드 `플러그인 찾아보기`가 있다. 카드는 `카탈로그 <N>개 중 <M>개를 더 설치할 수 있다. 설치 전에 필요한 플러그인을 확인한다.`를 말한다. `<N>`은 카탈로그 개수이고 `<M>`은 설치되지 않은 카탈로그 플러그인 수다. 버튼 `찾아보기`(primary, search 아이콘)는 `core.settings-tab.nav {page: "browse"}`를 실행한다. 필터에 맞는 행이 없으면 `맞는 플러그인이 없다.`를 보인다.

### 찾아보기

페이지 찾아보기의 제목은 `플러그인 찾아보기`, 설명은 `카탈로그 <N>개. 하나를 누르면 설치 전에 자세히 본다.`다. 범위 컨트롤이 없다.

- 검색칸, placeholder `이름, 기능으로 찾기`는 `core.settings-tab.browse {query}`를 실행한다. 카탈로그 플러그인의 이름, id, 설명과 맞춘다.
- 스위치 `설치한 것 숨기기`(기본 끔)는 `core.settings-tab.browse {hideInstalled}`를 실행한다.
- 개수 줄은 `<N>개`를 보이며, 검색어나 스위치가 목록을 거르면 `<shown> / <N>개`를 보인다.

행 하나가 카탈로그 플러그인 하나다. 행은 이름(버튼, 굵게), 필요한 플러그인이 설치되지 않았으면 배지 `<id> 필요`(warn), 한 줄 설명, 메타 줄 `<package> · v<latest>`를 보인다. 행의 오른쪽에는 다음이 보인다.

- 설치되지 않은 플러그인이면 `설치`(primary, sm, plus 아이콘). `core.plugins.install {plugin}`을 실행한다. 플러그인의 dependencies는 [dependencies](plugins.ko.md#pluginjson)가 정한 대로 함께 설치된다.
- 설치되어 켜져 있으면 배지 `설치됨`(ok).
- 설치되어 꺼져 있으면 배지 `설치됨 · 꺼짐`(neutral).

행을 누르면 `core.settings-tab.plugin {plugin}`을 실행해 뒤로 가기 링크 `‹ 찾아보기`가 있는 플러그인 페이지를 연다.

목록은 한 번에 30개 행을 보인다. 더 맞는 행이 있으면 버튼 `<n>개 더 보기`가 나온다. `<n>`은 누를 때 더해지는 행의 수다. 30개이고, 마지막 행에서는 더 적다. 버튼은 `core.settings-tab.browse {more: true}`를 실행한다. 맞는 것이 없으면 `맞는 플러그인이 없다.`를 보인다.

행은 이름의 `localeCompare` 순서로 정렬한다. 레지스트리 인덱스는 분류, 설치 수, 배포 날짜, 제작자를 나열하지 않으므로 페이지는 이들로 거르거나 정렬하지 않는다. 행은 manifest와 인덱스가 제공하는 필드만 보인다.

### 플러그인 페이지

플러그인 페이지는 뒤로 가기 링크, 제목(플러그인 이름), 설명을 가진다. 이름, id, 버전, 설명, 섹션, 설정, 계정, 분류는 불러온 manifest에서 온다. 최신 버전과 취소 여부는 레지스트리 인덱스에서 온다([레지스트리 인덱스](installation.ko.md#registry-index)). 레지스트리 항목의 설명은 manifest가 불러와지지 않은 동안에만 대신 보인다. installed.json만 나열하는 플러그인의 플러그인 페이지는 이름으로 플러그인 id를 쓰며 설명이 없다. 설명 줄은 요소 `core.settings-tab.plugins.about`이며, 플러그인에 설명이 있을 때만 보인다.

설치 전 페이지는 다음을 보인다.

- 문자 아이콘, 이름, 메타 줄 `<package or key> · v<latest>`, 버튼 `설치`(primary, plus 아이콘)를 가진 카드 행. 필요한 플러그인이 설치되지 않았으면 버튼은 `<필요 이름>와 함께 설치`가 된다.
- 라벨과 값으로 이루어진 정보 행:

| 라벨 | 값 |
| --- | --- |
| `필요` | `dependencies`의 이름. 설치되어 있으면 배지 `있음`(ok), 플러그인과 함께 설치되면 `함께 설치됨`(warn), 그 밖에는 `없음` |
| `사이드카` | 사이드카 각각의 이름과 범위, 없으면 `없음` |
| `더하는 것` | 불러온 manifest의 `사이드바 섹션 <n> · 설정 <n> · <기여>`, manifest가 불러와지지 않았으면 `—` |

- 줄 `설정을 선언한 플러그인은 설치하면 메뉴 ‘설정이 있는 플러그인’에 들어오고, 이 페이지에 그 설정이 나타난다.`

설치 후 페이지는 다음 행을 가진 정보 카드를 보인다.

- `사용`: 스위치 `<이름> 사용`. 값에 따라 `core.plugins.enable` 또는 `core.plugins.disable`을 실행한다. 메타 줄은 `<분류> · <패키지> · 설치 <버전>`을 보이고, 이어서 ` · 최신` 또는 ` · 배포 <버전>`, 그다음 사이드카와 기여를 보인다. 배지 `개발 빌드`는 목록과 같이 보인다. 업데이트가 있으면 버튼 `<배포 버전>로 업데이트`(sm)가 나오며, `core.plugins.update {plugin}`을 실행한다.
- `필요`: `dependencies`의 플러그인이 설치되지 않았을 때만 있는 행. 경고 줄 `필요한 <이름>(<키>) 플러그인이 설치되어 있지 않다.`와 버튼 `<이름> 설치`(primary, sm)를 보인다. 버튼은 그 플러그인에 `core.plugins.install {plugin}`을 실행한다.
- `제거`: 설명 `설정 값은 남겨 두고, 다시 설치하면 이어서 쓴다.`와 버튼 `제거…`(danger, sm). 누르면 버튼 `취소`(ghost, sm)와 `제거`(danger, sm)를 보인다. `제거`는 `core.plugins.remove {plugin}`을 실행하고 설치됨으로 돌아간다.

보류된 작업과 플러그인 행의 오류 줄은 플러그인 페이지의 `사용` 행에도 나타난다.

정보 카드는 플러그인의 기여마다 한 줄을 보인다: `<point> 기여 <n>: <state>`. `<n>`은 플러그인 `contributes`에서 항목의 번호다. 줄은 요소 `core.settings-tab.plugins.contribution`이며, 상태는 `연결됨`(connected), `제공자 없음`(provider-missing), `version 불일치`(version-mismatch)다. 잘못된 기여(invalid)는 상태 대신 `<point> 기여 <n>: <reason>`을 보이며, 같은 글이 오류 표시 경로로 가서 오류로 표시된다. 기여가 맞게 되면 오류를 거둔다.

정보 카드 아래에는 다음 순서로 묶음이 있다: `계정`, `설정`, `섹션`, `창 사이드바`, `카드 사이드바`. 묶음은 제목과 설명을 보인다. `계정`은 `에이전트 CLI 계정.`, `설정`은 `플러그인이 선언한 설정.`, `섹션`은 `이 플러그인이 사이드바에 제공하는 섹션.`이다. 묶음 `설정`은 항상 보이며, 플러그인이 설정을 선언하지 않으면 `이 플러그인에는 설정이 없다.`를 보인다. 다른 묶음은 비어 있으면 보이지 않는다.

묶음 `계정`은 [계정](plugins.ko.md#accounts)을 선언한 플러그인에만 있다. 계정 목록은 계정마다 행 하나를 가진다. 행의 요소는 `core.settings-tab.account`이고 `id`를 가진다. 행은 식별자, CLI, 로그인 상태(`로그인됨`(ok) 또는 `로그인 안 됨`(neutral)), 사용량 줄을 보이며, 버튼 `로그인`, `취소`, `로그아웃`, `이름 변경`, `삭제`를 가진다. 요소는 각각 `core.settings-tab.account-login`, `account-login-cancel`, `account-logout`, `account-edit`, `account-remove`다. 이름을 바꾸는 행은 칸과 버튼 `core.settings-tab.account-edit-name`, `account-save`, `account-edit-cancel`을 보인다. 마지막 행 `새 계정`은 placeholder `새 계정 식별자`의 칸(`core.settings-tab.account-name`), CLI 종류 셀렉트(`core.settings-tab.account-kind`), 버튼 `추가`(`core.settings-tab.account-add`)를 가진다. 칸이 비면 `추가`는 비활성이다. 거부된 식별자는 칸 아래에 `소문자, 숫자, _ - 만 쓸 수 있다.` 또는 `이미 있는 식별자다.` 줄을 보인다. 묶음의 명령은 `core.accounts.add`, `core.accounts.rename`, `core.accounts.remove`, `core.accounts.login`, `core.accounts.login-cancel`, `core.accounts.logout`이며 각각 `{plugin, ...}`을 받는다. 페이지의 스크롤 영역은 요소 `core.settings-tab.pane`이다.

묶음 `설정`은 manifest가 선언한 설정마다 행 하나를 manifest 순서로 보인다. 행의 이름은 `label`이고, 선언에 `description`이 있으면 이름 아래에 보인다. 컨트롤은 형식을 따른다([컨트롤](#컨트롤)).

묶음 `섹션`은 플러그인이 선언한 섹션 이름을 읽기 전용 칩으로 보인다.

묶음 `창 사이드바`의 설명은 `이 플러그인의 탭이 포커스 카드의 활성 탭인 동안 쓰는 창 사이드바. 세트를 고른 변만 바뀌고, 위에 있는 줄부터 자리를 잡는다.`다. 이 묶음은 스위치 없이 [작업 공간](#작업-공간)의 사이드바 묶음과 같은 행 네 개의 목록을 보인다. 번호, 변 이름, 프로젝트 배지, 세트 셀렉트, ↑와 ↓ 버튼이다. 세트 셀렉트는 `core.settings.link {place: "window-<side>", plugin, set, scope}`를 실행한다. 순서는 `core.settings.change {key: "<plugin>.win.order", value, scope}`를 실행하며 `value`는 새 순서 전체다. 프로젝트 범위의 배지와 지우기 버튼은 [작업 공간](#작업-공간) 사이드바 묶음의 규칙을 따른다. 프로젝트가 링크나 순서를 덮어쓴 행은 배지 `<project> 값`을 보이고, 버튼 `<project> 값 지우기`는 프로젝트가 덮어쓴 `links`와 `<plugin>.win.order`마다 `core.settings.reset {key, scope: "project"}`를 한 번씩 실행한다. 기본 순서는 `left`, `right`, `top`, `bottom`이다.

묶음 `카드 사이드바`의 설명은 `카드 안쪽 네 변. 세트를 고른 변만 보이고, 위에 있는 줄부터 자리를 잡는다. 순서는 이 플러그인의 카드에만 적용된다.`다. `card-<side>` 연결과 키 `<plugin>.card.order`로 같은 방식으로 동작한다. 표면을 가진 플러그인에만 보인다.

플러그인마다 선언이 허용하는 창 셀렉터와 카드 셀렉터가 있다. 플러그인은 자기 설정, 섹션, 계정을 선언하며, 핵심 페이지는 플러그인 이름이나 플러그인 설정을 코드에 적지 않는다.

### 플러그인 명령

`core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable`, `core.plugins.disable`은 `{plugin}`을 받고 자기 동작으로 host call `pluginsRun`을 실행한다. `core.plugins.install`, `core.plugins.update`, `core.plugins.enable`은 `end: true`도 받으며 이를 `pluginsRun`에 넘긴다. `plugin`이 비지 않은 문자열이 아니거나 `end`가 있으면서 `true`가 아니면 명령은 -32602(invalid params)로 실패한다. 작업이 실패하거나 다른 작업이 실행 중이면 host 오류로, host가 없으면 "plugin operations need a native host"로 실패한다. 명령은 host를 부르기 전에 작업을 `core.plugins`에 기록하고, 부른 뒤 결과를 기록한다.

`core.plugins.apply`는 창의 수정된 탭마다 묻고, [변경 적용](installation.ko.md#변경-적용)이 정한 대로 작업 공간을 다시 시작한다. 새로 시작하기 전에 `{reloaded: true}`로 답하고, 탭이 남으면 `{reloaded: false}`로 답한다.

`core.plugins.replace {sidecar}`는 host call `sidecarsReplace`를 실행한다([영구 서비스](persistent-services.ko.md#updates)). `sidecar`가 비지 않은 문자열이 아니면 -32602(invalid params)로, 교체가 실패하면 host 오류로 실패한다.

`core.plugins.registry {index}`는 host call `pluginsUseRegistry`를 실행하고 플러그인 상태를 다시 읽는다. `index`가 비지 않은 문자열이 아니면 -32602(invalid params)로, 인덱스를 읽거나 검사할 수 없으면 host 오류로 실패한다.

`core.plugins.update-all`은 매개변수를 받지 않는다. 업데이트가 있는 플러그인마다 id 순서로 host call `pluginsRun`을 action `update`로 하나씩 실행한다. 각 실행 뒤 플러그인 상태를 다시 읽고, 첫 실패에서 host 오류로 멈춘다. host가 없거나 다른 작업이 실행 중이면 "plugin operations need a native host"로 실패하며, 업데이트가 없으면 아무것도 하지 않는다.

`core.plugins.browse`는 설정 탭을 설치됨에서 연다. `core.plugins.show-updates`는 설정 탭을 필터 `updates`의 설치됨에서 열고 목록의 맨 위로 스크롤한다. 창 바에는 업데이트 컨트롤이 없다([창 도구](external-sidebars.ko.md#창-도구)). 설치됨의 메뉴 배지가 업데이트 수를 보이고, 필터 선택지 `업데이트 <n>`이 그 plugin을 나열한다.

페이지는 보일 때, 각 `plugins-changed` 이벤트 뒤, 각 `sidecars-changed` 이벤트 뒤에 host의 플러그인 상태와 오래된 사이드카를 읽는다. 페이지가 가진 것과 같은 값을 찾는 읽기는 아무것도 그리지 않는다.

host가 없는 browser 애플리케이션에서는 페이지가 불러온 플러그인만 `loaded`로 보이며, 동작은 없다.

## 컨트롤

창은 설정의 형식으로 정하는 고정된 컨트롤 묶음 가운데 하나로 모든 설정을 그린다([값](#값)과 [플러그인](plugins.ko.md)의 플러그인 설정 선언). 형식마다 컨트롤은 정확히 하나이며, 어떤 설정도 자기만의 컨트롤을 갖지 않는다. 컨트롤 선택은 다음 규칙을 따른다.

- 나열된 값이 둘이나 셋이면 세그먼트.
- 나열된 값이 넷 이상이면 셀렉트.
- 켬/끔이면 스위치.
- 단위가 붙은 연속 정수이면 값과 단위를 옆에 둔 슬라이더.
- 작은 정수이면 단위가 안에 붙은 스테퍼 `− value +`.
- 문자열 값이면 한 줄 글자 입력. 식별자와 주소는 고정폭 글꼴을 쓴다.

| 형식 | 컨트롤 | 명령 |
| --- | --- | --- |
| 불리언(`left`, `right`, `top`, `bottom`, `dim`, `memorySaver`, `autoDismissProblemToasts`) | 스위치 | `core.settings.change {key, value, scope}` |
| 나열된 값 둘이나 셋(`projectOpening`, `mode`, `focusInd`, `fullRule`, `cardArrange`, `language`, `viewProcess`, 세트 배치, 값이 둘이나 셋인 플러그인 `enum`) | 세그먼트 | `core.settings.change {key, value, scope}` |
| 나열된 값 넷 이상(`font`, `textSize`, `projectTabs`, 값이 넷 이상인 플러그인 `enum`) | 선언 순서대로 값마다 항목이 있는 셀렉트 | `core.settings.change {key, value, scope}` |
| 카탈로그의 테마(`theme`) | 테마마다 그 테마의 색과 형태로 그린 견본 하나를 가진 견본 격자 | `core.settings.theme {name, scope}` |
| 단위가 붙은 경계 정수(`gap`, `radius`, `memorySaverDelay`, [배치 값](#배치-값), 연속 범위의 플러그인 `integer`) | 경계 사이의 슬라이더. 값과 단위를 보인다. 끌기 동안 각 값을 슬라이더 옆에 보이고, 놓을 때의 값으로 명령을 한 번 실행한다 | `core.settings.change {key, value, scope}` |
| 작은 경계 정수(`size`, `problemToastDismissSeconds`, 좁은 범위의 플러그인 `integer`) | 단위가 붙은 스테퍼 `− value +` | `core.settings.change {key, value, scope}` |
| 문자열(플러그인 `string`) | 한 줄 글자 입력 | `core.settings.change {key, value, scope}` |
| 주소(플러그인 `address`) | 고정폭 글꼴의 한 줄 글자 입력. 빈 값이나 `http://` 또는 `https://`로 시작하는 값을 받는다. 그 밖의 값은 칸 아래에 `http:// 또는 https:// 로 시작하는 주소여야 한다.`를 보인다 | `core.settings.change {key, value, scope}` |
| 분류의 플러그인(플러그인 `plugin`, [플러그인 분류](plugins.ko.md#plugin-categories)) | 불러오고 켜진 해당 분류의 플러그인마다 이름을 붙인 항목 하나를 가진 셀렉트 | `core.settings.change {key, value, scope}` |
| 세트 참조([사이드바 선택](#사이드바-선택)의 연결) | 항상 셀렉트. `사용 안 함`과 모든 세트, 세트마다 힌트 | `core.settings.link {place, plugin, set, scope}` |
| 순서가 있는 변 목록(`sidebarOrder`, `<plugin>.win.order`, `<plugin>.card.order`) | 현재 순서대로 변마다 행 하나, 변 이름으로 이름 붙임. 첫 행에는 ↑가 없고 마지막 행에는 ↓가 없다 | 새 목록 전체를 `value`로 한 `core.settings.change {key, value, scope}` |
| 계정 목록(플러그인의 [계정](plugins.ko.md#accounts)) | 계정마다 행 하나와 행 `새 계정` | `{plugin, ...}`를 받는 `core.accounts.add`, `core.accounts.rename`, `core.accounts.remove`, `core.accounts.login`, `core.accounts.login-cancel`, `core.accounts.logout` |

세트 편집기도 같은 컨트롤을 쓴다. 이름은 글자 입력, 배치는 세그먼트, 섹션 행은 셀렉트와 ▲ ▼ −다. 버튼(`편집`, `삭제`, `새 세트`, `완료`, `+ 섹션 추가`, `목록`, `찾아보기`, `설치`, `업데이트` 등)은 동작을 실행하며 설정 컨트롤이 아니다. 변 행의 ▲ ▼는 순서의 컨트롤이다. 범위 컨트롤의 칩은 범위를 고르며 설정이 아니다. `sets`, `diagnostics.performance`, `diagnostics.log`처럼 이 표에 컨트롤이 없는 설정은 자기 명령이나 설정 파일로 바꾼다.

창은 `~/Projects/polyspec/crudui`의 폼 라이브러리로 그리지 않고 이 컨트롤 묶음을 직접 정한다. 그 라이브러리는 폼 template을 compile하고, 애플리케이션이 한 번에 제출하는 record를 bind하며, 행 identity, undo history, `name` 기반 컨트롤과 자기 event binding(`connectForm`)을 가진다. 설정 탭은 바뀐 값을 선언된 명령으로 바로 적용하고, 모든 컨트롤은 공유 binder로 자기 명령을 가리키며 요소 이름을 가진다([exposure](exposure.ko.md)). host는 listener가 동작하지 않는 컨트롤 사본을 그린다([네이티브 모달](native-modals.ko.md)). 라이브러리의 markup과 binding은 출력을 다시 쓰는 층 없이는 이 규칙을 만족하지 않는다. 플러그인 설정 선언에는 위 표의 형식만 필요하므로 의존성을 더할 이유가 없다.

컨트롤의 크기와 키는 다음과 같다.

- 입력칸과 셀렉트는 높이 28pt이고, 작은 버튼(sm)은 높이 24pt이며, 행은 높이 36pt 이상이다.
- 셀렉트 박스는 ↑와 ↓로 강조를 옮기고, Enter로 고르고, Escape로 닫고, Tab으로 나간다. 각 선택지는 끝에 힌트를 보인다. 컨트롤 아래에 공간이 없으면 목록은 위로 열린다.
- 글자 입력칸은 Enter와 포커스 해제(blur) 때 값을 저장한다.
- 값을 바꾸는 키 입력은 자기 컨트롤의 명령을 실행한다. 포커스나 강조만 옮기는 키는 명령을 실행하지 않는다.
- 컨트롤의 모든 색은 적용된 테마의 토큰이다. 배지의 톤은 `ok`, `warn`, `err`, `acc`, `neutral` 중 하나이며 테마 토큰으로 그린다. `ok`와 `acc`는 `rail`, `warn`은 `focus`, `err`는 `no`, `neutral`은 `muted`를 쓴다. 테마에 다른 토큰이 없으므로 `ok`와 `acc`는 배지의 글자로 구별한다.

### 의존과 검증 규칙

- 탭의 모든 오류 줄은 `error: <where>: <text>`를 애플리케이션 log에 쓰는 표시 경로([exposure](exposure.ko.md))를 거쳐 보이며, 이것이 탭에서 빨간 글을 쓰는 유일한 경우다. 잘못된 칸은 칸 아래에 오류 줄을 보인다. 칸은 사람이 입력한 값을 유지하고, 저장된 값은 바뀌지 않는다.
- 여러 칸에 걸친 규칙은 묶음 아래에 오류 줄을 보이며, 고칠 방법이 있으면 고치기 버튼을 붙인다. [배치 값](#배치-값)의 폭 규칙이 예다.
- 실패한 세트 섹션, setup 상태의 part 오류 같은 행 오류는 같은 경로로 행이 있는 자리에 오류 줄을 보인다.
- 상태를 나타내는 배지(`없음`, `불러오지 못함`, `<id> 필요`)는 톤 warn 또는 neutral을 쓰며, err를 쓰지 않는다.
- 다른 설정에 딸린 설정은 그 설정 아래에 들여 쓴다. 부모가 꺼지면 비활성이다. `memorySaverDelay`는 `memorySaver`에, `problemToastDismissSeconds`는 `autoDismissProblemToasts`에 딸린다.
- 세트 이름 칸이 비면 `이름이 필요하다.`를 보인다. 계정 식별자 칸은 잘못된 식별자에 `소문자, 숫자, _ - 만 쓸 수 있다.`를, 중복된 식별자에 `이미 있는 식별자다.`를 보인다.
- 변 이름은 `왼쪽`, `오른쪽`, `위`, `아래`다. `상단`과 `하단`은 쓰지 않는다.

## 값

핵심 설정은 형식 하나를 받는다. 설정 파일을 읽을 때와 모든 변경마다 값을 형식과 대조한다. 형식이 다른 값은 `Invalid setting <key>: <value>`와 이유로 실패한다. 읽기는 오류를 보고하고 아무것도 바꾸지 않으며, 변경은 -32602(invalid params)로 실패하고 아무것도 바꾸지 않는다. `core.settings.change`는 설정의 형식에 맞는 값이나, 컨트롤의 문자열을 받는다. 문자열은 설정이 선언한 불리언이나 숫자가 된다. 그 밖의 입력은 변환하지 않으므로 다른 형식의 값은 거부된다. `sidebarOrder`처럼 목록 형식의 설정은 목록 전체를 배열로 받는다.

| 키 | 형식 |
| --- | --- |
| `projectOpening` | `tabs` 또는 `windows`, 전역 범위 |
| `theme` | `midnight`, `nord`, `solar`, `forest`, `ember`, `slate`, `mist`, `grape`, `sand`, `paper` |
| `mode` | `dark` 또는 `light` |
| `font` | `mono-system`, `mono-sf`, `mono-jet`, `sans-system`, `sans-inter` |
| `gap` | 0부터 48까지의 정수(px). 인접한 두 카드 사이의 간격 전체다. 평면과 스테이지 가장자리 사이의 여백은 간격의 절반이다. 0이면 두 카드가 한 줄을 공유한다. 평면 간격은 테두리 너비이고, 카드는 자기 테두리와 모서리를 그리지 않는다. 탭 드래그의 drop zone은 모서리를 그리지 않고 테두리 너비의 테두리를 그린다. 스테이지는 여백이 없고 위 줄을 space bar의 아래 줄과 공유한다. 프로젝트 탭이 왼쪽에 있으면 왼쪽 줄도 프로젝트 열의 오른쪽 줄과 공유한다. 그래서 평면의 가장자리는 양쪽에서 한 줄이다(seam) |
| `radius` | 0부터 24까지의 정수(px) |
| `size` | 10부터 18까지의 정수(px) |
| `textSize` | [글자 크기 단계](text-size.ko.md)의 값, 전역 범위, 기본값 1 |
| `projectTabs` | `top`, `bottom`, `left` 또는 `right`, 기본값 `top`. `top`은 프로젝트 탭을 로고 옆 제목줄에 둔다. `bottom`은 작업 영역 아래의 줄에 둔다. `left`와 `right`는 작업 영역의 그 변에 있는 열에 둔다. 프로젝트 홈은 어느 위치에서도 프로젝트 탭을 그리지 않는다 |
| `left`, `right`, `top`, `bottom`, `dim`, `diagnostics.performance` | 불리언. `left`와 `right`의 기본값은 `true`, `top`과 `bottom`은 `false`, `dim`과 `diagnostics.performance`는 `false` |
| `sidebarOrder` | `left`, `right`, `top`, `bottom`이 각각 한 번씩 들어 있는 배열. 기본값은 `["left", "right", "top", "bottom"]`이며, 창 사이드바가 평면의 공간을 차지하는 순서다([외부 창 사이드바](external-sidebars.ko.md#고정-배치와-저장)). 반복되거나 빠지거나 다른 값은 `Invalid setting sidebarOrder: <value> is not an order of "left", "right", "top", "bottom"`으로 거부된다 |
| `<plugin>.win.order`, `<plugin>.card.order` | `sidebarOrder`와 같은 형식의 배열. 기본값은 `["left", "right", "top", "bottom"]`이며, 플러그인 자기 설정의 범위를 따른다 |
| `diagnostics.log` | class와 수준의 객체 |
| `focusInd` | `border` 또는 `corner` |
| `fullRule` | `under`, `over`, `none` |
| `cardArrange` | `resize`(배치를 지키고 카드 크기를 고르게 나눈다. 기본값) 또는 `even`(카드를 같은 격자로 놓는다, `arrange("even")`). 카드 자동 정렬 명령은 이 설정의 값을 실행하며, 도구 아이콘이 이 값을 보인다 |
| `language` | `auto` 또는 애플리케이션 메뉴의 언어(`ko`, `en`) |
| `sidebarMinWidth`, `sidebarMaxWidth`, `sidebarWidth` | [배치 값](#배치-값) |
| `viewProcess` | `plugin` 또는 `view`, 전역 범위, 기본값 `plugin`. host가 이후에 만드는 보기의 WebContent 프로세스다. 플러그인의 보기끼리 공유하거나 보기마다 따로 둔다([view 프로세스](plugin-processes.ko.md#view-프로세스)) |
| `memorySaver` | 불리언, 전역 범위, 기본값 `true`. [메모리 절약](plugins.ko.md#메모리-절약)이 숨긴 탭을 내린다 |
| `memorySaverDelay` | 5부터 720까지의 정수(분), 전역 범위, 기본값 120. 탭이 숨겨진 뒤 메모리 절약이 내리기까지의 시간이다. 다른 값은 `Invalid setting memorySaverDelay: <value>`로 거부되며, 변경은 스케줄러를 다시 맞춘다 |
| `autoDismissProblemToasts` | 불리언, 전역 범위, 기본값 `false`([알림](notifications.ko.md#설정)) |
| `problemToastDismissSeconds` | 1부터 60까지의 정수(초), 전역 범위, 기본값 5([알림](notifications.ko.md#설정)) |
| `sets`, `links` | [저장되는 세트와 연결](#저장되는-세트와-연결) |

모드, 폰트, 메뉴 언어와 기본 언어, 그리고 이 설정들의 기본값, 범위, 선택지, 스위치, 전역 전용 키는 `packages/workbench/workbench.json`의 설정에 한 번 선언한다. `settings.js`와 `text-size.js`는 그 파일을 JSON 모듈로 가져오며, 이 값들을 정의하지 않는다. 브라우저 런타임은 전역 전용 키를 그 파일에서 가져온다. 각 언어 host 라이브러리는 그 파일의 사본을 담고 전역 전용 키를 거기서 읽는다. 사본이 원본과 다르면 `make check-exposure`가 실패한다. `gap`, `radius`, `font`, `size`의 기본값은 그 파일에서 적용된 테마의 shape 값이다.

플러그인 설정은 선언의 형식을 따른다([플러그인](plugins.ko.md)).

## 이전 형식

설정 파일은 `format` 멤버로 자기 형식을 나타낸다. format 1이 현재 형식이며, 다른 형식이거나 멤버가 없는 파일은 거부된다([저장 데이터 형식](installation.ko.md#저장-데이터-형식)). 이 멤버는 저장 형식을 나타내는 표지이며 설정이 아니다. 작업 공간은 이를 스냅샷에서 숨기고 쓸 때 보존한다. `format`이라는 이름의 설정 키는 다른 알 수 없는 키처럼 거부된다. 이 절의 나머지는 표지 뒤의 설정에 적용된다.

설정 파일은 현재 형식으로만 읽으며, 페이지는 형식을 바꾸지 않는다. 선언되지 않은 키는 이전 설정의 키(`cardSidebar`, `rail`, `railWidth`, `sidebarFoldedWidth`, `latency`, `skew`, `cardSplit`, `autoDismissErrorToasts`, `errorToastDismissSeconds`)를 포함해, 전역 설정에서는 `settings.json: unknown setting <key>`로, 창이 여는 프로젝트의 설정에서는 `<project root>/.soksak/settings.json: unknown setting <key>`로 실패한다. `rail` 링크, 플러그인 이름을 가진 변 링크(`left`, `right`, `top`, `bottom`), 범위가 가지지 않은 세트에 대한 링크는 아래 [저장되는 세트와 연결](#저장되는-세트와-연결)의 검사에서 실패한다. 실패하면 아무것도 바꾸지 않고 아무것도 쓰지 않는다.

## 저장되는 세트와 연결

`sets`와 `links`는 설정이다. 기본값은 정규화된 플러그인 사이드바 선언에서 온다. `environment.json`의 명시적 `sidebars`가 있으면 그것이 기본값을 대신한다. 변경은 다른 설정처럼 [범위 규칙](#컨트롤의-범위)이 주는 범위에 목록 전체를 쓴다. 프로젝트가 `sets`나 `links`를 덮어쓰면 전역 목록을 대체한다.

세트는 `{id, title, sections, layout}`이다.

- `id`: 목록에서 유일한 비지 않은 문자열. 만든 세트는 목록의 어느 세트도 쓰지 않는 가장 작은 양의 `n`으로 `set-<n>`을 받는다.
- `title`: 1자부터 40자까지의 문자열.
- `sections`: 반복 없는 섹션 id.
- `layout`: `list` 또는 `tabs`([플러그인](plugins.ko.md#섹션)).

연결은 `environment.json`의 `sidebars.links` 규칙을 따르는 `{place, plugin, set}`이다. 유효한 `sets`와 `links`는 플러그인 api 함수 `validateSidebars`와 `checkSidebarReferences`로 검사하며, 이 함수들은 `environment.json`의 `sidebars`도 검사한다. 네이티브 워크벤치는 같은 규칙을 같은 메시지로 검사하고, 창은 검사를 통과한 목록을 다시 검사하지 않고 받는다. 검사는 설정을 읽을 때와 변경을 저장하기 전에 실행한다. 불러온 플러그인이 선언하지 않은 섹션을 이름 붙인 세트, 표면이 없는 플러그인을 가리키는 카드 변 연결, 없는 세트를 가리키는 불러온 플러그인의 연결은 실패한다. 불러오지 않은 플러그인을 가리키는 참조는 유지한다. 제거된 플러그인만 선언한 세트를 가리키는 연결도 유지하며, 플러그인을 다시 설치하면 다시 쓴다([불러오지 않은 플러그인](plugins.ko.md#불러오지-않은-플러그인)). 실패는 다음처럼 보고한다. 읽기는 오류를 보고하고 아무것도 바꾸지 않는다. 변경은 -32602(invalid params)로 실패하고 아무것도 바꾸지 않는다.

세트를 삭제하면 남은 세트와, 삭제된 세트를 가리키지 않는 연결을 같은 범위에 한 번의 변경으로 쓴다.

## 사이드바 선택

없는 연결은 `off`를 명시적으로 고른 것이다. 모든 선택기는 현재 값이 제시한 선택지 밖이면 거부한다. 브라우저가 첫 항목을 고르게 두지 않는다.

| 연결 | 뜻 |
| --- | --- |
| `{place: "left", "right", "top" or "bottom", plugin: null, set}` | 그 변 고정 창 사이드바의 일반 내용 |
| `{place: "window-left", "window-right", "window-top" or "window-bottom", plugin, set}` | 그 변 고정 창 사이드바의 플러그인 내용 재정의 |
| `{place: "card-top", "card-bottom", "card-left", or "card-right", plugin, set}` | 플러그인 카드의 그 내부 변에 대한 기본 세트 |

모든 `set`은 알려진 세트 ID다. 각 place와 plugin 쌍은 한 번만 나온다. 플러그인 변 연결, null 세트, rail 연결은 거부한다. 세트 ID `off`와 `inherit`은 예약되어 있다. 고정 사이드바 선택과 재정의 rail 경계선은 [외부 창 사이드바](external-sidebars.ko.md)를 따른다. 변의 스위치는 선택을 바꾸지 않고 그 변의 고정 사이드바를 숨긴다. 스위치가 꺼진 변에 플러그인 세트를 고르면 연결은 저장되지만 그 변에는 아무것도 그리지 않는다. 플러그인 세트는 보이는 변의 내용만 바꾼다.

`core.settings.link {place, plugin, set, scope}`는 세트 ID를 받아 연결을 저장하고, `off`를 받아 연결을 지운다. `inherit`은 모든 기본 연결에 대해 -32602로 실패한다. 별도의 `core.card.sidebar.set` 명령은 여전히 `inherit`을 받아 특정 카드의 명시적 재정의를 지운다([예제 모델](example-model.ko.md)).

## 배치 값

다음 값은 `plane.js`와 `app.css`의 상수였다. 지금은 핵심 설정이며, 작업 공간 › 사이드바 크기에 보이고 단위는 포인트의 정수다.

| 키 | 라벨 | 기본값 | 범위 | 쓰임 |
| --- | --- | --- | --- | --- |
| `sidebarMinWidth` | 최소 폭 | 120 | 60–800 | 카드 내부 사이드바의 가장 작은 폭 |
| `sidebarMaxWidth` | 최대 폭 | 480 | 60–800 | 카드 내부 사이드바의 가장 큰 폭 |
| `sidebarWidth` | 처음 폭 | 190 | 60–800 | 카드 내부 사이드바의 처음 크기이며, 저장된 크기가 없는 창 사이드바의 축 방향 크기다. 왼쪽과 오른쪽 사이드바는 폭, 위와 아래 사이드바는 높이다 |

세 값은 60부터 800 포인트까지의 같은 범위를 쓰며, 슬라이더도 그 범위를 쓰므로 같은 값은 같은 슬라이더 위치에 놓인다. `sidebarMinWidth` ≤ `sidebarWidth` ≤ `sidebarMaxWidth`가 거짓이 되는 변경은 -32602(invalid params)로 실패하고 아무것도 바꾸지 않는다. 현재 범위 밖에 저장된 카드 폭은 손잡이가 바꾸기 전까지 저장된 대로 그린다.

두 워크벤치가 읽는 배치 값은 `workbench.json`의 chrome metric 하나를 출처로 가진다. 카드 머리 `head-h`와 바닥 `foot-h`가 있다. 머리는 대상 검색의 탭 줄이기도 하다. 대상 검색 띠의 폭 `drop-band`와 여백 `drop-band-margin`이 있다([대상 검색](groups.ko.md#target-찾기)). 탭 줄 임계값 `tab-peek-w`, `tab-min-w`, `tab-grab-w`도 있다. 워크벤치 코드마다 값을 쓰면 값이 어긋나는 사본이 생기기 때문이다. 새 공간의 창 사이드바 크기는 `environment.json`의 `workspace.grid` 카드에서 온다.

워크벤치 스타일시트(`app.css`, `home.css`, `settings.css`, `overlay.html`)의 길이, 비율, 지속 시간은 `packages/workbench/workbench.json`의 chrome metric이다. 워크벤치는 페이지를 그리기 전에 각 값을 문서 루트의 custom property로 설정하고, 스타일시트는 custom property를 읽는다. 스타일시트는 길이, 비율, 지속 시간의 리터럴을 가지지 않는다. 포커스 표시는 포커스된 카드의 본문 밖에서 모든 변에 `focus-mark-t`만큼 떨어져 선다. 그래서 획이 표면을 덮지 않는다.

워크벤치의 모든 글은 chrome metric의 줄 높이 `line-height`를 가진다. body가 값을 주고 글이 상속한다. 규칙이 `line-height-tight`를 지정한 글은 예외다. `font` 축약형은 줄 높이를 `normal`로 재설정한다. 그 값은 글꼴이 정하며 chrome metric이 정하지 않는다. 그래서 축약형으로 글꼴을 정하는 규칙은 줄 높이도 함께 적는다. 섹션 머리의 이름과 `tabs` 세트 탭의 이름은 크기 `section-head-text`에서 `line-height`를 가지며 머리 가운데에 선다. 네이티브 워크벤치도 같은 줄 높이로 이 글을 그리므로, 섹션 이름 요소는 모든 host에서 같은 높이와 자리를 가진다. 페이지의 줄 상자는 줄 높이의 정수 포인트를 모두 차지한다. 12에 1.45를 곱한 계산 줄 높이 17.4는, WebKit 21624.5.1.11.3(macOS 26.6.2)에서 그 글의 각 줄이 17의 높이로 배치된다. 세 줄은 51이다. 고정 줄 높이 20.7은 20으로 배치된다. 네이티브 워크벤치의 글도 같은 정수 포인트로 각 줄을 배치한다(`v0.7.4-244-g4abb83d-soksak.11`의 mygo fork). 워크벤치는 탭의 가운데처럼 자기가 계산하는 자리의 줄을 같은 규칙으로 센다(`packages/workbench-mygo/src/shell.go`의 `lineBox`).

페이지의 input과 select는 자기 규칙이 없으면 브라우저가 정한 모양을 쓴다. 이 모양은 페이지의 색 체계를 따른다. 그래서 스타일시트는 이를 선언하지 않는다. 네이티브 워크벤치는 `workbench.json`의 `plainControls` 값으로 이를 그린다. 이 값은 페이지의 window가 측정한 값이며, 어떤 스타일시트도 이 표를 읽지 않는다. 워크벤치는 브라우저가 하는 동작도 한다. Escape는 검색을 비우고, Tab은 이동한 칸의 글을 고르며, 포커스 명령은 포커스를 받지 않은 칸의 글을 고르고 이미 포커스를 가진 칸의 선택은 그대로 둔다. 검색의 돋보기와 취소 표시는 브라우저가 그리는 시스템 기호이며, 그 기호가 없는 시스템은 오류다.

그런 컨트롤의 포커스 링은 어두운 외형의 시스템 포커스 색이다. 페이지는 항상 어두운 외형이므로 이 색은 강조색을 따르며, 어떤 선언도 이를 정하지 않는다. 다른 색은 시스템을 따르지 않는다. 플레이스홀더는 브라우저 스타일시트의 색이다. 검색의 돋보기와 취소는 글의 색과 상관없이 자기 색을 가진 시스템의 이미지다.

워크벤치의 스크롤 영역은 시스템의 스크롤러 스타일을 따른다. 오버레이 스타일에서 스크롤 바는 공간을 차지하지 않는다. 클래식 스타일에서 내용이 넘치는 영역은 세로 바의 폭을 차지한다. 이 폭은 legacy 스타일에 대한 AppKit의 `scrollerWidthForControlSize:scrollerStyle:` 값이며, `scrollbar-width:thin` 영역의 보통 크기는 17포인트, 작은 크기는 13포인트다. 폭은 내용을 배치하는 폭에서 계산하며, 가로 바도 같은 방식으로 높이를 가진다. 페이지 host의 web view가 이를 하고, mygo 프레임워크는 스타일, 변경 알림, 두 폭을 AppKit에서 읽어 같게 한다. 메뉴의 목록은 두 워크벤치의 유일한 thin 영역이다.

## 성능

설정 탭은 모든 페이지에 적용되는 다음 규칙을 지킨다.

- 각 행은 라벨 영역과 컨트롤 영역을 가진다. 컨트롤 영역은 폭 260포인트이고 pane의 모든 행에서 같은 x에서 시작하며, 라벨 영역은 남은 폭을 쓴다. 라벨이 없는 행도 빈 라벨 영역을 둔다. pane의 폭은 layout pass마다 한 번 읽고 행은 측정하지 않으므로, 값이 바뀌어도 행이 움직이지 않는다. 브라우저 host는 `minmax(0,1fr)`과 260포인트 열의 CSS grid로 이를 지키고 `ResizeObserver`를 쓰지 않는다. 네이티브 host는 pane 폭으로 같은 x를 계산한다.
- 변경은 바뀐 설정의 행과, 그 설정에 기대는 설정의 행, 그 설정을 읽는 행만 갱신한다. 기대는 행은 부모가 꺼져 있으면 꺼지고, debug 스위치는 diagnostics 설정을 읽기 때문이다. 여러 필드에 걸친 규칙은 그 group 전체를 다시 그린다. 오류 줄과 고치기 버튼이 group 아래에 있기 때문이다. 페이지는 창을 만들 때가 아니라 보일 때 만든다.
- host는 설정, 계정, 언어, 보이는 페이지, 플러그인 상태, 애플리케이션 업데이트 상태, setup 상태가 바뀔 때만 설정 모델을 만든다. 설정, 계정, 플러그인 상태, 애플리케이션 업데이트 상태의 변경은 callback으로 입력을 올리고, 모델의 key는 페이지, 언어, setup 세대, 실행 중인 플러그인 작업만 담으며 인코딩된 상태는 담지 않는다. 설정 변경은 모델을 한 번 만든다. 쓰기 응답은 성공이든 실패든 모델을 만들지 않는다. 모델은 변경된 값을 보여주며, host가 거절한 쓰기는 저장된 값을 store와 control에 되돌리고, 오류는 하나의 표시 경로로 한 번 보여준다. 따라서 control은 host가 저장한 값을 보여준다. 변경이 없는 프레임은 아무것도 만들지 않으며, 프레임마다 모델을 만들지 않는다.
- 타이머나 poll이 상태를 정하지 않는다. 아직 모르는 상태는 자리표시나 지연 상태로 보이지 않는다. setup 상태와 플러그인 상태는 [에이전트](#에이전트)와 [설치됨](#설치됨)이 정한 이벤트로 읽는다.
- 되돌리기 토스트는 5초 동안 보인다. 이 시간은 사람이 보는 마감이며, 토스트는 기존 토스트 메커니즘을 쓴다.
- 레이아웃 속성을 바꾸는 애니메이션은 없다. 그림자는 정적인 표면에만 쓴다.
- 카탈로그 목록은 한 번에 30개 행을 보인다. 나머지는 사람이 요청할 때 더 불러온다.
- 슬라이더는 끌기가 끝날 때 명령을 한 번 실행한다.
- 검색과 필터는 입력 이벤트마다 불러온 데이터에서 실행하며, 타이머를 쓰지 않는다.

## 상태

`core.settings-tab`은 다음을 보고한다.

| 필드 | 값 |
| --- | --- |
| `page` | 보이는 페이지: `look`, `workspace`, `sets`, `behavior`, `agents`, `diag`, `installed`, `browse`, `plugin` 중 하나 |
| `scope` | `common` 또는 `project` |
| `find` | 메뉴 검색의 글. 기본값은 빈 값 |
| `query` | 설치된 플러그인 검색의 글. 기본값은 빈 값 |
| `filter` | 설치됨의 필터: `all`, `active`, `disabled`, `updates`, `problems` |
| `browse` | 찾아보기의 `{query, hideInstalled, shown}`: 검색 글, 스위치, 보이는 행 수 |
| `listed` | 설치됨 또는 찾아보기에서 보이는 행의 플러그인 id를 순서대로. 다른 페이지에서는 `[]` |
| `actions` | 플러그인 행과 페이지의 동작 버튼을 문서 순서대로 `{plugin, action, disabled}`로. 항목의 위치는 요소 이름 `core.settings-tab.plugins.action`의 인덱스다 |
| `plugin` | 보이는 플러그인 페이지의 플러그인, 또는 `null` |
| `back` | `installed` 또는 `browse`: 플러그인 페이지의 뒤로 가기 링크가 돌아가는 페이지 |
| `editing` | 편집 중인 세트 id, 또는 `null` |
| `rows` | 플러그인 페이지에서 선언된 설정 행마다 `{key, name, description}` |
| `controls` | 모든 컨트롤의 요소 이름, 키, 명령, 현재 값, `disabled`(의존 설정의 부모가 꺼져 있거나 전역 전용 설정을 프로젝트 범위에서 보일 때 true), 셀렉트의 선택지 값(`options`, 아니면 `null`) |
| `scroll` | 보이는 내용의 스크롤 위치. 맨 위에서부터의 포인트다. 내용이 시작보다 더 당겨진 동안은 음수다. 숫자가 아닌 값은 거부한다 |
| `undo` | 보이는 토스트를 `{key, label, old, new}`로, 없으면 `null` |
| `confirm` | 열린 확인을 `{kind, id}`로. `kind`는 `set` 또는 `plugin`이며, 없으면 `null` |
| `errors` | 보이는 오류 줄을 `{key, text}`로, 없으면 `[]` |
| `results` | 검색 중이면 `{settings, plugins, catalog}`: 맞는 설정의 키, 맞는 설치된 플러그인의 id, 맞는 카탈로그 플러그인 수. 그 밖에는 `null` |
| `missing` | 값이 불러온 플러그인을 가리키지 않는 플러그인 설정의 키, 없으면 `[]` |

플러그인 페이지의 요소 이름은 접두사 `core.settings-tab.plugins.`를 유지한다. 설명 줄은 `core.settings-tab.plugins.about`, 기여 줄은 `core.settings-tab.plugins.contribution`이며, 문서 순서를 따른다.

`core.plugins`는 다음을 보고한다.

| 필드 | 값 |
| --- | --- |
| `core` | `pluginsState`가 보고하는 실행 중 core의 버전. 상태를 읽기 전이거나 읽을 수 없거나 host가 없으면 `null` |
| `registry` | 레지스트리 인덱스 URL, 또는 `null` |
| `error` | 레지스트리 인덱스 오류나 플러그인 상태 오류, 또는 `null` |
| `plugins` | 행마다 하나, id 순서로 정렬: `{id, name, description, state, composition, installed, latest, incompatible, sidecars}`. `state`는 `loaded`, `disabled`, `available`, `reload`, `refused`, `requires` 중 하나다. `composition`은 이 창에서 불러온 manifest의 표면 구성 종류이며, 표면 선언이 불러와지지 않았으면 `null`이다. 탭이 열려 있는지와 무관하다. `installed`는 `{version, enabled}` 또는 `null`이다. `latest`는 레지스트리 인덱스가 나열하는 가장 새 버전 중 취소되지 않고 `engines.soksak`이 실행 중 core를 포함하는 버전, 또는 `null`이다. `incompatible`은 레지스트리 인덱스가 취소되지 않은 버전을 나열하지만 그 중 실행 중 core를 포함하는 것이 없으면 `true`다. `sidecars`는 이름 순으로 정렬한 `{name, range, version}`의 목록이며, 설치도 불러옴도 아닌 `incompatible` 플러그인은 `null`이다. `range`와 `version`은 알 수 없으면 `null`이다 |
| `operation` | 첫 작업 전에는 `null`. 이후에는 가장 최근 작업의 `{action, plugin, state, error}`. `state`는 `running`, `done`, `failed` 중 하나이고, `error`는 실패한 작업의 메시지 또는 `null`이다 |
| `reload` | 상태가 `reload`인 플러그인이 있으면 `true`. 상태가 `refused`인 플러그인은 이를 설정하지 않는다 |
| `updates` | 설치된 플러그인 가운데 `latest`가 설치 버전보다 새로운 것을 id 순서로 `{id, installed, latest}` |
| `held` | `pluginsState`의 `held` 목록. 상태를 읽기 전이거나 host가 없으면 `[]` |
| `outdated` | 오래된 사이드카를 `{sidecar, running, installed, sessions, surfaces}`로 사이드카 순서대로. host가 없으면 `[]`([영구 서비스](persistent-services.ko.md#updates)) |

`core.settings`는 `values`에 `sets`, `links`, 배치 값을 포함한 모든 적용 값을, `common`에 모든 키의 전역 값을 보고한다. 전역 값은 저장된 전역 값이며, 전역 설정이 저장하지 않으면 기본값이다. 선택된 프로젝트가 덮어쓴 키는 `values`에 프로젝트 값을, `common`에 전역 값을 가진다. `core.themes`는 테마 카탈로그를 순서대로 보고한다. 각 테마의 `name`, `shape` 값, `dark`와 `light` 모드의 색 토큰이다.

`core.setup`은 `{parts, running}`을 보고한다. `parts`는 마지막 읽기나 작업의 part를 `setupState()`가 반환한 대로 담으며, 첫 읽기 전에는 `[]`다. `running`은 현재 작업의 종류 목록 또는 `null`이다.

## 완료 기준

- 동작과 모양은 자기 묶음의 설정을 가지며, 페이지의 모든 설정은 [컨트롤](#컨트롤)의 형식에 맞는 컨트롤 하나로 그려진다. 선택지를 버튼 행으로 그리지 않는다.
- 작업 공간 › 사이드바는 셀렉트, 스위치, ↑, ↓를 가진 변 행 네 개를 가진다. 행 순서가 배치 순서다. 첫 행에는 ↑가 없고 마지막 행에는 ↓가 없다.
- 사이드바 세트는 세트 목록, `새 세트`, 편집기를 가진다. 편집기는 섹션을 ×가 있는 칩으로 보이며, 등록된 섹션 가운데 세트가 가지지 않은 것을 고르는 셀렉트 `섹션 추가…` 하나를 가진다.
- 섹션 컨트롤은 `core.settings.sets.row`로 섹션을 빼고 더한다. 반복된 섹션은 거부된다.
- 설치됨은 설치되었거나 불러온 플러그인의 행을 보이며, 문제와 업데이트가 있는 행이 먼저 온다. `core.settings-tab.filter`로 거른다. 행은 플러그인 페이지를 열고, 뒤로 가기 링크는 `back`이 가리키는 페이지로 돌아간다.
- 찾아보기는 설치되지 않은 카탈로그 플러그인을 검색과 스위치로 거르며, `core.plugins.install`로 하나를 설치한다.
- 플러그인 페이지는 계정, 설정, 섹션, 사이드바 선택을 보인다. 설정이 없는 플러그인은 `이 플러그인에는 설정이 없다.`를 보인다. 페이지는 core 코드에 플러그인 이름을 적지 않으며, core의 설정에 플러그인 설정을 두지 않는다.
- 에이전트 연동은 `sok setup check`가 보고하는 상태로 해당하는 setup part를 보인다. `모두 설치`는 빠진 스킬 파일과 등록을 설치하며, 이미 맞는 것은 바꾸지 않는다. 경로 동작은 권한 상승 없이 원하는 사용자 등록을 적용하고 저장한다.
- 설정을 바꾸면 되돌리기 토스트가 5초 동안 보이며, `되돌리기`는 같은 명령으로 이전 값을 복원한다.
- 각 컨트롤의 요소 이름과 명령은 `core.settings-tab`의 `controls`에 나타난다.
- 탭의 모든 누름과 키는 선언된 명령을 실행한다. 검사는 요소를 그 선언된 명령을 통해 누른다.
- 순서 행은 `core.settings.change`로 전체 순서를 주어 변을 위아래로 옮기고, 창 사이드바는 새 순서대로 배치된다.
- 창 사이드바와 카드 사이드바의 플러그인 선택은 포커스와 탭 변경을 거쳐도 서로 독립이다. 꺼진 변은 플러그인 세트를 골라도 계속 꺼져 있다.
- 배치 값은 카드 내부 사이드바의 제한과 처음 크기, 그리고 창 사이드바 축의 처음 크기를 바꾼다.
- 창 chrome의 스위치, 창 사이드바의 접기 컨트롤, 전역 범위의 모든 컨트롤은 자기가 보이는 값을 그 값이 나온 범위에서 바꾼다.
