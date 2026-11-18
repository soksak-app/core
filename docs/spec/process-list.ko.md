# Process list

[English](process-list.md)

이 계약은 terminal session의 process list를 정의한다. session의 foreground program과 background job을 각각 source와 함께 나열한다. command `term.process.list`와 이를 제공하는 sidecar operation의 request 및 reply를 정의한다. 구현과 검증은 [features](../features.ko.md)에서 추적하며, 이 계약을 승인해도 구현이 확인되지는 않는다.

## Owner

- plugin `term`이 command `term.process.list`를 선언하고 노출한다([exposure](exposure.ko.md)).
- sidecar `alacritty`가 session의 process를 읽고 operation에 답한다. 첫 platform은 macOS다.
- core는 이 문서의 계약과 wire shape만 선언한다. core는 process를 읽지 않으며, code에서 sidecar나 plugin의 이름을 쓰지 않는다([sidecars](sidecars.ko.md)).

## Request

plugin은 sidecar page interface로 request를 보낸다([page interface](sidecars.ko.md#페이지-인터페이스)). host는 [messages](sidecars.ko.md#메시지) 절의 envelope으로 sidecar request line을 전달한다.

| Key | Value |
| --- | --- |
| `surface` | terminal session의 surface |
| `root` | 소유 window의 project directory. 모든 request와 같다 |
| `body` | `{"operation": <operation name>}` |

body의 key `operation`은 operation selector를 가리킨다. sidecar는 selector field를 `sidecar.json`의 `message.operationField`로 선언한다([sidecars](sidecars.ko.md#메시지)). `alacritty`의 `operationField` 값은 이 문서가 정하지 않는다(open question 1).

이 계약의 operation name도 이 문서가 정하지 않는다(open question 1).

## Reply

sidecar는 reply line의 envelope으로 답한다: `{"surface": <surface>, "cids": [...], "body": <reply body>}`([messages](sidecars.ko.md#메시지)). reply body의 key는 다음과 같다.

| Key | Value |
| --- | --- |
| `foreground` | foreground program을 담은 object. session에 읽을 수 있는 foreground program이 없으면 `null` |
| `background` | background job의 array. source가 보고한 순서를 따른다. session에 background job이 없으면 빈 array |

foreground object의 key는 다음과 같다.

| Key | Value |
| --- | --- |
| `name` | foreground process group의 leader process 이름 |
| `arguments` | leader process의 arguments |
| `started` | leader process의 시작 시각(format은 open question 6) |
| `source` | entry의 source(Sources 참조) |

각 background job의 key는 다음과 같다.

| Key | Value |
| --- | --- |
| `name` | job의 이름(open question 7) |
| `pid` | job의 process id, 양의 정수 |
| `state` | `running` 또는 `stopped` |
| `source` | entry의 source(Sources 참조) |

## Foreground program

foreground program은 session의 terminal을 소유한 process group의 leader다. sidecar는 session의 PTY에서 foreground process group을 읽는다. macOS에서 이 process group을 지정하는 mechanism은 열려 있다(open question 2).

## Background jobs

background job은 session의 shell이 가진 job 중 foreground program이 아닌 것이다. 각 job은 `name`, `pid`, `state`로 나열하며, `state` 값은 `running`과 `stopped`다. job은 화면이 아니라 session의 process table에서 읽는다. shell의 job을 식별하는 mechanism은 열려 있다(open question 3).

## Sources

각 entry는 source를 가진다. 허용하는 source는 다음과 같다.

- `process-table`: entry를 session의 process table에서 읽었다.
- `osc-133`: entry를 shell이 보내는 OSC 133 command mark에서 얻었다.

`osc-133`이 어떤 entry에 적용되는지는 열려 있다(open question 4). `process-table`과 `osc-133`은 이 문서가 고른 wire 값이며, 최종 표기는 열려 있다(open question 8).

process 이름만으로 agent를 식별하지 않는다. agent는 arguments와 session file로 식별한다([terminal plan](../plans/terminal-plan.md), Part 1, option 6). 이 문서는 agent 식별을 정의하지 않는다.

## Failures

실패는 명시적인 error다. sidecar는 `error` member를 가진 object인 body로 답한다([messages](sidecars.ko.md#메시지)). host는 그 reply를 `host.sidecar.reply`로 저장한다. operation 누락이나 sidecar error는 실패이며 대체하거나 버리지 않는다([sidecars](sidecars.ko.md#메시지)). 다음 실패를 정의한다.

| 조건 | reply `error` 문구 |
| --- | --- |
| session이 닫혀 있다 | 열림(open question 5) |
| session의 process를 읽을 수 없다 | 열림(open question 5) |
| platform이 operation을 구현하지 않는다 | `<operation name> is not implemented on <os>` |

platform 형식은 저장소의 platform 규칙을 따른다. operation을 구현하지 않는 platform은 platform file `platform/<os>/unsupported.*`에서 `not implemented on <os>`를 반환한다(저장소 `AGENTS.md`, Platform-specific files). Windows file `packages/host/go/src/platform/windows/unsupported.go`가 이 형식을 쓴다. 문구의 operation name은 request의 operation 이름이다(open question 1). `<os>` 값은 platform folder 이름인 `darwin`, `linux`, `windows`다.

## Open decisions

1. sidecar operation name과 `operationField` 값. 저장소는 `alacritty`의 operation 이름을 정하지 않는다. plugin manifest는 `background.operation`에 읽기 쉬운 이름을 선언하고([sidecars](sidecars.ko.md#메시지)), sidecar 이름은 core에 없다. 이유: 선언이 없다.
2. macOS에서 PTY의 foreground process group을 지정하는 mechanism. plan의 V3가 열려 있다([terminal plan](../plans/terminal-plan.md), Part 2, V3). 이유: macOS에서 process를 지정하는 test가 아직 없다.
3. shell의 background job을 식별하는 mechanism. plan은 shell의 job을 name, pid, state와 함께 요구하지만, sidecar가 process table에서 job 목록을 얻는 방법은 정하지 않는다. 이유: plan이 정하지 않는다.
4. `osc-133`이 entry에 적용되는지. plan은 OSC 133 mark를 가능한 source로 적지만 어느 entry가 쓰는지 정하지 않는다. 이유: plan이 정하지 않는다.
5. session이 닫혔을 때와 process를 읽을 수 없을 때의 정확한 `error` 문구. 기존 convention이 이 조건을 다루지 않는다. 이유: 저장소에 이 조건의 문구가 없다.
6. `started`의 format. 이유: plan이 시각 format을 정하지 않는다.
7. background job의 `name`: executable 이름인지 command line인지. 이유: plan이 정하지 않는다.
8. source 값 `process-table`과 `osc-133`의 정확한 wire 표기. 이유: plan은 source를 산문으로 적고 표기를 정하지 않는다.

