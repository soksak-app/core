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
| `plugins` | 플러그인 | 설치된 플러그인의 검색할 수 있는 목록과 선택한 플러그인의 페이지 |
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

선택한 플러그인이 없으면 이 절은 검색 칸과 목록을 보여 준다. 플러그인은 표면, 섹션, 설정을 함께 제공하는 한 단위다. 목록은 창이 불러온 플러그인, `installed.json`이 나열한 플러그인, registry index가 나열한 플러그인마다 한 행이며 id 순서로 정렬한다. 행은 불러온 manifest의 이름과 설명을, 없으면 registry 항목의 것을, 둘 다 없으면 플러그인 id만 보여 주고, 상태 하나를 보여 준다:

| 상태 | 글 | 조건 |
| --- | --- | --- |
| `loaded` | 사용 중 | 창이 플러그인을 불러왔고, `installed.json`이 같은 버전을 켠 상태로 나열한다 |
| `disabled` | 사용 안 함 | `installed.json`이 플러그인을 끈 상태로 나열하고, 창이 불러오지 않았다 |
| `available` | 설치 안 됨 | Registry index만 플러그인을 나열한다 |
| `restart` | 다시 시작하면 적용 | `installed.json`이 창이 불러온 것과 다르다. 창을 불러온 뒤에 플러그인을 설치, 제거, 업데이트, 켜기, 끄기 했다 |

