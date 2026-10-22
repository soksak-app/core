# 디버그 화면

[English](debug.md)

디버그 화면은 결함을 만난 사람이 애플리케이션의 모든 진단 기록을 넘겨줄 수 있게 한다. 애플리케이션의 모든 진단 파일은 `<config-dir>/logs/`에 있다([진단](diagnostics.ko.md), [hosts](hosts.ko.md#애플리케이션-로그)). 디버그 화면은 현재 상태를 그 폴더에 기록하고, 그 파일들을 나열하며, 파일 하나나 전부를 그 사람이 고른 곳에 저장한다.

## 열기

두 host의 도움말 메뉴에 디버그(Debug)가 있다([host contract](host-contract.ko.md#애플리케이션-메뉴)). 디버그는 애플리케이션 main 창의 메인 page에서 `core.debug.open`을 실행한다. 보기 메뉴의 글자 크기 항목과 같은 창이다([글자 크기](text-size.ko.md)). 화면은 × 버튼(`core.debug.close`)으로 닫는 `dialog` [native modal](native-modals.ko.md)이다. 화면을 열면 설정 modal이 닫히고, 설정 modal을 열면 화면이 닫힌다. 애플리케이션 host가 없는 page에는 디버그 화면이 없고, 거기서 `core.debug.open`은 오류로 실패한다.

열기는 상태를 기록한 뒤 파일을 나열한다.

1. page는 registry가 제공하는 모든 status, 곧 core status와 모든 표면의 status 값을 이름과 표면별로 모아 host 호출 `debugRecord({page})`로 보낸다. 읽기에 실패한 status는 그 오류와 함께 기록한다.
2. host는 `logs/state-<time>.json`에 `{time, host, versions, windows, page}`를 쓴다. `host`는 `wailsv3`나 `tauriv2`다. `versions`는 core version, macOS version, `plugins/installed.json`의 내용을 담는다. `windows`는 창마다 `windows.list` 항목, `host.window`, `host.sidecars`, `host.screens`를 담는다. `page`는 page가 보낸 값이다. `<time>`은 UTC 시각 `YYYYMMDDTHHMMSSZ`다.
   host는 파일을 쓴 뒤 가장 새 20개를 넘는 가장 오래된 `logs/state-<time>.json` 파일을 지우므로, 폴더는 한계 있는 수만 가진다.
3. 진단 빌드에서 host는 각 창의 정지 캡처를 `logs/captures/`에 쓴다.
4. host 호출은 `<config-dir>`에 대한 상태 파일의 상대 경로 `{path}`로 답한다.

한 단계가 실패하면 그 실패를 화면의 오류 표시로 보이고, 다른 단계는 계속 실행한다.

## 파일

host 호출 `debugFiles()`는 `<config-dir>/logs/` 아래 모든 파일을 `path` 순으로 `[{path, size, modified}]`로 답한다. `path`는 `<config-dir>`에 대한 상대 경로, `size`는 byte, `modified`는 epoch 이후 millisecond의 수정 시각이다. 화면은 파일마다 크기, 시각, 저장 버튼을 가장 새 파일부터(`modified`, 같으면 `path`순으로) 보이고, 목록 위에 모두 저장을 둔다.

- `core.debug.save {path}`는 host 호출 `debugSave({path})`를 실행한다. host는 파일 이름으로 macOS 저장 창을 보이고 고른 곳에 파일을 복사한다. 고른 경로 `{saved}`로, 취소하면 `{saved: null}`로 답한다. `logs/` 밖이거나 파일이 없는 `path`는 그 경로를 밝히는 오류로 거부한다.
- `core.debug.save-all`은 host 호출 `debugSaveAll()`을 실행한다. host는 이름 `soksak-<host>-debug-<time>.tar.gz`로 저장 창을 보인다. 사람이 위치를 고르면 곧바로 `{saved, total}`(`total`은 나열한 파일의 byte)로 답하고, `<config-dir>/logs/`를 gzip으로 압축한 tar 파일을 자기 thread에서 쓴다. 그래서 page와 그 다시 읽기가 쓰기를 기다리지 않는다. 취소한 창은 `{saved: null}`로 답한다. 쓰는 동안 host는 요청한 window에 나열한 byte를 1 MiB 이상 더 쓸 때마다, 그리고 마지막 파일 뒤에 한 번 event `debug-save-progress` `{saved, written, total}`을 보내고, 이어서 event `debug-save-done` `{saved, error}`를 보낸다. `error`는 `null`이거나 실패의 글이다. 쓰는 중의 `debugSaveAll`은 오류 `debug: a save of the logs folder is running: <path>`로 거부한다. 작업이 실행되는 동안 화면은 `total` 중 `written`의 진행 막대를 보이고, 모두 저장 버튼을 비활성으로 보이며, `core.debug.save-all`을 그 오류로 거부한다. `debug-save-done`이 보고하는 실패는 오류 표시 경로로 보인다.
- host 호출 `debugSaveText({name, text})`는 page가 만든 글(예: 타임라인에서 고른 행)을 저장한다. host는 파일 이름이 아닌 `name`(빈 이름, `.`, `..`, `/`나 `\`를 가진 이름)과 비었거나 16 MiB를 넘는 `text`를 무엇을 찾았는지 밝히는 오류로 거절하고, `name`으로 저장 창을 보여 고른 곳에 글을 쓰며, `debugSave`처럼 `{saved}`로 답한다.
- <a id="following"></a>host는 event 파일의 색인이 log의 변경을 알리는 줄을 덮은 뒤 알림을 발행한다. 모든 창에는 host event `debug-log-changed {path, size, notices, coalesced}`로, endpoint의 host 상태 `host.log`([노출](exposure.ko.md#호스트-항목))의 감시자에게는 같은 멤버를 가진 그 값으로 알린다. `path`는 파일(`logs/<name>`), `size`는 바이트 크기, `notices`는 시작 이후 발행한 알림의 수, `coalesced`는 자기 알림을 받지 못하고 뒤의 알림에 합쳐진 알림의 수다. 알림의 source는 색인의 갱신이다. writer의 쓰기가 깨우는 thread와, 색인을 최신으로 만드는 모든 질의가 그것이다(host의 어떤 writer도 쓰지 않은 파일, 곧 sidecar의 파일의 줄은 질의가 색인할 때 알려진다). 발행에는 상한이 있다. 알림은 250 ms에 하나까지이고, 알림을 발행하는 동안이나 250 ms가 지나는 동안 온 알림은 마지막 경로와 크기를 가진 알림 하나가 되어 `coalesced`에 세어진다. 이 기다림이 timer인 까닭은 어떤 비율로도 자랄 수 있는 log의 알림 간격을 정하는 event source가 없기 때문이다. log만 읽는 호출의 기록(`logQuery`의 `host.binding.call`과 `log.query`의 `host.endpoint.call`)을 뺀 모든 줄이 변경을 알린다. 화면은 `logQuery`를 요청해 따라가고, host는 각 호출을 발생으로 기록하며(저장되고 색인되고 모든 질의에 찾히며 버려지지 않는다), 그 기록의 알림은 다시 요청을 끝없이 부르기 때문이다. 읽기의 기록은 다른 줄이 일으키는 다음 알림이 보인다. page도 자기 `logQuery`의 `page.call`을 저장하지 않는다. 파일을 따라가는 화면은 `logQuery`로 늘어난 행을 요청하고([타임라인](#타임라인)), endpoint의 client는 `host.log`를 감시하다가 알림 뒤 `since`를 담은 `log.query`를 요청한다.

## 보기

이미지를 보면 native modal은 불러온 이미지를 담은 card의 높이를 가진다. 이미지는 불러오기 전에는 높이가 없으므로, 화면은 이미지가 load를 알릴 때 modal을 다시 배치한다.

모든 파일은 모든 행의 같은 칸에 보기 단추와 저장 단추를 가진다. `core.debug.view {path}`는 host 호출 `debugRead({path})`를 실행하고, 이 호출은 글 파일에는 `{path, size, truncated, kind, text}`로, PNG 파일에는 `{path, size, truncated, kind, image}`로 답한다. `kind`는 `text`나 `image`다. 글 파일의 `text`는 파일의 내용이고, 파일이 더 크면 마지막 262144 byte(문자 경계에서 시작)이며 이때 `truncated`는 true다. PNG 파일의 `image`는 파일 전체의 `data:image/png;base64,` 주소이고 `truncated`는 false다. `logs/` 밖이거나 파일이 아니거나 16 MB보다 큰 PNG 파일이거나 이름이 `.png`인데 PNG signature로 시작하지 않거나 내용이 UTF-8 글이 아닌 다른 파일인 `path`는 그 경로를 밝히는 오류로 거부하고, 화면은 그 오류를 보인다. 화면은 글이나 이미지를 경로와 크기와 함께 보이고, `truncated`가 true이면 `앞부분 생략`을 밝히며, `core.debug.list`를 실행해 목록을 다시 보이는 목록 단추를 둔다. 글은 쓰인 순서(오래된 줄이 먼저)를 유지하고, 화면은 가장 새 줄이 있는 글의 끝으로 스크롤한 채 열린다.

## 타임라인

목록 위의 타임라인 단추는 `core.debug.timeline`을 실행하며, `logs/`의 event 파일의 event를 행의 목록 하나로 보인다. 화면은 event 파일을 읽지 않는다. host 호출 `logQuery(request)`([logging](logging.ko.md#질의))로 host에 page 하나를 요청하고, 그 요청과 답은 endpoint 메서드 `log.query`([endpoint](endpoint.ko.md#log-query))와 같으며, 답의 cursor로 파일을 page 단위로 넘긴다. page는 파일 전체를 불러오거나 그리지 않으며 event 1,000,000개의 로그도 page 하나로 열린다.

- 타임라인은 가장 새로운 page로 열린다: 아래 filter를 담은 질의 `{channel, order: "desc", limit: PAGE_ROWS}`이며 `PAGE_ROWS`는 500이다. page의 행은 행의 key(`ts_us`, `role`, `boot`, `seq`) 순서대로 오래된 것부터 보이고, 화면은 가장 새로운 행이 있는 끝으로 스크롤한 채 열린다. 이전 행 단추는 `core.debug.timeline.older`를 실행하며, 가장 오래된 보이는 행 앞의 page(`after`는 앞선 답의 `next`)를 요청해 그 행을 보이는 행 앞에 놓는다. 더 오래된 행이 없으면 단추는 숨는다. 화면은 행을 최대 `HOLD_LIMIT`(2000)개 담는다. 그 개수에서 `core.debug.timeline.older`는 오류 `the timeline holds 2000 rows; narrow the filter or the time`로 거절되며 화면에 보인다.
- 행 하나는 글 한 줄이다: 마이크로초까지의 UTC 시각, `level`, `layer`, `event`, 있으면 `window=`, `surface=`, `session=`, `cids=`, 그리고 각 field를 `name=<JSON 값>`으로. event 구조를 어기는 파일은 파일과 줄을 밝히는 오류로 질의를 실패시키고, 화면은 그 오류를 보이며 나머지의 행은 보이지 않는다.
- `core.debug.timeline.filter {channel, level, class, layer, text, event, event_prefix, surface, session, cid, run, from, to}`는 filter를 정하고 가장 새로운 page를 다시 요청한다. 주지 않은 항목은 값을 유지하고 하나는 필요하다. `channel`은 `other`, `debug`, `all`이고, `level`, `class`, `layer`, `text`, `event`, `event_prefix`, `surface`, `session`, `cid`, `run`은 질의의 같은 이름의 매개변수이며 빈 글은 항목을 열어 둔다. `layer`는 `all`이나 layer 하나다. `from`과 `to`는 `2026-10-08T22:53:20.123456Z` 같은 양 끝 포함 UTC 시각이거나 빈 글이다. 새 타임라인은 `other`, `trace`, `all`과 다른 항목 없음으로 시작한다. 화면에는 channel 선택 상자, level 선택 상자, layer 선택 상자와 나머지마다 글 칸이 있고 각각 이 명령을 가리키며, `core.debug.list`를 실행하는 목록 단추가 있다. 질의가 거절하는 값은 질의의 오류 문구([logging](logging.ko.md#질의))로 보이고 보이던 행은 그대로 있다.
- 각 행 앞에 단추가 둘 있다. `core.debug.timeline.context {row}`는 위치 `row`(`select`처럼 센다)의 행 둘레의 행을 담은 행에 들인다: 화면은 filter의 channel에서 filter의 다른 항목 없이 그 앞의 `CONTEXT_ROWS`(5)개 행과 뒤의 5개 행을 `logQuery`로 요청하고, 담고 있지 않던 행은 줄 앞에 공백 둘을 붙이고 속성 `data-context`를 true로 하여 context로 보인다. 나중에 따라가기나 더 오래된 행으로 filter의 page가 가져오는 행은 그때부터 filter의 행이며 들여쓰기를 잃는다. 새 filter나 새 타임라인은 자기 page의 행만 보인다. 상태는 context일 뿐인 행을 `context`로 센다. `core.debug.timeline.select {row, selected}`는 호출 시점에 화면이 담은 행 중 위의 순서로 0부터 센 위치 `row`의 행을 선택(`selected` true)하거나 선택 해제(false)한다. 행이 아닌 `row`와 boolean이 아닌 `selected`는 찾은 값을 밝히는 오류로 거절하며, 같은 호출을 되풀이해도 바뀌는 것이 없다. 선택은 프로세스와 `seq`가 식별하는 행에 속한다: filter가 바뀔 때, 더 오래된 행이 앞에 들어올 때, 따라가기가 행을 덜어 낼 때 유지되고, 타임라인을 다시 보이면 끝난다.
- <a id="timeline-following"></a>타임라인은 보이는 동안 event 파일을 따라간다. 첫 page의 답은 프로세스마다 가장 큰 `seq`인 `tail`을 담는다. `debug-log-changed`가 `logs/`의 파일을 알리고 타임라인이 따라가는 중이면, 화면은 그 위치 뒤의 행(`since`는 `tail`, `order`는 `asc`)을 `next`가 `null`이 될 때까지 page 단위로 요청하고, 담지 않은 행을 위의 순서로 더하며, 마지막 답의 `tail`을 유지한다. filter와 선택은 유지되고, 상태는 타임라인이 보인 뒤 더해진 행 수(`appended`)를 센다. 담은 행이 `HOLD_LIMIT`을 넘게 되면 가장 오래된 행이 화면을 떠나 `omitted`에 세어지고, 참고 글 `core.debug.timeline.omitted`(`앞쪽 <n>행은 보관하지 않음`)가 그 수를 밝히며 0이면 숨고, `older`는 true다. 읽는 동안 도착한 알림은 읽기가 끝나기를 기다리므로 행은 한 번만 읽힌다. event 파일이 아닌 파일의 알림은 무시한다. `core.debug.timeline.follow {on}`은 따라가기를 멈추거나(`on` false) 다시 시작한다(`on` true). 다시 시작하면 먼저 멈춘 동안 늘어난 것을 읽고, 멈춘 뒤 끝나는 읽기는 버리며, 같은 호출을 되풀이해도 바뀌는 것이 없다. 실패한 읽기는 따라가기를 멈추고 화면이 오류를 보인다. 화면에는 현재 상태의 반대로 `core.debug.timeline.follow`를 실행하는 단추가 있다. 화면에는 자기 timer가 없다. host가 알림의 비율을 제한하고([따라가기](#파일)), 각 알림에는 `tail`부터 바로 질의로 답하므로 행을 잃지 않는다. 행을 더하지 않은 질의는 그리지 않는다. 그리기는 host가 기록하는 host 호출을 만들기 때문이다. page는 `logQuery`의 `page.call`을 저장하지 않고, host는 그 `host.binding.call`을 저장하며 이 기록은 log의 변경을 알리지 않는다.
- `core.debug.timeline.save`는 선택한 행의 글 줄을 타임라인 순서로, 한 줄씩(화면이 보이는 event의 줄이며 context 행의 들여쓰기는 없고 각 줄은 줄바꿈으로 끝난다) `name` `soksak-timeline-<time>.txt`(`<time>`은 UTC 시각 `YYYYMMDDTHHMMSSZ`)와 함께 host 호출 `debugSaveText({name, text})`로 저장한다. `core.debug.save`처럼 `{saved}`로 답하며 `{saved: null}`은 취소된 저장 창이지 오류가 아니다. 행이 없는 선택은 오류 `no timeline row is selected`로 거절하고 화면에 보인다. 화면은 선택한 행 저장 단추와 그 곁의 경고 `저장한 파일에는 입력한 글자가 들어 있을 수 있다.`([logging](logging.ko.md#개인정보))를 보이며 상태도 같은 글을 보고한다.

<a id="timeline-command"></a>`sok debug query`는 화면과 같은 행, 순서, filter, 글 줄로 page 하나의 행을 command line에 출력한다([command line](cli.ko.md#명령)). `--config-dir`이나 application이 가리키는 설정 디렉터리의 파일에 자기 언어의 질의 구현을 실행하며 application에 연결하지 않는다. flag는 `--channel`, `--level`, `--class`, `--layer`, `--event`, `--event-prefix`, `--surface`, `--session`, `--cid`, `--run`, `--text`, `--from`, `--to`(filter와 같은 UTC 시각), `--order`, `--limit`, `--after`(`<ts_us>/<role>/<boot>/<seq>` 형식의 cursor), `--around`(같은 형식의 cursor)와 `--earlier`, `--later`([행 둘레의 행](logging.ko.md#질의). context일 뿐인 행은 공백 둘로 들여 쓰며, `--around`는 `--channel` 외의 filter flag를 받지 않는다)이고, 값과 오류는 질의의 매개변수와 같다. 잘못된 값은 질의의 오류 문구로 flag 값을 밝히는 사용법 오류다. 출력은 행마다 글 줄 하나이며 각 줄은 줄바꿈으로 끝난다. page 뒤에 행이 더 있으면 명령은 표준 오류에 `more: --after <cursor>`를 쓴다. `logs/` 폴더가 없으면 폴더를 밝히는 오류로, 파일이 event 구조를 어기면 파일과 줄을 밝히는 오류로 실패한다. 명령은 JSON을 쓰지 않는다. 그 줄이 화면이 보이고 저장하는 형식이기 때문이다. 두 `sok` 구현은 같은 파일에 같은 줄을 출력한다. golden 파일 `docs/spec/cases/log-contract/query`가 파일, 매개변수, flag, 기대하는 page와 줄을 담으며 debug 화면, Go의 `sok`, Rust의 `sok`가 이를 실행한다.


## 상태 파일

목록은 `logs/`의 모든 파일을 보이며 프로세스의 원본 `.stderr`와 `.crash` 파일([logging](logging.ko.md#파일))도 포함한다. `core.debug.view`는 이 파일의 글을 다른 글 파일처럼 보인다. 상태 파일 `logs/state-<time>.json`에는 상태 단추도 있어 `core.debug.state {path}`를 실행하고, 이 명령은 파일을 `debugRead`로 읽어 트리로 보인다. 목록에 있는 상태 파일이 아닌 `path`는 그 경로를 밝히는 오류로 거부한다.

- 상태 파일은 문자열 `time`, `wailsv3`나 `tauriv2`인 `host`, 객체 `versions`와 `page`, 배열 `windows`를 가진 JSON 객체여야 한다. 이를 어기거나, 글이 읽기 한계에서 잘렸거나, 글이 아닌 파일은 파일과 찾은 값을 밝히는 오류로 거부하고, 화면은 그 오류를 보인다.
- 트리는 파일 순서의 key마다 한 줄이고 깊이만큼 들여 쓴다: 값은 `key: <JSON 값>`, 원소가 `n`개인 객체나 배열은 `key {n}`이나 `key [n]`, 빈 객체나 배열은 `key: {}`나 `key: []`.
- `core.debug.state.compare {with}`는 보이는 상태 파일을 목록의 다른 상태 파일과 비교하고, 값이 다른 경로마다 `path: <보이는 파일의 값> -> <다른 파일의 값>`을 트리 위에 나열한다. 경로는 맨 위부터의 key를 `.`로 이은 것이며, 배열 원소는 `[index]`, 식별자가 아닌 key는 `["key"]`로 쓴다. 한 파일에만 있는 경로는 다른 파일 쪽에 `(없음)`을 보인다. 차이는 보이는 파일의 경로를 파일 순서로, 그다음 다른 파일에만 있는 경로 순이다. 빈 `with`는 비교를 끝내고, 목록의 다른 상태 파일이 아닌 `with`는 그 경로를 밝히는 오류로 거부한다. 화면은 다른 상태 파일의 선택 상자를 두고 이 명령을 가리키며, `core.debug.list`를 실행하는 목록 단추를 둔다.

## Status

`core.debug`는 `{open, recorded, entries, viewing, timeline, state, scroll, operation, error}`를 보고한다: 화면이 열렸는지, 열기가 쓴 상태 파일의 경로나 `null`, 목록의 순서대로 나열된 항목 `{path, size, modified}`, 보이는 파일 `{path, size, truncated, kind, length}`(`length`는 보이는 글의 문자 수이며 이미지는 0)나 `null`, 보이는 타임라인 `{following, appended, held, older, omitted, context, selected, warning, channel, level, class, layer, text, event, event_prefix, surface, session, cid, run, from, to}`(따라가는지, 타임라인을 보인 뒤 더해진 행 수, 담아서 그리는 행 수, 더 오래된 행이 있는지, 따라가기가 덜어 낸 가장 오래된 행 수, context일 뿐인 행 수, 선택한 행 수, 저장의 경고, 필터)나 `null`, 보이는 상태 파일 `{path, lines, with, differences}`(트리 줄 수, 비교하는 상태 파일이나 `null`, 차이 수)나 `null`, 보이는 내용의 스크롤 위치(point, 내용이 시작을 지나 당겨진 동안은 native modal이 보고한 대로 음수이고 숫자가 아닌 값은 거부한다), 실행 중이거나 마지막 작업 `{action, path, state}`(`action`은 `save`, `save-all`, `save-rows`, `path`는 저장한 파일(`save-rows`는 글 파일의 이름)이나 `null`, `state`는 `running`, `done`, `failed`), 마지막 실패한 단계나 작업의 오류나 `null`. 화면이 열려 있는 동안 `core.screen`은 `modal` `debug`를 보고한다.
