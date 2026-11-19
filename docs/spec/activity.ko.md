# Activity

[English](activity.md)

tab의 activity는 사람이 tab을 열지 않고도 그 surface가 무언가를 실행하는지, 사람을 기다리는지, 실패로 끝났는지 알게 한다. plugin은 surface의 activity를 자기 status에 선언하고, core는 모든 card, group card, space, project의 activity를 그 tab들의 activity에서 얻어 status로 보고하고 두 workbench에서 icon으로 그린다. core는 plugin을 이름으로 알지 않는다.

## Activity의 종류

activity는 높은 것부터 낮은 것 순서로 다음과 같다:

| Activity | 뜻 |
| --- | --- |
| `attention` | surface가 사람을 기다린다. 예를 들어 program이 질문한다 |
| `failed` | surface가 실행한 것이 실패로 끝났다 |
| `running` | surface가 program이나 agent 같은 무언가를 실행한다 |
| `idle` | surface가 아무것도 실행하지 않고 아무것도 기다리지 않는다 |

## 선언

plugin의 status 항목은 멤버 `activity`로 surface의 activity를 선언한다([항목 필드](exposure.ko.md#항목-필드)). 이는 멤버가 하나 이상인 object로, 각 멤버 이름은 status의 값, 곧 status의 `schema`가 받아들이는 string이고, 각 멤버 값은 activity다. 각 reader의 manifest 검사는 다른 형식을 다음 문구로 거부한다. `<at>`은 `<plugin> exposes <status>`이고, `<value>`와 `<activity>`는 멤버 이름과 그 값의 JSON 문구이며, 멤버는 이름의 code point 순서로 검사하고 각 멤버는 값보다 activity를 먼저 검사한다:

| 찾은 것 | 문구 |
| --- | --- |
| object가 아니거나 멤버가 없는 object인 `activity` | `<at>: activity must be an object of values and activities with at least one member` |
| 값이 activity가 아닌 멤버 | `<at>: activity <value> names <activity>, which is not one of attention, failed, running, idle` |
| status의 schema가 받아들이지 않는 멤버 이름 | `<at>: activity <value> is not a value of the schema of the status` |

`docs/spec/cases/manifest-validation.json`의 case가 `packages/plugin-api`, `packages/sok/go`, `packages/sok/rust`의 reader에 대해 이 문구를 담는다.

## Tab의 activity

tab의 activity는 그 plugin의 status 가운데 `activity`를 선언한 것들을 각각 그 tab의 surface에서 읽어 얻은 activity 중 가장 높은 것이다. 값이 그 `activity`의 멤버를 가리키는 string인 status는 그 멤버의 activity를 주고, 값이 어떤 멤버도 가리키지 않는 status는 `null`을 포함해 아무것도 주지 않는다. surface가 등록하지 않은 status는 아무것도 주지 않으므로, surface가 시작하지 않았거나, unload되었거나([메모리 절약](plugins.ko.md#메모리-절약)) 끝난 tab은 activity가 없다. 어떤 status도 activity를 주지 않는 tab은 activity가 없다.

workbench는 자기 창의 project들의 각 tab의 그런 status를 그 surface의 watch로 따른다([전달](exposure.ko.md#전달)). watch는 값의 변화마다 보낸다. workbench는 timer로 값을 읽지 않는다. layout, project, surface의 등록이 바뀔 때 watch를 시작하고 끝내며, watch가 값을 보낼 때마다 activity를 다시 얻는다.

## Card, group card, space, project의 activity

각 holder는 자기가 담은 것 중 가장 높은 activity를 가지며, 담은 것 중 activity가 있는 것이 없으면 activity가 없다:

- content card는 자기 tab들을 담는다.
- group card는 자기 member, 곧 content card와 group card를 담으므로, 바깥 group card는 그 안 group card들의 activity를 담는다([group card](groups.ko.md#모델)).
- space는 자기 layout의 card들을 담는다.
- project는 자기 space들, 곧 보이는 space와 보이지 않는 space를 담는다.

창의 project들은 창이 연 project들로, 그 tab들은 창의 surface로 남는다([메모리 절약](plugins.ko.md#메모리-절약)). 다른 창이 연 project는 이 창에서 activity가 없다. 그 surface들이 이 창의 surface가 아니기 때문이다. `docs/spec/cases/activity.json`의 공유 case가 tab의 activity를 그 status들에서, holder들의 activity를 저장 형식([저장](groups.ko.md#저장))의 layout에서 정하고, `packages/workbench/activity.js`와 `packages/workbench-mygo/src/activity.go`가 그 case를 실행한다.

## Status

`core.activity`는 창의 activity를 `{projects, tabs}`로 보고한다. `projects`는 activity가 있는 창의 각 project에 대해 `{activity, spaces}`를 담고, `spaces`는 activity가 있는 그 각 space에 대해 `{activity, cards, groups}`를 담는다. `cards`는 activity가 있는 space의 각 content card를, `groups`는 activity가 있는 각 group card를 card 식별자로 그 activity에 대응시킨다. `tabs`는 activity가 있는 각 tab을 tab 식별자로 그 activity에 대응시킨다. activity가 없는 holder는 나열하지 않으므로, 어떤 tab도 activity가 없는 창은 `{projects: {}, tabs: {}}`를 보고한다.

## 그리기

각 workbench는 activity가 있는 card의 각 tab(`core.activity.tab`), 각 group header(`core.activity.group`), 각 space tab(`core.activity.space`), 각 project tab(`core.activity.project`)의 이름 바로 앞에 그 activity의 icon을 그리고, activity가 없는 곳에는 아무것도 그리지 않는다. content card는 자기 tab들의 activity를 보이며 자기 icon을 그리지 않는다. 각 icon은 위 element 이름의 image로, 그린 icon마다 element 하나가 workbench 순서로 있고, 그 activity의 한국어 이름을 accessible name과 tooltip으로 가지며, command를 실행하지 않고, `core.activity`가 그 activity를 담는다.

icon은 `packages/workbench/workbench.json`의 선언된 icon `activity-attention`, `activity-failed`, `activity-running`, `activity-idle`로, 16 point view box 위에 있으며, chrome 값 `activity-stroke`의 선으로 `activity-icon` 크기에 그리고, 이름과의 간격은 `tab-gap`이다:

| Activity | Icon | 색 | 이름 |
| --- | --- | --- | --- |
| `attention` | 느낌표가 든 고리 | `focus` | 응답 대기 |
| `failed` | 가위표가 든 고리 | `fg` | 실패 |
| `running` | 삼각형이 든 고리 | `rail` | 실행 중 |
| `idle` | 고리 | `muted` | 유휴 |

icon은 정적이다. activity가 바뀌면 다음 icon을 한 번 그리고, 어떤 icon도 움직이지 않으므로, activity가 바뀌지 않는 동안 activity는 frame에 일을 더하지 않는다. 어떤 icon도 오류 색 `no`를 쓰지 않는다. 그 색은 오류 표시의 것이다.
