# 재생

[English](replay.md)

화면을 만드는 sidecar는 session의 입력을 완전하게 저장하고 만든 화면마다 hash를 저장하며, page는 그린 화면마다 hash를 저장한다. 재생(replay)은 저장된 입력에서 session의 화면을 다시 만들어 저장된 모든 hash를 재생한 hash와 비교한다. frame 내용은 저장하지 않으므로([logging](logging.ko.md#catalog), [관측 감사](../plans/observability-audit.ko.md)의 결정), 재생이 화면을 재현하기 전까지 저장된 hash는 아무것도 검증하지 않는다. 이 문서는 기록, 화면 hash, 재생 실행 파일, 명령을 정의한다. event 자체는 sidecar와 plugin의 카탈로그가 선언하며([logging](logging.ko.md#catalog)), 이 저장소는 둘 다 이름으로 부르지 않는다.

## 기록

*재생 입력*은 층이 `sidecar`인 event로서 `session`(session의 식별자, 줄의 member), `fields.sequence`, 한 번의 발생의 완전한 입력을 가진다.

| 입력 | 필수 field |
| --- | --- |
| session의 프로그램이 낸 출력(의사 터미널에서 읽은 바이트) | `sequence`, `hex` |
| 프로그램에 준 입력(의사 터미널에 쓴 바이트) | `sequence`, `hex` |
| 크기 변경 | `sequence`, `rows`, `cols` |

`hex`는 발생한 바이트 전체의 소문자 16진 글이다. 입력 event는 text 같은 파생 사본을 갖지 않는다. `sequence`는 session마다 1부터 세는 정수이며 종류에 관계없이 재생 입력마다 1씩 늘므로 session의 순번에는 빈틈이 없고, 재생은 `sequence` 순서로 입력을 적용한다. 쓰기를 일으키는 키 입력은 `cids`도 가진다([logging](logging.ko.md#event)).

*frame 기록*은 class가 `frame`인 event로서 `session`, `fields.sequence`, `fields.rows`, `fields.cols`, `fields.hash`를 가진다. `sequence`는 화면이 포함하는 마지막 재생 입력의 순번이고, `hash`는 그 입력 뒤 화면의 [화면 hash](#화면-hash)다. sidecar는 만든 화면마다 층 `sidecar`의 frame 기록 하나를 쓴다. page는 그린 화면마다 층 `page`의 frame 기록 하나를 쓰며, sidecar에서 받은 화면의 `sequence`, `rows`, `cols`와 그린 격자의 hash를 담는다. hash는 page가 그린 것에서 계산하며 화면을 실어 온 메시지에서 옮기지 않는다. page는 sidecar가 만든 화면만 그리므로 page의 frame 기록마다 `session`과 `sequence`가 같은 sidecar의 frame 기록이 있다.

## 화면 hash

화면 hash는 화면의 정규 바이트열의 SHA-256이며 소문자 16진 64자다. 모든 정수는 부호 없는 big endian이다.

| 부분 | 바이트 |
| --- | --- |
| 표지 | ASCII 6바이트 `SKSCR1` |
| `rows` | 4 |
| `cols` | 4 |
| 커서 표시 | 1 (`1` 표시, `0` 숨김) |
| 커서 행 | 4, 0부터, `rows` 미만 |
| 커서 열 | 4, 0부터, `cols` 미만 |
| 칸 | `rows` × `cols`개의 칸, 행 우선 순서 |

칸 하나는 grapheme의 바이트 길이(4바이트), grapheme의 UTF-8 바이트, 너비(1바이트), 전경색(4바이트), 배경색(4바이트), 속성(1바이트)이다.

- *grapheme*은 칸의 글이다. 빈 칸과 넓은 문자의 이어지는 칸은 빈 문자열이고, 그 밖에는 grapheme cluster 하나다. 올바른 형식의 유니코드다.
- *너비*는 칸이면 `1`, 넓은 문자의 첫 칸이면 `2`, 그 이어지는 칸이면 `0`이다.
- *색*은 4바이트다. 기본색은 `00 00 00 00`, 색인 색은 `01 00 00 <index>`(index 0~255), 트루컬러는 `02 <red> <green> <blue>`다.
- *속성*은 flag 1바이트다. bold `01`, dim `02`, italic `04`, underline `08`, blink `10`, inverse `20`, hidden `40`, strikethrough `80`.

화면의 JSON 형식(`@soksak/plugin-api/screen-hash`, golden vector)에서 화면은 `{rows, cols, cursor: {row, col, visible}, cells}`, 칸은 `{grapheme, width, fg, bg, attributes}`, 색은 `null`(기본), 0~255 정수(색인), 소문자 `"#rrggbb"`(트루컬러), `attributes`는 0~255 정수다. hash 함수는 이 형식을 벗어난 값을 member 이름이 있는 오류로 거부한다. golden vector는 `packages/log-contract/fixtures/replay/screen-hash.json`이며, 화면마다 16진 정규 바이트열과 hash, 함수가 거부하는 화면과 그 오류 글을 담는다. 어느 언어의 hash 구현이든 이를 재현해야 한다.

## 재생 실행 파일

화면을 만드는 sidecar는 `sidecar.json`에 `replay`를 선언한다([sidecars](sidecars.ko.md#선언과-시작)). 형식은 `{"role": <role>, "executable": <sidecar 안의 경로>}`다. `role`은 sidecar의 event 파일(`logs/<role>-<boot>.jsonl`)의 role이며, 그 파일의 `log.open`이 밝힌다. 실행 파일은 sidecar의 재생 엔진이다. 터미널 엔진은 거기에 있으므로 명령줄 도구는 어느 것도 이름으로 부르지 않는다.

도구는 sidecar 폴더에서 실행 파일을 인자 없이 시작하고, 표준 입력에 role의 파일에 있는 session의 층 `sidecar` event를 파일 순서대로, 바꾸지 않고, 줄바꿈으로 끝나게, `--until`이 준 `sequence`까지 쓴다. 실행 파일은 재생 입력을 `sequence` 순서로 빈 화면에 적용하고, 읽은 frame 기록마다 그 순번의 화면 hash를 담은 한 줄 `{"sequence": <n>, "hash": <hash>}`을 표준 출력에 쓴다. 입력이 끝나면 종료 상태 0으로 끝난다. 다른 종료 상태, 그 객체가 아닌 줄, 소문자 16진 64자가 아닌 hash, 줄을 받지 못한 frame 기록은 재생의 실패이며 실행 파일의 오류 글과 함께 보고한다.

## 명령

`sok debug replay <session> [--until <sequence>] [--config-dir <directory>]`([명령줄](cli.ko.md#명령))는 설정 폴더의 event 파일에서 [질의](logging.ko.md#질의)로 session의 event를 읽고, session의 sidecar event의 role을 `replay.role`로 선언한 설치된 sidecar를 찾아 그 재생 실행 파일을 실행한 뒤, `sequence` 순서로, 같은 순번에서는 sidecar 기록을 page 기록보다 먼저 비교한다.

1. sidecar의 frame 기록마다 그 순번의 재생 hash와 비교한다. 다르면 층 `sidecar`의 불일치다.
2. page의 frame 기록마다 그 순번의 재생 hash와 비교한다. 다르거나 그 순번에 sidecar의 frame 기록이 없으면 층 `page`의 불일치다.

첫 불일치에서 비교를 끝낸다. 도구는 `session`, `sequence`, `layer`, `expected`(재생 hash, sidecar의 frame 기록이 없는 page frame이면 `none`), `found`(저장된 hash)를 가진 event `sok.replay.divergence`(수준 `error`)를 저장하고, 표준 오류에 `replay divergence: session <session> sequence <n> layer <layer> expected <expected> found <found>`를 쓰며 종료 상태 1로 끝난다. 모든 hash가 같으면 표준 출력에 `replay session <session>: <n> sidecar frames and <m> page frames equal`을 쓰고 상태 0으로 끝난다. 층 `sidecar` event가 없는 session, frame 기록이 없는 session, 둘 이상의 role의 sidecar event를 가진 session, 그 role을 선언한 설치된 sidecar가 없는 경우는 session과 role을 이름으로 가진 오류다. 두 도구는 같은 출력과 같은 오류 글을 낸다.
