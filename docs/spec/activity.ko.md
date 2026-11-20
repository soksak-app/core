# Activity

[English](activity.md)

tab의 activity는 사람이 tab을 열지 않고도 그 surface가 무언가를 실행하는지, 사람을 기다리는지, 실패로 끝났는지 알게 한다. plugin은 surface의 activity를 status로 보고하고, 각 창은 모든 card, group card, space의 activity를 그 tab들의 activity에서 얻고, application은 모든 project의 activity를 그 space들의 activity에서 얻으며, core는 그것을 status로 보고하고 두 workbench에서 icon으로 그린다. core는 plugin을 이름으로 알지 않는다.

## Activity의 종류

activity는 높은 것부터 낮은 것 순서로 다음과 같다:

| Activity | 뜻 |
| --- | --- |
| `attention` | surface가 사람을 기다린다. 예를 들어 program이 질문한다 |
| `failed` | surface가 실행한 것이 실패로 끝났다 |
| `running` | surface가 program이나 agent 같은 무언가를 실행한다 |
| `idle` | surface가 아무것도 실행하지 않고 아무것도 기다리지 않는다 |

## 선언

plugin의 status 항목은 surface의 activity를 보고하는 status를 멤버 `activity: true`로 표시한다([항목 필드](exposure.ko.md#항목-필드)). 그런 status의 값은 activity 자체로, string `attention`, `failed`, `running`, `idle` 중 하나이거나 activity가 없음을 뜻하는 `null`이다. terminal의 상태처럼 상태가 object인 plugin은 이 string을 별도 status로 내보내므로, 자기 상태 중 어느 것이 실패인지는 core가 아니라 plugin이 정한다. 각 reader의 manifest 검사는 다른 형식을 다음 문구로 거부한다. `<at>`은 `<plugin> exposes <status>`다:

| 찾은 것 | 문구 |
| --- | --- |
| `true`가 아닌 `activity` | `<at>: activity must be true` |

`docs/spec/cases/manifest-validation.json`의 case가 `packages/plugin-api`, `packages/sok/go`, `packages/sok/rust`의 reader에 대해 이 문구를 담는다.

## Tab의 activity

tab의 activity는 그 plugin의 status 가운데 `activity`를 선언한 것들을 각각 그 tab의 surface에서 읽어 얻은 activity 중 가장 높은 것이다. 값이 activity인 status는 그 activity를 주고, 값이 `null`인 status는 아무것도 주지 않는다. surface가 등록하지 않은 status는 아무것도 주지 않으므로, surface가 시작하지 않았거나, unload되었거나([메모리 절약](plugins.ko.md#메모리-절약)) 끝난 tab은 activity가 없다. 어떤 status도 activity를 주지 않는 tab은 activity가 없다.

activity도 `null`도 아닌 값은 plugin의 오류다. 그 값은 activity를 주지 않고, workbench는 문구 `<plugin> exposes <status> on tab <tab>: activity value <value> is not one of attention, failed, running, idle`을 오류 표시 경로로 창의 오류 banner에 출처 `activity <tab>`로 보인다. `<value>`는 그 값의 JSON 문구다. 문구는 tab의 status 가운데 선언 순서로 처음인 그런 status가 정하고, 오류는 tab의 status들이 다시 올바른 값을 보고하거나 tab이 창을 떠나면 거두어진다.

workbench는 자기 창의 project들의 각 tab의 그런 status를 그 surface의 watch로 따른다([전달](exposure.ko.md#전달)). watch는 값의 변화마다 보낸다. workbench는 timer로 값을 읽지 않는다. layout, project, surface의 등록이 바뀔 때 watch를 시작하고 끝내며, watch가 값을 보낼 때마다 activity를 다시 얻는다.

## Card, group card, space의 activity

각 holder는 자기가 담은 것 중 가장 높은 activity를 가지며, 담은 것 중 activity가 있는 것이 없으면 activity가 없다:

- content card는 자기 tab들을 담는다.
- group card는 자기 member, 곧 content card와 group card를 담으므로, 바깥 group card는 그 안 group card들의 activity를 담는다([group card](groups.ko.md#모델)).
- space는 자기 layout의 card들을 담는다.

창은 자기가 가진 project들의 tab에서 이 activity들을 얻는다. 그 project들은 창이 연 project들로, 그 tab들은 창의 surface로 남고([메모리 절약](plugins.ko.md#메모리-절약)), 보이는 space는 저장된 layout 대신 그린 layout을 쓴다. project의 surface는 그 project를 가진 창의 surface이므로 다른 창은 그것을 얻을 수 없다. `docs/spec/cases/activity.json`의 공유 case `windows`가 tab의 activity를 그 status들에서, 각 project의 space들의 activity를 저장 형식([저장](groups.ko.md#저장))의 layout에서 정하고, `packages/workbench/activity.js`와 `packages/workbench-mygo/src/activity.go`가 그 case를 실행한다. 창은 project의 activity를 얻지 않는다.

## Project의 activity

application은 자기 project들의 activity 기록 하나를 host에 창별이 아니라 project별로 가진다. project는 자기 space들, 곧 보이는 space와 보이지 않는 space 중 가장 높은 activity를 가지며, 기록은 activity가 있는 project만 `{activity, spaces}`로 나열한다. project는 어느 창이 그것을 가지든, 다른 project와 창을 나누든 자기 창을 따로 가지든 모든 창에서 같은 값을 주며, 이 기록이 project의 activity를 얻는 유일한 곳이다.

project를 가진 창은 그 space들의 activity가 바뀔 때마다 host call `projectActivity({id, spaces})`로 그것을 알린다. `spaces`는 activity가 있는 project의 각 space를 case `windows`가 얻는 대로 `{activity, cards, groups}`에 대응시키고, 빈 `spaces`는 project를 기록에서 뺀다. host는 다음 문장으로 알림을 거절하고 기록을 바꾸지 않는다:

| 발견한 것 | 문장 |
| --- | --- |
| project id가 아닌 `id` | `invalid project id` |
| project를 가지지 않은 창 | `project <id> is not owned by this window` |
| activity가 아닌 space의 `activity` | `project <id> space <space>: activity <value> is not one of attention, failed, running, idle` |
| activity가 아닌 `cards`의 값 | `project <id> space <space> card <card>: activity <value> is not one of attention, failed, running, idle` |
| activity가 아닌 `groups`의 값 | `project <id> space <space> group <card>: activity <value> is not one of attention, failed, running, idle` |

`<value>`는 값의 JSON 문장이다. space들은 식별자의 code point 순서로, 각각 그 `activity`, 다음으로 `cards`와 `groups`를 code point 순서로 검사한다. host는 project를 알린 창이 그 project를 놓을 때([project](projects.ko.md#프로젝트-식별)), 닫힐 때, 또는 그 page가 끝나거나 새 page가 시작할 때 그 project의 항목을 지운다. activity를 준 surface들이 그와 함께 끝났기 때문이다. 다음에 project를 가진 창은 그 surface들이 보고하면 다시 알린다. 그러므로 한 창을 떠나 다른 창으로 간 project에는 앞 창의 항목이 남지 않고, 지운 project에는 항목이 없다.

기록은 바뀔 때마다 0에서 시작하는 정수 `revision`을 올리고, host는 기록 `{revision, projects}`를 event `project-activity`로 모든 창에 보낸다. 창이 준비를 보고하면(`windowReady`) 그 창에 현재 기록을 보내므로, 새 창은 다른 창들의 project를 가지고 시작한다. 창은 받은 것 중 가장 높은 revision의 기록을 가진다. `docs/spec/cases/activity.json`의 공유 case `records`가 각 알림과 삭제 뒤의 기록을 정하고, `packages/host/go`, `packages/host/rust`의 기록과 browser runtime이 쓰는 `packages/workbench/activity.js`의 기록이 그 case를 실행한다.

## Status

`core.activity`는 activity를 `{projects, tabs}`로 보고한다. `projects`는 application의 project 기록([project의 activity](#project의-activity))으로, 이 창이 가지든 다른 창이 가지든 activity가 있는 각 project에 대해 `{activity, spaces}`를 담고, `spaces`는 activity가 있는 그 각 space에 대해 `{activity, cards, groups}`를 담는다. `cards`는 activity가 있는 space의 각 content card를, `groups`는 activity가 있는 각 group card를 card 식별자로 그 activity에 대응시킨다. `tabs`는 activity가 있는 이 창의 project들의 각 tab을 tab 식별자로 그 activity에 대응시킨다. activity가 없는 holder는 나열하지 않으므로, 어떤 tab도 activity가 없는 application은 `{projects: {}, tabs: {}}`를 보고한다. 창의 project tab, space tab, group header는 `projects`의 activity를, card의 tab은 `tabs`의 activity를 그린다.

## 그리기

각 workbench는 activity가 있는 card의 각 tab(`core.activity.tab`), 각 group header(`core.activity.group`), 각 space tab(`core.activity.space`), 각 project tab(`core.activity.project`)의 이름 바로 앞에 그 activity의 icon을 그리고, activity가 없는 곳에는 아무것도 그리지 않는다. content card는 자기 tab들의 activity를 보이며 자기 icon을 그리지 않는다. 각 icon은 위 element 이름의 image로, 그린 icon마다 element 하나가 workbench 순서로 있고, 그 activity의 한국어 이름을 accessible name과 tooltip으로 가지며, command를 실행하지 않고, `core.activity`가 그 activity를 담는다.

icon은 `packages/workbench/workbench.json`의 선언된 icon `activity-attention`, `activity-failed`, `activity-running`, `activity-idle`로, 16 point view box 위에 있으며, chrome 값 `activity-stroke`의 선으로 `activity-icon` 크기에 그리고, 이름과의 간격은 그것을 담은 요소의 간격으로, tab에서는 `tab-gap`, group header에서는 `card-head-gap`, space tab과 project tab에서는 `bar-tab-gap`이다. activity의 이름은 같은 파일의 `activities`다. space tab과 project tab은 이름처럼 frame text 배율을 따르고, column의 project tab은 icon과 이름을 함께 가운데에 둔다:

| Activity | Icon | 색 | 이름 |
| --- | --- | --- | --- |
| `attention` | 느낌표가 든 고리 | `focus` | 응답 대기 |
| `failed` | 가위표가 든 고리 | `fg` | 실패 |
| `running` | 삼각형이 든 고리 | `rail` | 실행 중 |
| `idle` | 고리 | `muted` | 유휴 |

icon은 정적이다. activity가 바뀌면 다음 icon을 한 번 그리고, 어떤 icon도 움직이지 않으므로, activity가 바뀌지 않는 동안 activity는 frame에 일을 더하지 않는다. 어떤 icon도 오류 색 `no`를 쓰지 않는다. 그 색은 오류 표시의 것이다.
