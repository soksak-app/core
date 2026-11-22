# 프로그램 상태

[English](program-state.md)

탭의 프로그램 상태는 탭을 열지 않고도, 탭의 표면이 실행하는 프로그램이 유휴인지, 일하는 중인지, 사람을 기다리는지를 사람과 애플리케이션의 plugin들에게 알린다. agent CLI처럼 탭에서 프로그램을 실행하는 plugin은 자기 status 중 어느 것이 그 상태를 담는지 선언하고, 각 창은 그 status를 자기 project의 각 탭에서 따라가며 `core.grid`에 보고한다. core는 plugin의 이름을 쓰지 않는다.

프로그램 상태는 탭의 activity([activity](activity.ko.md))와 별개다. activity는 core가 그리는 icon을 위해 유도하는 표시 단계다. 그 값에는 프로그램의 상태가 아닌 `failed`가 있고, 각 holder마다 가장 높은 값을 고르므로 card의 activity로는 어느 탭이 기다리는지 알 수 없다. 프로그램 상태는 자기만의 세 값을 가지며 탭마다 읽는다.

## 선언

`surface.program`이 있으면 plugin.json의 `exposes.status` 중 같은 plugin의 status 하나를 가리킨다([plugin.json](plugins.ko.md#pluginjson)). 그 status가 plugin 탭들의 프로그램 상태의 유일한 출처다. manifest 검사는 다음 글로 선언을 거부하며, `<plugin>`은 `plugin <id>`다:

| 발견 | 글 |
| --- | --- |
| 문자열이 아닌 `surface.program` | `<plugin>: surface program must be a status name` |
| `exposes.status`가 선언하지 않은 이름 | `<plugin>: surface program <name> must name a status declared in exposes` |
| 아래 schema가 아닌 status | `<plugin>: surface program <name> must have a schema of type object and null whose state is one of idle, working, blocked and whose pid is an integer or null` |

status의 schema는 `type`이 `object`와 `null`을 담는 list이고, `required`가 `state`를 담는 list이며, `properties.state`가 `{type: "string", enum}`이고 그 `enum`이 `idle`, `working`, `blocked` 세 값만 담으며, `properties.pid`가 `{type}`이고 그 `type` list가 `integer`와 `null`을 담는다. 각 언어의 reader는 같은 조건을 검사하며, `docs/spec/cases/manifest-validation.json`의 공유 case가 그것을 정한다.

## 값

status의 값은 탭에 프로그램 상태가 없을 때 `null`이고, 그렇지 않으면 member가 `state`와 `pid`뿐인 객체다:

| `state` | 뜻 |
| --- | --- |
| `idle` | 프로그램이 자기 prompt에서 쉬며 처리할 작업이나 대기 중인 질문이 없다 |
| `working` | 프로그램이 작업을 실행한다 |
| `blocked` | 프로그램이 승인이나 답처럼 사람을 기다린다 |

`pid`는 탭의 foreground 프로그램의 process id로, 양의 정수이거나 탭이 프로그램을 실행하지 않으면 `null`이다. schema 검사는 `pid`의 부호를 보지 않으며, 워크벤치는 양의 정수가 아닌 `pid`를 값 오류로 거부한다.

`null`도 아니고 member가 `state`, 세 값 중 하나인 값, `pid`(양의 정수 또는 `null`)뿐인 객체가 아닌 값은 plugin의 오류다. 그 탭은 프로그램 상태가 없고, 워크벤치는 창의 오류 banner에 오류 표시 경로로 `<plugin> exposes <status> on tab <tab>: program value <value> is not null or an object with only the members state and pid, where state is one of idle, working, blocked and pid is a positive integer or null` 글을 원인 `program <tab>`과 함께 보인다. `<value>`는 값의 JSON 글이다. status가 다시 올바른 값을 보고하거나 탭이 창을 떠나면 오류가 사라진다.

## 따라가기

워크벤치는 자기 창 project들의 각 탭 표면에서 그 status를 표면의 watch로 따라간다. activity status를 따라가는 방식과 같다([탭의 activity](activity.ko.md#tab의-activity)). 표면이 status를 등록하지 않았으면 값은 `null`이다. 워크벤치는 timer로 요청하지 않으며, watch가 값을 전할 때마다 프로그램 상태를 다시 구한다. `surface.program`을 선언하지 않은 plugin의 탭은 값이 `null`이고, 탭의 watch는 탭과 함께 시작하고 끝난다.

## 보고

`core.grid`는 내용 카드의 각 탭에 대해 `cards[].tabs[]`의 `program`을 보고한다([group](groups.ko.md#모델)). 값은 탭의 status 값과 같은 `{state, pid}`이거나, 탭에 프로그램 상태가 없으면 `null`이다. 두 워크벤치에서 이 member의 뜻은 같다. plugin은 core status인 `core.grid`에서 어느 plugin 탭의 프로그램 상태든 읽으며, view는 그것을 읽으려고 선언을 두지 않는다.
