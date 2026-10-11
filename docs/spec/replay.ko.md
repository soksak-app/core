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
| 선택 | `sequence`, `action`(`start`, `update`, `end`, `clear`). `start`와 `update`는 `edge`, `row` |
| viewport 스크롤 | `sequence`, `lines`(0이 아닌 정수) 또는 `newest`(`true`) |
| theme | `sequence`, `colors` |

선택, viewport 스크롤, theme은 [보기 상태](#보기-상태)에서 정의한다. `hex`는 발생한 바이트 전체의 소문자 16진 글이다. 입력 event는 text 같은 파생 사본을 갖지 않는다. `sequence`는 session마다 1부터 세는 정수이며 종류에 관계없이 재생 입력마다 1씩 늘므로 session의 순번에는 빈틈이 없고, 재생은 `sequence` 순서로 입력을 적용한다. 쓰기를 일으키는 키 입력은 `cids`도 가진다([logging](logging.ko.md#event)).

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

## 보기 상태

sidecar가 만드는 화면은 그려지는 그대로의 화면이다. viewport의 칸이며, 선택된 칸은 강조색이고 모든 색은 theme을 거쳐 정해진다. 이 화면의 세 상태는 출력 바이트나 크기 변경에서 오지 않는다. *선택*, *viewport*(스크롤백의 offset), *theme*이다. 셋 중 하나가 바뀔 때마다 그 변경은 자기 재생 입력이므로 위의 hash 정의는 바뀌지 않고, 재생은 입력을 적용해 그려진 칸에 이른다.

- **선택.** `action`은 `start`, `update`, `end`, `clear`다. `start`와 `update`는 sidecar가 적용하는 순간 포인터에서 정한 `edge`(그 순간 격자의 열 수까지의 칸 경계, 0부터)와 `row`(viewport의 행, 0부터 행 수 - 1까지)를 가진다. 재생에는 픽셀 척도가 없다. `end`는 제스처를 끝내며 그 뒤의 `update`는 거부한다. `end`와 `clear`는 둘 다 갖지 않는다. sidecar는 효과가 있었던 호출만 저장한다. 격자 밖이거나 시작 없는 update는 입력이 아니라 sidecar의 오류다. 출력, 크기 변경, 대체 화면 전환이 선택을 유지하거나 옮기거나 지우는지, `end`에서 빈 선택이 지워지는 것은 재생 실행 파일이 재현하는 엔진의 동작이며 입력이 아니다. 칸의 hyperlink는 hash에 들어가지 않으므로 link의 어긋남은 발견되지 않는다.
- **viewport.** `lines`는 0이 아닌 정수이고 양수는 더 오래된 줄 쪽이며, 엔진이 보유한 줄로 제한한 뒤의 스크롤백 offset 변화다. `newest`는 가장 새 출력으로의 이동에서 `true`다. sidecar는 원인이 무엇이든(휠, 가장 새 출력으로 스크롤하는 키, page의 요청) 적용한 이동을 저장한다. 아무것도 바꾸지 못한 이동은 저장하지 않는다. 휠 event 여러 개를 입력 하나로 저장하는 것은 그 유효한 합일 때만 허용된다. 출력은 viewport 입력을 만들지 않는다. 출력에 따르는 offset 변화와 스크롤백 한도에서 줄이 밀려 나가는 것은 재생 실행 파일이 재현하는 엔진의 동작이다. 대체 화면이 활성인 동안에는 스크롤백이 없으므로 viewport 입력을 저장하지 않는다.
- **theme.** `colors`는 sidecar가 theme을 거쳐 정하는 색의 완전한 집합으로, 소문자 `#rrggbb` 값의 객체이며 최소한 `foreground`, `background`, `selection`을 가지고, 커서 색과 palette의 각 항목(`ansi0`~`ansi255`)은 더 있는 member이며 sidecar는 색을 정하는 데 쓰는 모든 항목을 적으므로 사용자 정의 palette도 재생된다. theme의 이름이 아니라 완전한 집합인 것은 사람이 정의한 theme에는 재생이 찾을 수 있는 이름이 없기 때문이다. 모든 session의 첫 입력, 곧 `sequence` 1은 theme이며, theme이 바뀔 때마다 또 하나가 온다. theme 입력은 theme만 바꾼다. 프로그램이 자기 출력 sequence로 정한 색은 엔진에 남아 엔진이 주는 우선순위를 따른다. 엔진이 행 끝에서 줄이는 빈 칸은 theme에 달려 있고 hash는 채워진 격자를 덮으므로, theme은 줄이기를 통해서도 hash에 들어간다.
- **순서.** sidecar는 입력을 받은 순서가 아니라 엔진에 적용한 순서로, 모든 종류에 하나의 lock 아래에서 `sequence`를 정한다.
- **커서.** hash의 커서는 viewport의 커서다. `visible`은 프로그램이 정한 표시 여부이고 커서 행이 viewport 밖이면 `false`다(그때 `row`는 `0`이고 `col`은 커서의 열). 깜박임 단계, focus, 입력기의 preedit는 hash에 들어가지 않는다.
- **page.** sidecar가 page에 보내는 화면 메시지는 hash가 덮는 칸(grapheme, 너비, 정해진 색, 속성)과 커서를 담고, 선택의 강조는 이미 칸에 들어 있다. page는 이를 그대로 그리고 그린 칸을 hash하므로 강조, offset, 색에서 page의 결함은 층 `page`의 어긋남이다.
- **엔진.** 스크롤백 한도와 첫 theme 입력 전의 기본 theme은 sidecar의 재생 실행 파일에 속하며, 그것은 session을 만든 엔진이기도 하다. 재생은 session을 저장한 sidecar 버전에 대해 정의된다. 다른 버전의 session은 어긋날 수 있고 그 어긋남은 그렇게 보고된다.
- **class.** 이 입력들은 완전하게 저장하는 class `input`으로 저장한다. class `io`와 `input`을 저장하지 않는 정책은 순번에 빈틈을 남기고, 재생은 처음 빠진 `sequence`에서 session을 거부하며, session의 입력을 덮는 `log.dropped`도 버린 개수를 담은 오류로 거부한다. [logging](logging.ko.md#class와-정책)에서 class `frame`인 휠과 포인터 이동은 sidecar가 적용하기 전 page의 event이고, 적용된 변경에 대해 sidecar가 저장하는 입력은 class `input`이다. 재생 실행 파일은 모르는 종류의 `sequence`를 가진 session의 event를 거부하며 무시하지 않는다. 재생 명령은 실행 파일을 시작하기 전에 session의 입력에 `replaySessionProblem`을 실행한다.

`@soksak/log-contract`의 `replayInputProblem(kind, fields)`와 `replaySessionProblem(inputs)`가 이 형식과 session의 규칙(theme이 처음, 빈틈 없는 순번, 시작 뒤에만 update나 end)을 검사하고, `packages/log-contract/fixtures/replay/inputs.json`이 sidecar를 위한 골든 사례를 가진다.

### 결정

선택, viewport, theme이 hash에 들어가는 방법으로 세 후보를 검토했다. 정의된 event를 가진 재생 입력(채택), hash에서 제외, frame 기록의 상태 field다.

- *제외.* hash가 강조 없고 theme과 무관한 색을 가진 가장 아래의 화면을 덮는다. 반론: 아무도 보지 않는 화면을 검증하고 강조, 스크롤백, 색에서 page의 결함이 어긋남을 만들 수 없다. 엔진이 만드는 칸의 색은 이미 theme을 거쳐 정해져 있고 빈 칸을 줄이는 일도 theme에 달려 있어, 새로운 미해결 색 경로 없이는 theme과 무관한 형태가 없다. 가장 아래의 둘째 화면은 보기가 스크롤된 동안 모든 frame의 일을 두 배로 한다. page는 스크롤된 화면을 받아 칸에 들어 있는 offset이나 강조를 뺄 수 없으므로 그린 것을 hash할 수 없다. 닫는 조건(스크롤과 선택이 있는 session의 재생이 그려진 hash와 같다)은 구성상 참이 된다. 후보 안의 어떤 해법도 이 반론에 답하지 못하므로 거부한다.
- *frame 기록의 상태.* 재생이 검증하는 frame 기록에서 offset, 선택, theme을 가져와 설정한다. 반론: 바로 이 상태들에서 검사가 순환한다(틀린 offset이나 지워지지 않은 선택은 기록되고 그대로 재생된다). frame 기록마다 palette를 포함한 완전한 theme은 집계하는 class `frame`의 frame 속도에서 2킬로바이트가 넘고, theme의 식별은 사람이 정의한 theme을 재생하지 못한다. 엔진에는 절대 offset이나 선택 범위의 setter가 없어 재생이 제품이 실행하지 않는 경로를 필요로 한다. 선택 범위는 모든 선택 종류에 대해 정해지지 않는다. 그 답(원인의 순간에 입력으로 둔 상태)이 채택한 후보이므로 거부한다.
- *입력(채택).* 반론과 답은 모두 위의 규칙에 있다. 엔진이 시작하는 theme과 스크롤백 한도(첫 입력은 theme이고, 한도는 재생 실행 파일에 속하며 재생은 sidecar 버전에 대해 정의된다), 픽셀 척도에 달린 선택의 기하(입력은 정해진 칸 경계와 viewport 행을 적용 순서로 저장한다), 키에서 가장 새 출력으로 스크롤하는 것처럼 입력에 대한 sidecar의 반응(호출한 순간의 viewport 입력이므로 재생에 키 규칙이 필요 없다), 출력과의 순서(적용 순서의 하나의 `sequence`), 휠과 포인터의 속도(class `input`, 완전하게, 적용된 휠 event나 포인터 이동마다 입력 하나 또는 그 유효한 합의 입력 하나), viewport, 깜박임, focus에 달린 커서(위의 커서 규칙), `input`을 끌 수 있는 class 정책(재생이 처음 빠진 `sequence`에서 session을 거부하며 이는 빈틈 규칙이다), page가 다시 만들 수 없는 화면(화면 메시지가 hash되는 칸을 담는다), 모르는 event를 무시하던 재생 실행 파일(거부한다). 검토는 반론이 남지 않을 때까지 반복했다.

스크롤, 선택, 다른 theme에서 그려진 화면을 고정하는 골든 벡터는 `scrolled viewport with the cursor outside it`, `selected cells with the highlight colors`, `the same text under another theme`이다.

## 재생 실행 파일

화면을 만드는 sidecar는 `sidecar.json`에 `replay`를 선언한다([sidecars](sidecars.ko.md#선언과-시작)). 형식은 `{"role": <role>, "executable": <sidecar 안의 경로>}`다. `role`은 sidecar의 event 파일(`logs/<role>-<boot>.jsonl`)의 role이며, 그 파일의 `log.open`이 밝힌다. 실행 파일은 sidecar의 재생 엔진이다. 터미널 엔진은 거기에 있으므로 명령줄 도구는 어느 것도 이름으로 부르지 않는다.

도구는 sidecar 폴더에서 실행 파일을 인자 없이 시작하고, 표준 입력에 role의 파일에 있는 session의 층 `sidecar` event를 [질의](logging.ko.md#질의)의 순서(시각, process, `seq`)대로, 바꾸지 않고, 각각 줄바꿈으로 끝나게, `--until`이 준 `sequence`까지 쓴다. 실행 파일은 재생 입력을 `sequence` 순서로 빈 화면에 적용하고, 읽은 frame 기록마다 그 순번의 화면 hash를 담은 한 줄 `{"sequence": <n>, "hash": <hash>}`을 표준 출력에 쓴다. 입력이 끝나면 종료 상태 0으로 끝난다. 다른 종료 상태, 그 객체가 아닌 줄, 소문자 16진 64자가 아닌 hash, 줄을 받지 못한 frame 기록은 재생의 실패이며 실행 파일의 오류 글과 함께 보고한다.

## 명령

`sok debug replay <session> [--until <sequence>] [--config-dir <directory>]`([명령줄](cli.ko.md#명령))는 설정 폴더의 event 파일에서 [질의](logging.ko.md#질의)로 session의 event를 읽고, session의 sidecar event의 role을 `replay.role`로 선언한 설치된 sidecar를 찾아 그 재생 실행 파일을 실행한 뒤, `sequence` 순서로, 같은 순번에서는 sidecar 기록을 page 기록보다 먼저 비교한다.

1. sidecar의 frame 기록마다 그 순번의 재생 hash와 비교한다. 다르면 층 `sidecar`의 불일치다.
2. page의 frame 기록마다 그 순번의 재생 hash와 비교한다. 다르거나 그 순번에 sidecar의 frame 기록이 없으면 층 `page`의 불일치다.

첫 불일치에서 비교를 끝낸다. 도구는 `session`, `sequence`, `layer`, `expected`(재생 hash, sidecar의 frame 기록이 없는 page frame이면 `none`), `found`(저장된 hash)를 가진 event `sok.replay.divergence`(수준 `error`)를 저장하고, 표준 오류에 `sok: replay divergence: session <session> sequence <n> layer <layer> expected <expected> found <found>`를 쓰며 종료 상태 1로 끝난다. 모든 hash가 같으면 표준 출력에 `replay session <session>: <n> sidecar frames and <m> page frames equal`을 쓰고 상태 0으로 끝난다. 층 `sidecar` event가 없는 session, frame 기록이 없는 session, 둘 이상의 role의 sidecar event를 가진 session, 그 role을 선언한 설치된 sidecar가 없는 경우는 session과 role을 이름으로 가진 오류다. 1 이상의 정수 `fields.sequence`와 문자열 `fields.hash`가 없는 frame 기록, 소문자 16진 64자가 아닌 저장된 hash, 실패하거나 `{"sequence", "hash"}`가 아닌 줄을 출력하는 실행 파일, 실행 파일이 hash를 출력하지 않은 sidecar의 frame 기록은 불일치가 아니라 오류다. 도구는 session의 event를 메모리에 보관한다. 두 도구는 같은 출력과 같은 오류 글을 낸다.
