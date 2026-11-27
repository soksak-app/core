# 알림

[English](notifications.md)

사용자가 보는 모든 notice는 하나의 notification path를 거친다. Notice는 최대 세 곳에 나타난다. 그 notice가 속한 card의 status line, 종 아래의 toast, 그리고 모든 notice를 보관하는 notice center다. 애플리케이션이 보여 주는 오류는 종류 `error`의 notice이며, 이 path가 오류의 하나뿐인 표시 경로다([오류 표시](exposure.ko.md#오류-표시)). 운영체제의 알림은 notice가 아니라 system notification이다([탭 알림](plugins.ko.md#탭-알림)).

## 알림 기록

Notice는 다음 필드를 가진 기록이다.

| 필드 | 값 |
| --- | --- |
| `id` | 워크벤치가 배정하는 문자열 |
| `kind` | `success`, `info`, `warning`, `error` 또는 `progress` |
| `title` | 제어 문자가 없는 1자부터 120자까지의 글 |
| `text` | 제어 문자가 없는 0자부터 1024자까지의 글 |
| `source` | `{kind: "card", card, tab, plugin}`, `{kind: "sidebar", sidebar, card, plugin}`, `{kind: "plugin", plugin}`, `{kind: "settings"}` 또는 `{kind: "core"}` |
| `actions` | 선언된 명령의 `{label, command, params}`를 최대 둘까지. label은 1자부터 24자까지 |
| `progress` | `progress`일 때 0부터 1까지의 수, 양을 모르면 `null`. 다른 kind에는 없다 |
| `at` | 가장 최근 발생 시각, 오프셋이 붙은 ISO 8601 |
| `count` | 합친 발생 횟수 |
| `read` | 사용자가 보았는지. 알림 센터에서 보았거나, 카드가 focus를 가진 동안 그 카드에서 보았을 때 |

각 kind는 자기 아이콘 모양과 색 token을 가진다. `success`는 success token의 체크, `info`는 accent의 `i`, `warning`은 warning token의 삼각형, `error`는 error token의 ×, `progress`는 도는 고리이며 작업이 끝나면 success 또는 error 아이콘이 된다. 색만으로 표시하지 않는다. 사용자의 확인을 기다리는 요청, 예컨대 사용자를 기다리는 agent는 그 답을 실행하는 action을 가진 `warning` notice다.

같은 kind와 title을 가진 발생은, 아직 toast나 status line에 떠 있는 notice가 있으면 그 notice에 합쳐진다. `count`는 늘고, `at`, `text`, `source`, `actions`는 새 값을 가지며, title은 `<title> ×<count>`로 읽힌다. 사용자가 닫은 발생을 다시 그려도 닫힌 채로 남는다. 출처가 바뀌거나 회복된 뒤의 다음 발생은 새 toast를 열고 알림 센터에 새 항목을 추가한다. card notice(source `card`)는 같은 card의 떠 있는 notice하고만 합쳐진다. 그래서 두 card에 같은 kind와 title이 있으면 notice가 두 개다. app notice(card 없음)는 app notice하고만 합쳐진다.

워크벤치는 notice가 나타나거나 합쳐질 때 애플리케이션 log에 한 줄을 쓴다. Source의 class에 따라 쓰는 줄이 다르다. 오류는 `error: <where>: <text>` 줄을 level `error`로 쓰고, 기본 정책이 이를 저장한다([logging](logging.ko.md#정책)). 나머지 kind는 `notice <kind>: <where>: <title>` 줄을 level `info`로 쓰며, 정책이 `info`로 이 class를 지정할 때 저장한다. `<where>`는 source를 가리킨다.

## 표시 자리

| 자리 | Notice | 위치 | 유지 시간 |
| --- | --- | --- | --- |
| 카드 status line | 그 카드의 notice, 그리고 sidebar의 notice는 그 sidebar의 상태줄에 | 그 카드의 content footer, 또는 sidebar의 상태줄 | `success`와 `info`는 6초. `warning`과 `error`는 사용자가 닫을 때까지. `progress`는 끝날 때까지 |
| Toast | card가 아닌 source의 notice, focus가 없는 card의 `warning`과 `error` notice, card [sidebar notice](#sidebar-notice)의 `warning`, 빠진 플러그인의 경고는 제외 | 종 아래, 창의 오른쪽 | `success`와 `info`는 4초. `warning`과 `error`는 사용자가 닫을 때까지, 또는 오류·경고 자동 닫힘의 지연 뒤. `progress`는 끝날 때까지 |
| 알림 센터 | 모든 notice | 종을 눌러 연다 | `error`는 사용자가 지울 때까지. 나머지 kind는 `at` 뒤 7일 |

Focus를 가진 card의 notice는 그 card의 status line에만 보인다. Focus가 없는 card의 `warning`이나 `error` notice는 status line에 보이고, `카드로 가기` action과 함께 toast에도 보인다. 이 action은 `core.card.focus {card}`를 실행한다. Card에 focus를 두면 그 card의 notice가 모두 읽음이 된다.

표시 시간은 timer다. 읽기만 하면 되는 notice를 끝내는 event가 없기 때문이다. 보이는 notice의 timer는 포인터가 그 위에 있거나 키보드 focus를 가진 동안 멈춘다. 다시 그리기, 다른 자리로의 이동, modal로의 전환은 timer를 다시 시작하지 않는다. `core.toasts` status는 각 남은 시간을 보고하므로, 각 만료는 그 status의 변화다.

Toast나 status line의 notice를 닫으면 그 자리에서 빠지고 알림 센터의 항목은 남는다. 오류의 출처와 철회는 [오류 표시](exposure.ko.md#오류-표시)의 규칙이다. 진행 중이거나 회복된 상태는 자신이 소유한 notice를 toast와 status line에서 철회하고, tab을 닫으면 그 tab의 notice가 철회되며, 철회될 때마다 알림 센터 항목은 읽음이 되고 `core.toasts`와 `core.grid`가 바뀐다. 항목은 사용자가 지우거나 만료될 때까지 알림 센터에 남는다.

## 카드 상태줄

Card의 content footer([탭 알림](plugins.ko.md#탭-알림))는 그 card의 어느 tab이든 가장 최근의 닫히지 않은 notice를 보인다. 닫히지 않은 notice가 없으면 활성 tab의 footer 글을 보인다. Notice 줄은 `● <title> · <text> · [<action>] · ×`로 읽힌다. 점은 kind의 아이콘이다. 줄은 첫 action만 보인다. Notice가 활성 tab이 아닌 tab에서 왔으면 title 앞에 tab 이름이 붙는다. `warning`이나 `error` 줄은 배경을 그 kind의 옅은 tone으로 칠한다. 이 줄은 parameter `card`를 가진 element `core.card.notice`이고, 닫기 control은 `core.notices.close {id}`를 실행한다. `core.grid`는 각 card마다 `notice`(보이는 notice의 `id`, `kind`, `title`, 없으면 `null`)를 `status`(보이는 footer 글, notice가 보이는 동안은 `null`)와 함께 보고한다.

## Sidebar notice

Sidebar notice(source `sidebar`)는 그 sidebar의 상태줄에 card 상태줄과 같은 형태로 보이며, 닫기 컨트롤은 `core.notices.close`를 실행한다. 같은 sidebar의 보이는 notice하고만 합쳐진다. `card`는 card sidebar의 카드이고, 창 사이드바에서는 null이다. 창 사이드바의 notice는 토스트가 되지 않고 상태줄에 보인다. card sidebar의 notice는 그 카드에 focus가 없는 동안만 토스트로 보이며, `card`가 null이 아니면 그 토스트는 `카드로 가기`를 가진다. 철회되면 상태줄과 토스트에서 빠지고 알림 센터는 항목을 유지한다. 빠진 플러그인의 경고는 토스트와 상태줄에 보이지 않고, 사이드바 맨 위의 줄([없는 플러그인](plugins.ko.md#없는-플러그인))이 보이며, 알림 센터와 종의 기록을 유지한다.

## 토스트

Toast는 종 아래, 창의 오른쪽 가장자리에 있으며, 모든 card와 surface 위에 있다([네이티브 모달](native-modals.ko.md#toast-overlay)). 설정 토스트 모양(`toastStyle`)이 모양을 정한다.

| 값 | 라벨 | 모양 |
| --- | --- | --- |
| `card` | 카드 | 오른쪽 위의 열. 새것이 위에 온다. 토스트 셋을 보이고, `+<n>개 더` 줄이 나머지를 센다. 스스로 닫히는 토스트는 남은 시간을 아래쪽의 얇은 막대로 보인다 |
| `line` | 한 줄 | 위쪽 가운데의 반전 색 한 줄. Notice 하나를 보이고, 빨간 수가 나머지 수를 보인다. 수를 누르면 `core.toasts.list {open}`를 실행해 그 아래에 카드 형식의 열로 보인다. 줄은 action 하나를 보인다 |
| `deck` | 덱 | 오른쪽 위의 더미. 앞의 토스트는 온전히 보이고, 더미 위에 포인터를 두면 펼쳐진다 |

Toast는 아이콘, title, text, action, 닫기 control을 보인다. 닫기 control은 `core.notices.close {id}`를 실행한다. Action을 실행하면 toast가 닫힌다. 다시 실행할 수 있는 source는 실패한 작업을 `{label: "다시 시도", command, params}` action으로 오류 notice의 첫 action에 넘긴다. Core는 재시도를 더하지 않으며, core가 만든 오류에는 `다시 시도`가 없다. 오류 toast는 또 `자세히`를 제공한다. `자세히`는 `core.notices.show {id}`를 실행해 알림 센터를 그 notice에 맞춰 연다. Warning toast는 그것을 해결하는 action, 예컨대 설치를 제공한다. Success toast는 `되돌리기`나 `설정 열기`를 제공할 수 있다.

알림 센터가 열려 있으면 toast는 나타나지 않으며, 새 notice는 알림 센터에만 보인다. 알림 센터가 서랍이면 toast는 그 왼쪽에 놓인다. 조용히(`quietToasts`)를 켜면 `error` notice만 toast로 보이고, 나머지 notice는 알림 센터와 그 card의 status line에만 간다.

오류 toast는 `role="alert"`, 나머지 toast는 `role="status"`를 가진다. Reduced motion이 켜져 있으면 toast는 애니메이션 없이 나타나고 닫힌다.

## 종

종은 모든 화면, 즉 작업 화면, 설정 탭, 프로젝트 홈에서 제목줄의 마지막 element다. 화면의 도구([창 도구](external-sidebars.ko.md#창-도구)) 뒤에 놓이므로, card의 분할이나 사이드바 숨김이 종의 위치를 바꾸지 않는다. Element는 `core.chrome.notices`이고 `core.notices.toggle`을 실행한다. 읽지 않은 notice의 수를 보인다. 읽지 않은 notice가 `warning`이나 `error`이면 error token으로, 그 밖에는 accent로 보인다. 모두 읽었으면 수를 보이지 않는다. 툴팁은 `알림 센터`이고, 읽지 않은 notice가 있으면 `알림 센터, 읽지 않음 <n>개`다.

## 알림 센터

설정 알림 센터 모양(`noticeCenterStyle`)은 `popover`(팝오버)와 `drawer`(서랍) 중 하나를 고른다. 팝오버는 종 아래로 내려온다. 서랍은 제목줄 아래에서 창 아래까지 창의 오른쪽을 채운다. Escape와 닫기 control이 센터를 닫는다. 제목줄 row는 frame text 배율에 따라 높아진다([글자 크기](text-size.md)). 팝오버, 서랍, 토스트는 그려진 row 아래에서 시작하므로, row가 이들을 가리지 않고 이들도 종을 가리지 않는다.

- 머리에는 `알림`, 버튼 `모두 읽음`(`core.notices.read-all`), 버튼 ⚙(제목줄 ⚙와 같은 크기와 굵기의 설정 icon), 닫기 control(element `core.notices.toggle`, `core.notices.toggle`을 실행)이 있다. ⚙은 `core.settings-tab.nav {page: "behavior", group: "notices"}`를 실행해 동작 페이지의 알림 묶음이 보이는 설정 탭을 연다.
- 필터 세그먼트는 `전체 <n>`, `오류·경고 <n>`, `진행 중 <n>`을 보이며(`core.notices.filter {filter}`, 값은 `all`, `problems`, `progress`), 그 옆에 스위치 조용히가 있다(element `core.notices.quiet`, `core.settings.set {patch: {quietToasts}}`를 실행한다).
- 목록은 항목을 묶는다. `진행 중`이 먼저 오며 각 항목에 진행 막대가 있다. 그다음 `오늘`, `어제`, 그리고 그 이전의 날마다 묶음이 온다. 각 묶음에는 버튼 `지우기`(`core.notices.clear {group}`)가 있다.
- 항목은 아이콘, 수가 붙은 title, text, source chip(항목이 보관한 tab 이름, plugin 이름, `설정` 또는 `soksak`), 시간, action을 보인다. 읽지 않은 항목은 왼쪽에 점이 있으며, error의 점은 error token이다. Card notice 항목을 누르면 `core.card.focus {card}`를 실행한다.
- 바닥글은 `오류는 지울 때까지, 나머지는 7일 동안 남는다.`와 버튼 `모두 지우기`(`core.notices.clear-all`)를 보인다.
- 센터가 열린 동안 도착한 항목은 1초 동안 그 묶음의 맨 위에서 강조된다.

알림 센터는 항목을 애플리케이션 설정 디렉터리의 `notices.json`에 보관한다([프로젝트 식별](projects.ko.md#프로젝트-식별)). 설계상 notice는 며칠 남아야 하므로 재시작이 이를 지우면 안 된다. 파일은 `{format: 2, notices}`를 담으며, 현재 형식으로만 읽는다. 다른 형식은 파일 이름과 발견한 형식을 밝히는 오류로 거부한다. Card 항목은 추가될 때 tab의 제목을 `source.label`에 보관하며, chip은 그 이름을 보인다. label이 없는 card 항목은 거부한다. 재시작 뒤 card나 tab이 더 없는 항목은 글과 source chip을 유지하며, action과 focus 누르기가 없다. 워크벤치는 파일을 읽을 때, 쓸 때, 센터를 열 때 만료된 항목을 제거하므로 만료를 위한 timer가 돌지 않는다.

## 설정

동작 페이지([설정](settings.ko.md#선언))의 묶음 알림은 설명 `알림은 세 곳에 나온다: 카드 상태줄(그 카드의 알림), 토스트(앱 알림), 알림 센터(전부).`를 가진다. 이 묶음의 행은 모두 전역 전용이다.

| 키 | 라벨 | 컨트롤 | 선택지 또는 범위 | 기본값 |
| --- | --- | --- | --- | --- |
| `toastStyle` | `토스트 모양`(설명 `앱 알림과, 보고 있지 않은 카드의 오류·경고가 뜨는 모양. 종 아래에 나타난다.`) | 세그먼트 | `카드`(`card`), `한 줄`(`line`), `덱`(`deck`) | `card` |
| `noticeCenterStyle` | `알림 센터 모양`(설명 `제목줄 종을 누르면 여는 모양.`) | 세그먼트 | `팝오버`(`popover`), `서랍`(`drawer`) | `popover` |
| `quietToasts` | `조용히`(설명 `켜면 오류만 토스트로 띄우고 나머지는 알림 센터에만 쌓는다.`) | 스위치 | 켬, 끔 | 끔 |
| `autoDismissProblemToasts` | `오류·경고 자동 닫힘`(설명 `끄면 오류·경고 토스트는 ×로만 닫힌다. 성공·정보는 4초 뒤 늘 닫힌다.`) | 스위치 | 켬, 끔 | 끔 |
| `problemToastDismissSeconds` | `닫힐 때까지` | 단위 `초`가 붙은 스테퍼 | 1–60 | 5 |

`problemToastDismissSeconds`는 들여 쓰며, `autoDismissProblemToasts`가 꺼져 있으면 비활성이다. 스위치를 끄면 열린 `warning`과 `error` toast의 deadline을 모두 취소하고 그 toast는 연 채로 둔다. 스위치를 켜거나 지연 시간을 바꾸면 열린 각 toast에 지연 시간을 다시 적용한다. 키가 점을 가지면 플러그인 설정의 이름이므로, 키는 camelCase다([값](settings.ko.md#값)).

## 플러그인 알림

페이지는 `tab.notify({kind, title, text, action, system})`로 자기 card에 notice를 준다. `kind`는 위의 kind 가운데 하나이고, `title`과 `text`는 notice 필드를 따르며 `text`는 없어도 되고 없으면 글을 보이지 않는다. `progress` notice는 progress `null`로 시작한다. `action`은 선택 사항인 `{label, command, params}`이며, plugin이 선언한 명령을 가리킨다. `system`은 선택 사항인 불리언이다. 이 호출은 notice의 `id`를 돌려준다. `tab.progress(id, progress)`는 `progress` notice의 진행을 정하고, `tab.done(id, kind, title)`은 그것을 `success`나 `error`로 끝낸다. 다른 값은 예외를 던진다. 어떤 이벤트가 notice인지, 예컨대 0이 아닌 status로 끝난 명령, 끝난 빌드, 확인을 요구하는 agent는 plugin이 정한다. 자기 설정 가운데 어느 것이 `system`을 정할지도 plugin이 정한다.

페이지는 백그라운드 작업의 끝, sidecar 이벤트, plugin 업데이트처럼 어떤 카드에도 속하지 않는 notice를 `page.notify(fields)`로 자기 plugin에 주고, `tab` 호출과 같은 필드를 받는 `page.progress(id, progress)`와 `page.done(id, kind, title)`로 바꾼다. 이런 notice의 source는 `plugin`이다. 토스트와 센터에 plugin 이름을 source chip으로 보이며, 카드 상태줄과 `카드로 가기`가 없고, plugin의 모든 surface가 닫힌 뒤에도 남는다. 카드 notice도 센터에 보인다. `page.notify`는 어떤 카드도 갖지 않는 notice를 위한 것이다. `page.notify`와 `core.notices.add {plugin}`의 `system` 필드는 허용된다. host는 그 notice를 [탭 알림](plugins.ko.md#탭-알림)의 규칙에 따라 system notification으로 게시하되, tab 대신 plugin id로 보관하므로 plugin의 어떤 surface도 보이지 않는 동안 그 plugin의 system notification으로 남는다.

`system: true`이면 host는 [탭 알림](plugins.ko.md#탭-알림)의 규칙에 따라 그 notice를 system notification으로도 게시한다. `tab.error(text)`는 표면 작업의 오류 상태를 보고한다. 이는 card의 `error` notice로 보이며, `tab.error(null)`은 그것을 철회한다.

## 명령과 status

명령은 `tab.notify`처럼 notice를 만들고 읽고 지운다. 그래서 agent, `sok`, 테스트가 page 없이 [exposure](exposure.ko.md)로 notice를 주고 읽는다. `tab.notify`, `page.notify`, 그 progress와 done 호출, 명령은 한 경로로 실행된다. notice는 언제나 카드, plugin, 설정, core 가운데 하나에 속하므로 명령은 카드나 plugin을 밝힌다.

| 이름 | 종류 | 계약 |
| --- | --- | --- |
| `core.notices` | status | `{open, style, filter, unread, problems, shown, entries}`: 센터가 열렸는지, 모양, 필터, 읽지 않은 항목 수, 읽지 않은 항목 가운데 warning이나 error가 있는지, 표시된 항목의 `id`(`core.notices.show`가 표시한 항목이고, 표시한 항목이 없거나 그 항목이 제거되었으면 `null`), 센터 순서의 항목. 각 항목은 [notice](#알림-기록) 필드와 `read`, `source`를 가진다 |
| `core.notices.add {card?, plugin?, kind, title, text?, action?, system?}` | command | 카드 `card`나 plugin `plugin`에 `tab.notify`의 필드로 notice를 주고 그 `id`를 돌려준다. `card`와 `plugin` 가운데 정확히 하나를 준다. 없는 카드나 plugin과 `tab.notify`가 거부하는 필드는 같은 글로 -32602 실패한다 |
| `core.notices.progress {id, progress}` | command | `tab.progress`처럼 `progress` notice의 진행을 정한다 |
| `core.notices.done {id, kind, title}` | command | `tab.done`처럼 `progress` notice를 `success`나 `error`로 끝낸다 |
| `core.notices.read {id}` | command | 항목 하나를 읽음으로 표시한다. 어떤 항목도 갖지 않은 id는 -32602로 실패한다 |
| `core.notices.toggle` | command | 센터를 열거나 닫는다 |
| `core.notices.filter {filter}` | command | 센터의 필터를 정한다 |
| `core.notices.read-all` | command | 모든 항목을 읽음으로 표시한다 |
| `core.notices.clear {group}` | command | 센터 묶음의 항목을 지운다 |
| `core.notices.clear-all` | command | 모든 항목을 지운다 |
| `core.notices.close {id}` | command | notice의 toast와 status line notice를 닫고 항목은 남긴다. 보이는 notice가 없는 id는 -32602로 실패한다 |
| `core.notices.show {id}` | command | 알림 센터를 열고 `id`의 항목으로 스크롤하며 그 항목을 보인 항목으로 표시한다. 항목이 없는 id는 -32602로 실패하고 id를 이름으로 적는다 |
| `core.toasts.list {open}` | command | `open`이 true면 줄 형식 아래에 나머지 toast를 카드 형식의 열로 보이고, false면 숨긴다. Escape와 수를 한 번 더 누르는 것도 숨긴다 |
| `core.toasts` | status | `{toasts, listOpen}`: 보이는 toast를 순서대로 나열한다. 각각은 `id`, `kind`, `title`, `count`와 밀리초 단위의 남은 시간을 가지며, 사용자를 기다리는 동안에는 `null`이다. `listOpen`은 줄 형식이 나머지 toast의 목록을 보이는지다 |

`core.notices.close`와 `core.toasts`는 `core.error.dismiss`와 `core.workbench.error`를 대체한다.

## 결정

- 센터는 저장한다. 설계상 오류는 지울 때까지, 나머지 kind는 7일 동안 남는데, 재시작이 이를 끊으면 안 되기 때문이다. 이는 사용자의 데이터이지 진단 기록이 아니다. 애플리케이션 log가 진단 기록으로 남고, notice마다 그 log에 한 줄을 쓴다.
- 종과 status line은 error token을 쓰며 status line은 오류 글을 보인다. 둘 다 오류 표시 경로의 자리이기 때문이다. 이 경로 밖의 어떤 element도 error token을 쓰지 않는다. 설계는 읽지 않은 warning에도 종을 error token으로 두라고 하므로, 종은 notice 하나의 kind가 아니라 읽지 않은 문제가 있음을 표시한다.
- Notice는 설계가 정한 대로 kind와 title로 합친다. 합쳐진 notice는 가장 최근 발생의 source를 가진다.
- `tab.notify`는 기록을 받는다. `tab`이나 `system` 정책으로는 다섯 kind를 표현할 수 없기 때문이다. System notification의 게시 조건은 바뀌지 않으며, plugin은 자기 설정을 `system`에 대응시킨다.
- 설정 키는 설계의 점 이름이 아니라 camelCase를 유지한다. 점이 있는 키는 플러그인 키이기 때문이다. `autoDismissErrorToasts`와 `errorToastDismissSeconds`는 이제 경고에도 적용되므로 이름을 바꾸었다. 저장된 파일은 같은 변경에서 새 키로 고친다.
