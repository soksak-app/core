# 설정 창

[English](settings.md)

독립 창 선언·배치·연결·레일 경계선 계약은 [외부 창 사이드바](external-sidebars.ko.md)에 정의한다. 카드 내부 변 계약은 독립적으로 유지한다.

이 명세는 설정 창의 절, 각 절이 보여 주는 설정, 사이드바 세트의 저장 형식을 정의한다. 범위와 저장 파일은 [프로젝트](projects.ko.md#설정)가, 창을 그리는 방식은 [네이티브 모달](native-modals.ko.md)이, 플러그인 선언은 [플러그인](plugins.ko.md)이 정의한다. 구현과 검증은 [기능](../features.ko.md)에 기록한다.

## 절

플러그인은 별도 저장소에서 설치되므로 플러그인과 그 섹션의 수는 제한 없이 늘어난다. 목록의 행과 선택 상자의 항목을 빼면 창의 어떤 컨트롤도 플러그인이나 섹션마다 반복되지 않는다.

왼쪽 목록은 절 셋을 이 순서로 보여 준다. 모든 절은 컨트롤 위에 범위 탭(전역, 프로젝트)을 보여 준다. 프로젝트 탭은 프로젝트가 선택된 동안에만 있다.

| Id | 이름 | 내용 |
|---|---|---|
| `general` | 일반 | 사이드바 모양을 포함해 워크벤치 전체에 적용되는 설정 |
| `plugins` | 플러그인 | 환경 플러그인의 검색할 수 있는 목록과 선택한 플러그인의 페이지 |
| `sidebars` | 사이드바 | 만들기·편집·삭제가 있는 세트 목록과 세트 편집 |

`core.settings-modal.nav {section}`이 절을 보여 준다. 창은 닫았다 다시 열어도 절, 플러그인 검색어, 선택한 플러그인, 편집 중인 세트를 유지한다.

### 일반

| 묶음 | 행 |
|---|---|
| 프로젝트 (전역 범위에서만) | 열기 방식 `projectOpening` |
| 테마 | 테마 견본 `theme`, 모드 `mode` |
| 형태 | 통로 `gap`, 모서리 `radius`, 폰트 `font`, 글자 크기 `size` |
| 위치 | 프로젝트 탭 위치 `projectTabs` |
| 사이드바 | 왼쪽 사이드바 보이기 `left`, 오른쪽 사이드바 보이기 `right`, 왼쪽 사이드바 세트와 오른쪽 사이드바 세트(각각 모든 세트와 사용 안 함의 선택 상자, `core.settings.link {place, plugin: null, set}`) |
| 사이드바 크기 | [배치 값](#배치-값)의 폭 설정 |
| 표시 | 포커스 표시 `focusInd`, 경계선 `fullRule`, 포커스 밖 흐리게 `dim` |
| 언어 | 언어 `language` |
| 진단 | 성능 트레이스 `diagnostics.performance` |

창 선택은 고정 왼쪽 사이드바 하나와 고정 오른쪽 사이드바 하나의 내용을 선택한다. 포커스 활성 플러그인은 추가 열 없이 일반 변 선택을 오버라이드한다. 표시 스위치는 고정 변에 적용한다. 카드 사이드바는 카드 내부에 있으며 기존 `cardSidebar` 위치 설정은 거부한다. 일반에는 플러그인 설정이 없다.

### 진단

`diagnostics.performance` 는 영구 성능 트레이스([성능 트레이스](performance-trace.md))의 스위치다. 불리언이고 기본은 false 이며, 설정 창의 조작이 아니라 설정 파일로 지정한다. false 인 동안 어떤 계층도 성능 기록 일을 하지 않는다 — 파일이 만들어지지 않고 포맷팅이 돌지 않는다. true 로 바꾸면 모든 계층이 구성 디렉터리의 `logs/performance.ndjson` 에 줄을 덧붙이고, 다시 false 로 돌리면 다음 이벤트 경계에서 기록이 멈춘다; 파일과 로테이션은 설정이 아니라 트레이스의 소유물이므로 스위치를 끈 재시작에도 옛 로그는 남는다.


### 플러그인

선택한 플러그인이 없으면 이 절은 검색 칸과 목록을 보여 준다. 목록은 `environment.json`의 플러그인마다 선언 순서대로 한 행이며, manifest의 `name`과 `description`을 보여 준다. 플러그인은 표면, 섹션, 설정을 함께 제공하는 한 단위다. 창에는 설치, 켜기, 끄기 동작이 없다.

- 검색 칸은 입력한 글자로 `core.settings-modal.search {query}`를 실행한다. 목록은 id, 이름, 설명에 검색어가 들어 있는 플러그인을 대소문자 구분 없이 보여 주며, 빈 검색어는 모든 플러그인을 보여 준다. 맞는 플러그인이 없으면 "찾는 플러그인이 없습니다."를 보여 준다.
- 행은 `core.settings-modal.plugin {plugin}`을 실행해 그 플러그인의 페이지를 연다.

플러그인 페이지는 검색 칸과 목록 대신 다음을 보여 준다.

- 목록: `core.settings-modal.plugin {plugin: null}`을 실행해 같은 검색어의 목록으로 돌아가는 버튼.
- 플러그인 이름과 설명.
- 설정: manifest가 선언한 설정마다 한 행을 manifest 순서로 보여 주고, 행 이름은 `label`이며 `description`이 있으면 행 아래에 보인다. `enum`은 선택 행, `integer`는 경계 사이의 슬라이더, `string`은 글자 입력이다. 설정이 없는 플러그인은 "이 플러그인에는 설정이 없습니다."를 보여 준다.
- 섹션: 플러그인이 선언한 섹션의 이름을 한 줄 글로 보여 준다.
- 사이드바: 모든 플러그인은 창 좌우 선택이 있다. 표면이 있는 플러그인은 카드 내부 네 변 선택도 있다. 모든 선택은 사용 안 함과 모든 세트를 제공하고 `core.settings.link {place, plugin, set}`을 실행한다.

### 사이드바

이 절은 세트 목록과 새 세트를 보여 준다. 각 행은 세트 제목, 배치(목록 또는 탭), 섹션 이름, 버튼 둘을 보여 준다. 편집(`core.settings-modal.edit {set}`)과 삭제(`core.settings.sets.delete {id, scope}`)다. 새 세트는 `core.settings.sets.create {scope}`를 실행한다. 이 명령은 제목 "새 세트", 배치 `list`, 섹션이 없는 세트를 더하고 그 세트의 편집을 연다.

세트 편집은 다음을 보여 준다.

- 이름: 글자 입력, `core.settings.sets.update {id, title, scope}`.
- 배치: 목록(`list`) 또는 탭(`tabs`), `core.settings.sets.update {id, layout, scope}`.
- 섹션: 세트의 섹션마다 세트 순서대로 한 행. 행은 등록된 모든 섹션의 선택 상자(플러그인마다 플러그인 이름을 붙인 `optgroup` 하나)와 버튼 ▲, ▼, −다. 행 아래의 +가 행을 더한다.
- 완료: `core.settings-modal.edit {set: null}`이 편집을 닫는다.

섹션 행의 모든 컨트롤은 `core.settings.sets.row {id, action, index, section?, scope}`를 실행한다.

| 컨트롤 | action | 효과 |
|---|---|---|
| `index` 행의 선택 상자 | `section`과 함께 `choose` | `index` 행의 섹션을 바꾼다 |
| ▲ | `up` | `index` 행을 위 행과 바꾼다. 첫 행에는 없다 |
| ▼ | `down` | `index` 행을 아래 행과 바꾼다. 마지막 행에는 없다 |
| − | `remove` | `index` 행을 뺀다 |
| + | `add` | 세트에 없는 등록된 섹션 중 플러그인과 선언 순서로 첫 섹션을 끝에 더한다 |

세트에 같은 섹션이 두 번 들어가게 하는 변경은 -32602(invalid params)와 오류 "section <id> is already in set <id>"로 실패하고 아무것도 바꾸지 않는다. 세트가 이미 등록된 모든 섹션을 담고 있을 때의 +도 "set <id> already contains every registered section"으로 같게 실패한다. 모든 변경은 보이는 범위에 바로 저장된다.

## 저장되는 세트와 연결

`sets`와 `links`는 설정이다. 기본값은 플러그인 사이드바 선언을 정규화한 값이며 명시적 `environment.json`의 `sidebars`가 있으면 그것으로 교체한다. 변경은 다른 설정처럼 목록 전체를 보이는 범위에 쓴다. 프로젝트의 `sets`나 `links` 재정의는 전역 목록을 대신한다.

세트는 `{id, title, sections, layout}`이다.

- `id`: 비어 있지 않은 문자열이고 목록 안에서 유일하다. 새로 만든 세트는 목록의 어떤 세트도 쓰지 않는 가장 작은 양수 `n`으로 `set-<n>`을 받는다.
- `title`: 1자에서 40자 사이의 문자열.
- `sections`: 반복 없는 섹션 id.
- `layout`: `list` 또는 `tabs`([플러그인](plugins.ko.md#섹션)).

연결은 `{place, plugin, set}`이고 `environment.json`의 `sidebars.links` 규칙을 따른다. 유효한 `sets`와 `links`는 `environment.json`의 `sidebars`도 검사하는 plugin-api 함수 `validateSidebars`와 `checkSidebarReferences`로 검사한다. 검사는 설정을 불러올 때와 변경을 저장하기 전에 실행한다. 환경이 등록하지 않은 섹션을 가리키는 세트, 표면이 없는 플러그인의 카드 변 연결, 미등록 플러그인의 창 연결, 없는 세트의 연결은 실패한다. 불러오기는 오류를 보고하고 아무것도 바꾸지 않으며, 변경은 -32602(invalid params)로 실패하고 아무것도 바꾸지 않는다.

세트를 삭제하면 남은 세트와 그 세트를 가리키는 연결을 뺀 연결을 같은 범위에 한 번의 변경으로 쓴다.

## 사이드바 선택

연결이 없으면 `off`를 명시적으로 선택한다. 모든 선택 상자는 제공한 항목 밖의 현재 값을 거부하고 브라우저가 첫 항목으로 대신하지 않게 한다.

| 연결 | 뜻 |
|---|---|
| `{place: "left" 또는 "right", plugin: null, set}` | 고정 창 사이드바의 일반 내용 |
| `{place: "window-left" 또는 "window-right", plugin, set}` | 고정 창 사이드바 내용의 플러그인 오버라이드 |
| `{place: "card-top", "card-bottom", "card-left" 또는 "card-right", plugin, set}` | 플러그인 카드의 해당 내부 변 기본 세트 |

모든 `set`은 알려진 세트 ID다. 위치/플러그인 조합은 한 번만 나온다. 플러그인 left/right 연결, null 세트, 레일 연결을 거부한다. 세트 ID `off`와 `inherit`는 예약 값이다. 고정 사이드바 선택과 오버라이드 레일 보더는 [외부 창 사이드바](external-sidebars.ko.md)를 따른다. `left`/`right` 스위치는 선택을 바꾸지 않고 해당 고정 사이드바를 숨긴다.

`core.settings.link {place, plugin, set, scope}`는 연결을 저장하는 세트 ID 또는 연결을 제거하는 `off`를 받는다. 모든 기본 링크에서 `inherit`는 -32602로 실패한다. 별도 명령 `core.card.sidebar.set`는 개별 카드의 명시적 덮어쓰기를 제거하는 `inherit`를 유지한다([예제 모델](example-model.ko.md)).

## 배치 값

다음 값은 `plane.js`와 `app.css`의 상수였다. 이제 일반 › 사이드바 크기에 보이는 코어 설정이고 단위가 포인트인 정수다.

| 키 | 이름 | 기본값 | 범위 | 용도 |
|---|---|---|---|---|
| `sidebarMinWidth` | 최소 폭 | 120 | 60–800 | 카드 안 사이드바의 가장 작은 폭 |
| `sidebarMaxWidth` | 최대 폭 | 480 | 60–800 | 카드 안 사이드바의 가장 큰 폭 |
| `sidebarWidth` | 처음 폭 | 190 | 60–800 | 초기 카드 내부 사이드바 크기와 저장 폭이 없는 새 창 사이드바 폭 |

세 값은 60에서 800포인트의 한 범위를 함께 쓰고 슬라이더도 그 범위를 쓰므로, 같은 값은 같은 슬라이더 위치에 놓인다. 행 이름은 사이드바 크기 묶음 아래 한 줄의 최소 폭, 최대 폭, 처음 폭이다.

`sidebarMinWidth` ≤ `sidebarWidth` ≤ `sidebarMaxWidth`를 깨는 변경은 -32602(invalid params)로 실패하고 아무것도 바꾸지 않는다. 현재 범위를 벗어난 저장된 카드 폭은 손잡이로 바꿀 때까지 저장된 대로 그린다.

다음 배치 상수는 취향이 아니라 문서 구조에 묶여 있으므로 코드에 남는다. 카드 머리 32포인트와 바닥 22포인트, 탭 줄의 기준 폭(`plane.js`)이다. 새 스페이스의 왼쪽과 오른쪽 사이드바 폭은 `environment.json`의 `workspace.grid` 카드에서 온다.

## 상태

`core.settings-modal`은 다음을 보고한다.

| 필드 | 값 |
|---|---|
| `section` | 보이는 절 id |
| `scope` | `common` 또는 `project` |
| `query` | 플러그인 검색어. 기본값은 빈 문자열 |
| `listed` | 보이는 목록 행의 플러그인 id를 순서대로. 플러그인 목록 밖에서는 `[]` |
| `plugin` | 페이지가 보이는 플러그인 또는 `null` |
| `editing` | 편집 중인 세트 id 또는 `null` |
| `rows` | 플러그인 페이지의 선언된 설정 행마다 `{key, name, description}` |
| `controls` | 모든 컨트롤과 그 dom 이름, 키, 명령 |

`core.settings`는 `sets`, `links`, 배치 값을 포함한 모든 유효 값을 보고한다. `core.themes`는 theme catalog를 순서대로 보고한다. 각 theme의 `name`, `shape` 값, `dark`와 `light` mode의 color token이다.

## 완료 기준

- 일반은 사이드바 모양 컨트롤(`left`, `right`, 일반 좌우 연결, 폭)을 담고 플러그인 설정은 담지 않는다.
- 사이드바는 세트 목록, 새 세트, 편집만 담는다. 편집에는 등록된 섹션마다의 컨트롤이 없다. 섹션 컨트롤은 행마다 선택 상자 하나와 ▲ ▼ −, 그리고 + 하나다.
- 섹션 행은 `core.settings.sets.row`로 섹션을 고르고, 옮기고, 빼고, 더한다. 같은 섹션의 반복은 거부된다.
- 플러그인은 걸러진 목록을 보여 주고, 행은 설정, 섹션, 사이드바 선택이 있는 플러그인 페이지를 열며, 목록이 목록으로 돌아간다.
- 일반·플러그인 창·카드 내부 선택은 포커스와 탭 변경에도 독립적이다. 사용 안 함인 창 열이 다른 플러그인 열을 대체하지 않는다.
- 배치 값이 카드 내부 사이드바의 한계·초기 크기와 새 창 사이드바 폭을 바꾼다.