이 절은 보일 때와 `plugins-changed` event를 받을 때마다 host의 [plugin 상태](installation.ko.md#애플리케이션-안의-plugin-작업)를 읽는다. Registry index를 읽지 못하면 목록 위에 "레지스트리를 읽지 못했습니다: <message>"를 보여 주고, 목록은 불러온 플러그인과 설치된 플러그인을 유지한다. 잘못된 `installed.json`처럼 plugin 상태를 읽지 못하면 "플러그인 상태를 읽지 못했습니다: <message>"를 보여 주고 행은 없다. Browser 애플리케이션처럼 host가 없으면 목록에는 불러온 플러그인만 모두 `loaded`로 있고, 페이지에는 동작이 없다.

- 검색 칸은 입력한 글자로 `core.settings-modal.search {query}`를 실행한다. 목록은 id, 이름, 설명에 검색어가 들어 있는 플러그인을 대소문자 구분 없이 보여 주며, 빈 검색어는 모든 플러그인을 보여 준다. 맞는 플러그인이 없으면 "찾는 플러그인이 없습니다."를 보여 준다.
- 행은 `core.settings-modal.plugin {plugin}`을 실행해 그 플러그인의 페이지를 연다.

플러그인 페이지는 검색 칸과 목록 대신 다음을 보여 준다.

- 목록: `core.settings-modal.plugin {plugin: null}`을 실행해 같은 검색어의 목록으로 돌아가는 버튼.
- 플러그인 이름과 설명, 그리고 설치된 버전과 registry index가 나열한 가장 새 버전을 있을 때 보여 주는 한 줄.
- 동작: 각각 자기 명령에 연결된 버튼이다. 설치 `core.plugins.install`은 registry가 플러그인을 나열하고 설치되지 않았을 때, 업데이트 `core.plugins.update`는 설치되었고 registry가 나열할 때, 사용 `core.plugins.enable` 또는 사용 안 함 `core.plugins.disable`은 설치되었을 때 `enabled` 값에 따라, 제거 `core.plugins.remove`는 설치되었을 때 보인다. 작업이 실행되는 동안 모든 동작은 비활성이고 페이지는 "<plugin> <action> 진행 중"을 보여 준다. 작업이 끝나면 페이지는 "애플리케이션을 다시 시작하면 적용됩니다." 또는 실패한 작업의 오류를 보여 준다.
- 설정: manifest가 선언한 설정마다 한 행을 manifest 순서로 보여 주고, 행 이름은 `label`이며 `description`이 있으면 행 아래에 보인다. `enum`은 선택 행, `integer`는 경계 사이의 슬라이더, `string`은 글자 입력이다. 설정이 없는 플러그인은 "이 플러그인에는 설정이 없습니다."를 보여 준다.
- 섹션: 플러그인이 선언한 섹션의 이름을 한 줄 글로 보여 준다.
- 사이드바: 모든 플러그인은 창 좌우 선택이 있다. 표면이 있는 플러그인은 카드 내부 네 변 선택도 있다. 모든 선택은 사용 안 함과 모든 세트를 제공하고 `core.settings.link {place, plugin, set}`을 실행한다.

설정, 섹션, 사이드바는 플러그인의 manifest가 필요하므로 페이지는 창이 불러온 플러그인에만 그것들을 보여 준다.

`core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable`, `core.plugins.disable`은 `{plugin}`을 받고 자기 action으로 host 호출 `pluginsRun`을 실행한다. `plugin`이 비어 있지 않은 문자열이 아니면 -32602(invalid params)로, 작업이 실패하거나 다른 작업이 실행 중이면 host 오류로, host가 없으면 "plugin operations need a native host"로 실패한다. 명령은 host를 호출하기 전에 작업을 `core.plugins`에 기록하고, 호출 뒤에 결과를 기록한다.

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

## 값

core 설정은 저마다 한 형식을 받는다. 설정 파일을 읽을 때와 모든 변경이 값을 그 형식으로 검사하고, 다른 형식의 값은 `Invalid setting <key>: <value>`와 그 이유로 실패한다. 읽기는 오류를 보고하고 아무것도 바꾸지 않으며, 변경은 -32602(invalid params)로 실패하고 아무것도 바꾸지 않는다. 일반의 컨트롤은 같은 선택지와 범위를 보인다.

| 키 | 형식 |
|---|---|
| `projectOpening` | `tabs` 또는 `windows` |
| `theme` | `midnight`, `nord`, `solar`, `forest`, `ember`, `slate`, `mist`, `grape`, `sand`, `paper` 중 하나 |
| `mode` | `dark` 또는 `light` |
| `font` | `mono-system`, `mono-sf`, `mono-jet`, `sans-system`, `sans-inter` 중 하나 |
| `gap`, `radius` | 0에서 24까지의 정수(px) |
| `size` | 10에서 18까지의 정수(px) |
| `textSize` | [글자 크기 단계](text-size.ko.md) 하나 |
| `projectTabs` | `top` 또는 `left` |
| `left`, `right`, `dim`, `diagnostics.performance` | boolean |
| `focusInd` | `border` 또는 `corner` |
| `fullRule` | `under`, `over`, `none` 중 하나 |
| `language` | `auto` 또는 애플리케이션 메뉴의 언어(`ko`, `en`) |
| `sidebarMinWidth`, `sidebarMaxWidth`, `sidebarWidth` | [배치 값](#배치-값) |
| `sets`, `links` | [저장되는 세트와 연결](#저장되는-세트와-연결) |

플러그인 설정은 그 선언의 형식을 따른다([플러그인](plugins.ko.md)).

## 이전 형식

설정 파일은 선언한 설정만 현재 형식으로 담는다. 설정을 연결할 때 page는 공통 설정과 모든 프로젝트 설정을 한 번 변환하고, 결과를 저장하며, 변환마다 애플리케이션 log에 보고한다.

- 이전 설정의 키(`cardSidebar`, `rail`, `railWidth`, `sidebarFoldedWidth`, `latency`, `skew`)를 지운다.
- `rail` 연결은 같은 플러그인과 세트의 `card-left` 연결이 된다.
- 플러그인을 가리키는 `left`, `right` 연결은 `window-left`, `window-right` 연결이 된다. 세트가 없는 그런 연결은 그 플러그인에 내용을 보이지 않도록 고른 것이었다. 현재 형식으로는 나타낼 수 없으므로 지우며, 일반 내용이 보인다.

그 밖의 알 수 없는 키나 잘못된 값은 그 이름과 함께 설정 검사에서 실패한다.

## 저장되는 세트와 연결

`sets`와 `links`는 설정이다. 기본값은 플러그인 사이드바 선언을 정규화한 값이며 명시적 `environment.json`의 `sidebars`가 있으면 그것으로 교체한다. 변경은 다른 설정처럼 목록 전체를 보이는 범위에 쓴다. 프로젝트의 `sets`나 `links` 재정의는 전역 목록을 대신한다.

세트는 `{id, title, sections, layout}`이다.

- `id`: 비어 있지 않은 문자열이고 목록 안에서 유일하다. 새로 만든 세트는 목록의 어떤 세트도 쓰지 않는 가장 작은 양수 `n`으로 `set-<n>`을 받는다.
- `title`: 1자에서 40자 사이의 문자열.
- `sections`: 반복 없는 섹션 id.
- `layout`: `list` 또는 `tabs`([플러그인](plugins.ko.md#섹션)).

연결은 `{place, plugin, set}`이고 `environment.json`의 `sidebars.links` 규칙을 따른다. 유효한 `sets`와 `links`는 `environment.json`의 `sidebars`도 검사하는 plugin-api 함수 `validateSidebars`와 `checkSidebarReferences`로 검사한다. 검사는 설정을 불러올 때와 변경을 저장하기 전에 실행한다. 불러온 플러그인이 선언하지 않은 섹션을 가리키는 세트, 표면이 없는 불러온 플러그인의 카드 변 연결, 없는 세트의 연결은 실패한다. 불러오지 않은 플러그인을 가리키는 것은 유지한다([플러그인](plugins.ko.md#불러오지-않은-플러그인)). 실패는 다음과 같이 보고한다. 불러오기는 오류를 보고하고 아무것도 바꾸지 않으며, 변경은 -32602(invalid params)로 실패하고 아무것도 바꾸지 않는다.

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

`core.plugins`는 다음을 보고한다:

| 필드 | 값 |
|---|---|
| `registry` | Registry index URL 또는 `null` |
| `error` | Registry index 오류 또는 plugin 상태 오류, 또는 `null` |
| `plugins` | 목록 행마다 id 순서로 `{id, name, description, state, installed, latest}`. `installed`는 `{version, enabled}` 또는 `null`이고, `latest`는 registry index가 나열한 가장 새 버전 또는 `null`이다 |
| `operation` | 첫 작업 전에는 `null`, 그 뒤에는 마지막 작업의 `{action, plugin, state, error}`. `state`는 `running`, `done`, `failed`이고, `error`는 실패한 작업의 message 또는 `null`이다 |
| `restart` | 상태가 `restart`인 플러그인이 있으면 `true` |

`core.settings`는 `sets`, `links`, 배치 값을 포함한 모든 유효 값을 보고한다. `core.themes`는 theme catalog를 순서대로 보고한다. 각 theme의 `name`, `shape` 값, `dark`와 `light` mode의 color token이다.

## 완료 기준

- 일반은 사이드바 모양 컨트롤(`left`, `right`, 일반 좌우 연결, 폭)을 담고 플러그인 설정은 담지 않는다.
- 사이드바는 세트 목록, 새 세트, 편집만 담는다. 편집에는 등록된 섹션마다의 컨트롤이 없다. 섹션 컨트롤은 행마다 선택 상자 하나와 ▲ ▼ −, 그리고 + 하나다.
- 섹션 행은 `core.settings.sets.row`로 섹션을 고르고, 옮기고, 빼고, 더한다. 같은 섹션의 반복은 거부된다.
- 플러그인은 불러온 플러그인, 설치된 플러그인, registry 플러그인을 상태와 함께 걸러진 목록으로 보여 주고, 행은 동작과, 불러온 플러그인이면 설정, 섹션, 사이드바 선택이 있는 플러그인 페이지를 열며, 목록이 목록으로 돌아간다.
- 플러그인 페이지에서 설치, 업데이트, 끄기, 켜기, 제거를 하면 같은 `sok plugin` 명령처럼 `installed.json`을 바꾸고, 작업을 `core.plugins`에 보고하며, 애플리케이션을 다시 시작할 때까지 그 플러그인을 `restart`로 표시한다.
- 일반·플러그인 창·카드 내부 선택은 포커스와 탭 변경에도 독립적이다. 사용 안 함인 창 열이 다른 플러그인 열을 대체하지 않는다.
- 배치 값이 카드 내부 사이드바의 한계·초기 크기와 새 창 사이드바 폭을 바꾼다.
