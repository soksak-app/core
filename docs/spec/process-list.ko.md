# Process list

[English](process-list.md)

이 계약은 terminal session 의 process list 를 정의한다. 이 list 는 system 의 process table 에서 읽은 session 의 foreground program 과 background job 이다. command `<plugin>.process.list`, 이를 제공하는 sidecar operation `process.list`, list 를 session 상태에 보관하게 하는 이벤트 `processes`, 그리고 규칙의 shared case 를 정의한다. 구현과 검증은 [features](../features.ko.md)에서 추적하며, 이 계약을 승인해도 구현이 확인되지는 않는다.

## Owner

- plugin `terminal` 과 `term` 은 각각 command `<plugin>.process.list` 를 선언하고 노출하며([exposure](exposure.ko.md)), status `<plugin>.session` 에 `foreground` 와 `background` 를 보관한다([terminal read](terminal-read.ko.md#session-상태)).
- sidecar `vt` 와 `alacritty` 는 각각 자기 session 의 terminal 의 process 를 읽고 operation 에 답한다. sidecar `vt` 는 plugin `terminal` 을, sidecar `alacritty` 는 plugin `term` 을 제공한다. 첫 platform 은 macOS 다.
- core 는 이 계약, 그 wire shape 와 shared case(`docs/spec/cases/process-list/jobs.json`)만 선언한다. core 는 process 를 읽지 않으며, code 에서 sidecar 나 plugin 의 이름을 쓰지 않는다([sidecars](sidecars.ko.md)).

## Process

foreground program 과 각 background job 은 한 가지 형식을 가진다.

| Key | Value | macOS 의 출처 |
| --- | --- | --- |
| `group` | process group id. member 가 끝나는 동안에도 program 이나 job 을 식별한다 | `proc_pidinfo(PROC_PIDTBSDINFO)` 의 `pbi_pgid` |
| `pid` | entry 가 나타내는 process 의 id. 양의 정수 | [members](#members) |
| `command` | 그 실행 파일의 경로 | `proc_pidpath` |
| `arguments` | 문자열 배열: program 이름 뒤의 process arguments. argument 하나에 문자열 하나이고 process 의 순서를 따른다. 없으면 빈 배열 | `sysctl(KERN_PROCARGS2)` |
| `cwd` | 그 작업 directory 의 경로 | `proc_pidinfo(PROC_PIDVNODEPATHINFO)` |
| `started` | process 의 시작 시각. Unix epoch 이후의 millisecond 정수 | `pbi_start_tvsec` 과 `pbi_start_tvusec` |

background job 은 `state` 도 담는다([background jobs](#background-jobs)).

- entry 의 process: group 의 leader(그 pid 는 group id 다)가 끝나지 않았으면 그 leader, 아니면 끝나지 않은 member 중 pid 가 가장 작은 group 의 member. 끝나지 않은 member 가 없는 group 은 entry 가 없다.
- 거절된 읽기: 다른 사용자의 process 의 arguments 나 작업 directory 처럼 system 이 entry 의 process 의 읽기 하나를 거절하면 member `command`, `arguments`, `cwd`, `started` 는 `null` 이고 member `error` 가 그 읽기와 이유를 이름한다. 어떤 값도 추측하지 않는다.
- agent 는 그 `arguments` 와 session file 로 식별된다([agent conversation](agent-conversation.ko.md)). process 이름만으로는 agent 를 식별하지 않으며, 이 계약은 agent 식별을 정의하지 않는다.

## Members

list 의 member 는 제어 terminal 이 session 의 terminal 인 process 다. `PROC_TTY_ONLY` 와 terminal 의 device 로 부른 `proc_listpids`, 그리고 각 pid 의 group 과 상태를 `proc_pidinfo(PROC_PIDTBSDINFO)` 로 읽는다. list 와 그 읽기 사이에 끝난 process(`ESRCH`)는 member 가 아니다. member 의 상태는 `pbi_status` 와 `pbi_flags` 를 따른다.

| `pbi_status` | 상태 |
| --- | --- |
| `SZOMB`, 또는 `pbi_flags` 에 `P_INEXIT` 가 있는 모든 status | `ended` |
| `SSTOP` | `stopped` |
| `SIDL`, `SRUN`, `SSLEEP` | `running` |

## Foreground program

foreground program 은 PTY master 의 `tcgetpgrp` 가 이름하는 session 의 terminal 의 foreground process group 의 [process](#process) 다. 그 group 에 끝나지 않은 member 가 없으면 `null` 이며, foreground process group 이 없는 terminal 도 여기에 든다. 그런 terminal 에 대해 `tcgetpgrp` 는 member 가 없는 group 을 이름한다. shell 이 prompt 에서 기다리는 동안에는 shell 이 foreground program 이다.

## Background jobs

background job 은 member 의 process group 중 foreground process group 도 아니고 session leader(sidecar 가 시작한 shell)의 process group 도 아닌 것이다. session leader 는 자기 group 의 leader 이므로 그 group id 는 shell 의 pid 다. shell 의 job table 은 shell 안에 있으므로 list 는 system 이 이름하는 terminal 의 process group 을 보인다. `disown` 뒤처럼 shell 이 더 이상 추적하지 않는 job 도 그 group 에 member 가 있는 동안 list 에 남고, session 의 program 이 `setpgid` 로 만든 group 도 list 에 있다.

- 순서: process group 하나에 entry 하나이며, group id 의 오름차순이다.
- 상태: group 의 끝나지 않은 member 가 모두 멈춰 있으면 `stopped`, 아니면 `running` 이다.
- 한계: `set +m` 뒤의 zsh 처럼 job control 이 없는 shell 은 `&` 로 시작한 process 를 shell 의 process group 에 두므로, 그 process 는 이 list 의 background job 이 아니다. list 는 그것을 같은 group 에서 실행되는 그 shell 의 foreground command 와 구별할 수 없다. sidecar 가 시작하는 shell 은 interactive 이고 job control 을 가지므로 그런 shell 의 각 job 은 자기 process group 을 가진다.
- `(sleep 100) &` 같은 subshell job 은 shell 의 fork 이므로 그 entry 는 shell 의 실행 파일과 그 arguments 를 이름한다.

shared case `docs/spec/cases/process-list/jobs.json` 이 규칙을 나타낸다. 각 case 는 session leader, foreground group, 그리고 group 과 상태를 가진 member 를 주고, group, pid, state 를 가진 기대 foreground 와 background entry 를 준다. 두 sidecar 는 규칙의 함수로 이를 실행하고, 각 sidecar 의 실제 PTY test 는 `sleep 100 &` 와 foreground 의 `less` 를 가진 shell 을 실행한다.

## Session state

sidecar 는 session 의 각 출력 뒤에(shell 의 prompt 도 출력이다) process list 를 읽고, list 가 마지막으로 보낸 list 와 다르면 이벤트 `{event: "processes", foreground, background}` 를 보낸다. plugin 은 두 member 를 `<plugin>.session` 에 보관한다([terminal read](terminal-read.ko.md#session-상태)).

- 실패한 읽기: sidecar 는 다음 읽기가 달라질 때까지 한 번 `{event: "processes", error}` 를 보내고, plugin 은 list 를 알 수 없음을 나타내도록 `foreground` 와 `background` 를 `null` 로 두며, 그 오류를 application log 에 쓰는 자기 오류 표시 경로로 보인다.
- Job 의 이벤트: sidecar 는 session 마다 `kqueue` 하나를 가진다. 각 읽기 뒤에 아직 지켜보지 않는 background job 의 각 member 를 `EVFILT_PROC`, `NOTE_EXIT`, `NOTE_SIGNAL` 로 지켜보고, 더 이상 그런 member 가 아닌 process 의 지켜보기는 지운다(`EV_DELETE`). 지켜보는 process 가 끝나거나 job 의 정지와 재개처럼 signal 을 받으면 list 를 다시 읽는다. system 은 process 가 끝날 때 그 지켜보기를 지우므로 지켜보기가 같은 pid 의 이후 process 를 이름하는 일은 없다. system 이 이미 지운 지켜보기의 삭제(`ENOENT`)는 그 끝이며, 지켜보기가 시작되기 전에 끝난 process(`ESRCH`)는 sidecar 가 list 를 곧바로 다시 읽게 한다. 그 밖의 지켜보기 거절은 pid 와 이유와 함께 event log 에 기록된다. `kqueue` 는 session 과 함께 닫힌다.
- 새 job: shell 은 fork 로 job 을 시작하고 그 뒤에 자기 group 으로 옮기며, interactive shell 은 시작한 job 의 번호와 pid 를 쓰므로 시작 뒤의 출력이 그것을 이름한다.
- 비용: 읽기는 PTY 의 한 번 읽기의 byte 를 담은 session 의 출력 이벤트마다 한 번 실행된다.

## Request

plugin 은 sidecar page interface 로 body `{"operation": "process.list"}` 의 request 를 보낸다([page interface](sidecars.ko.md#페이지-인터페이스)). member `operation` 은 두 sidecar 의 모든 request 의 operation field 다([messages](sidecars.ko.md#메시지)). operation 은 request 시점에 process list 를 읽으며, 마지막 이벤트로 답하지 않는다.

## Reply

sidecar 는 body `{"event": "process.list", "foreground", "background"}` 로 답한다. `foreground` 는 [process](#process) 또는 `null` 이고, `background` 는 [background jobs](#background-jobs) 의 배열이며 session 에 job 이 없으면 비어 있다. command `<plugin>.process.list` 는 `{foreground, background}` 를 돌려준다.

## Failures

실패는 명시적 오류다. sidecar 는 member `error` 와 request `{"operation": "process.list"}` 를 가진 body 로 답하고, plugin 은 그 text 로 command 를 거절하며 오류 표시 경로로 보인다. [session state](#session-state) 의 실패한 읽기도 같은 text 를 담는다.

| 조건 | `error` text |
| --- | --- |
| surface 에 열린 session 이 없음 | `Session not open` |
| session 의 master 가 닫힘 | `session master is closed` |
| `tcgetpgrp` 가 실패함 | `read the foreground of the session: <reason>` |
| PTY 의 terminal 을 이름하거나 읽을 수 없음 | `read the terminal of the session: <reason>` |
| terminal 의 process 를 나열할 수 없음 | `list the processes of terminal <path>: <reason>` |
| `ESRCH` 가 아닌 이유로 member 의 group 과 상태를 읽을 수 없음 | `read process <pid> of terminal <path>: <reason>` |
| platform 이 operation 을 구현하지 않음 | `process.list is not implemented on <os>` |

group 과 상태를 읽을 수 없는 member 는 list 를 실패시킨다. 그것 없이는 그 job 과 job 의 상태를 말할 수 없기 때문이다. entry 의 process 의 거절된 읽기는 list 의 실패가 아니다. 그 entry 가 `error` 를 담는다([process](#process)). platform 형식은 repository 의 platform 규칙을 따른다. operation 을 구현하지 않는 platform 은 `not implemented on <os>` 를 돌려주며, `<os>` 는 `darwin`, `linux` 또는 `windows` 다.

## Decisions

첫 초안의 여덟 열린 결정은 계약, platform 의 표준, sidecar 의 code 로 다음과 같이 정한다.

1. Operation 이름과 operation field: operation 은 member `operation` 의 `process.list` 이며, 두 sidecar 는 모든 request 에서 이 member 를 읽는다. 이 sidecar 들의 읽기는 대상과 동사를 이름하고(`screen.read`, `shell.state.read`), 이 읽기의 reply 는 list 다.
2. Foreground 방식: PTY master 의 `tcgetpgrp`. 두 sidecar 는 session 상태의 foreground 를 위해 이미 이를 부른다. POSIX terminal interface 는 terminal 의 foreground process group 을 이 호출로 정의한다. 이를 부르는 PTY library 의 method 는 실패를 group 없음으로 답하므로 sidecar 가 직접 부르고 그 실패를 알린다.
3. Background job: `proc_listpids(PROC_TTY_ONLY)` 와 `proc_pidinfo(PROC_PIDTBSDINFO)` 로 읽는 session 의 제어 terminal 의 process group. shell 의 job table 은 shell 안에 있고 system 의 어떤 interface 도 그것을 읽지 않는 반면, job control 은 각 job 에 terminal 의 자기 process group 을 준다. 따라서 list 는 terminal 의 process group 을 이름하며, [background jobs](#background-jobs) 가 적듯이 shell 이 추적하지 않는 group 도 포함한다.
4. OSC 133: 어떤 entry 도 쓰지 않는다. mark `A`, `B`, `C`, `D` 는 prompt 의 상태와 exit code 를 담고 process id, 이름, job 은 담지 않으므로([terminal state](terminal-state.ko.md)) 모든 entry 는 process table 에서 온다.
5. 오류 text: [failures](#failures) 표의 text. `Session not open` 과 `session master is closed` 는 두 sidecar 가 session 없는 surface 와 닫힌 master 에 이미 답하는 text 다.
6. `started`: `pbi_start_tvsec` 과 `pbi_start_tvusec` 에서 얻은 Unix epoch 이후의 millisecond 정수. page 의 시각 형식(`Date.now()`)이며, `pid` 와 함께 새 process 를 같은 id 의 이전 process 와 구별한다.
7. Job 의 이름: job 은 foreground program 처럼 process table 에서 읽은 `command` 와 `arguments` 를 담고, shell 이 job 보고에 보여 주는 command line 은 담지 않는다. 그 command line 은 확장 전의 shell 의 text 다. 한 형식이 두 member 를 제공하며, `group` 은 leader 와 다른 member 가 끝나는 동안에도 job 을 식별한다.
8. Source: list 의 source 는 process table 하나이므로 entry 는 member `source` 를 담지 않는다. 가능한 값이 하나인 member 는 독자에게 아무것도 알리지 않는다.

sidecar 는 arguments 를 `sysctl(KERN_PROCARGS2)` 로 읽는다. library `sysinfo` 도 같은 값을 읽지만, system 이 읽기를 거절하면 arguments 가 없는 process 와 같은 빈 arguments 를 돌려준다. 계약은 거절된 읽기가 오류일 것을 요구하므로 sidecar 가 직접 읽고 code 에 이를 적는다. 지켜보기는 system call 로 `kqueue` 를 쓴다. crate `kqueue` 는 macOS 에서 `NOTE_SIGNAL` 이 없고 모든 지켜보기를 한 호출로 등록하는데, 끝난 process 하나가 그 호출을 멈춘다. `nix` 의 `Kqueue` type 은 sidecar 의 reactor 에 줄 descriptor 를 내주지 않는다.

## Review

두 번의 review round 가 열네 반론을 냈고, 근거로 판정했다.

첫 round, 여덟 반론:

- 받아들임: job control 이 없는 shell 의 한계는 shell 의 group 을 이름한다. entry 의 `pid` 는 leader 가 끝나면 바뀌므로 entry 는 `group` 을 담는다. 읽기 중에 끝난 process 는 member 가 아니다. job member 의 종료와 signal 은 `kqueue` 의 이벤트이므로 list 는 출력 없이 그것을 따른다. 결정 7 의 이유는 더 이상 arguments 를 shell 의 text 라 하지 않고, subshell job 을 적는다. list 는 shell 이 추적하지 않는 group 을 포함한 terminal 의 process group 을 이름한다.
- 거절함: job control 이 없는 session 에 대한 오류. 그런 session 도 foreground program 과 유효한 list 를 가진다. shell 의 fork 지켜보기. fork 는 job 의 group 으로 옮기기보다 먼저 오고 shell 은 job 의 시작을 쓴다. job 의 새 용어. 이 계약이 용어를 정의하며 shell 의 job table 은 읽을 수 없다. 읽기 빈도의 한도. 읽기는 foreground 의 읽기처럼 출력 이벤트마다 한 번 실행되며, 성능은 개발 뒤 benchmark 로 측정한다. subshell, 읽기 중 process 의 종료, job control off 의 shared case. 규칙은 member 를 입력으로 받으며 이 case 들은 규칙에 다른 입력을 주지 않는다.

둘째 round, 여섯 반론:

- 받아들임: foreground program 은 entry 의 process 규칙을 따르고 `group` 을 담으며, 끝난 leader 의 shared case 를 가진다. entry 의 process 는 끝나지 않은 member 중에서만 고르며, zombie leader 의 shared case 를 가진다. 지켜보기는 session 마다 `kqueue` 하나로, 새 member 에 더하고 떠난 process 에서 지우며 session 과 함께 닫힌다. `tcgetpgrp` 와 member 의 group 과 상태의 거절된 읽기는 각자의 실패를 가진다. 각 member 의 출처와 `pbi_status` 의 상태를 적는다. session 상태의 실패한 읽기는 plugin 이 보이고 두 member 를 `null` 로 두는 이벤트다.
- 거절함: 지켜보기의 key 로 `pid` 와 `started` 를 쓰는 것. system 은 지켜보기를 process 에 붙이고 process 가 끝날 때 지우므로 같은 pid 의 이후 process 에는 지켜보기가 없다.
