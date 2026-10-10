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
- `core.debug.save-all`은 host 호출 `debugSaveAll()`을 실행한다. host는 이름 `soksak-<host>-debug-<time>.tar.gz`로 저장 창을 보이고 `<config-dir>/logs/`를 gzip으로 압축한 tar 파일로 쓴다. `debugSave`처럼 답한다.
- host 호출 `debugSaveText({name, text})`는 page가 만든 글(예: 타임라인에서 고른 행)을 저장한다. host는 파일 이름이 아닌 `name`(빈 이름, `.`, `..`, `/`나 `\`를 가진 이름)과 비었거나 16 MiB를 넘는 `text`를 무엇을 찾았는지 밝히는 오류로 거절하고, `name`으로 저장 창을 보여 고른 곳에 글을 쓰며, `debugSave`처럼 `{saved}`로 답한다.
- host 호출 `debugReadRange({path, offset})`는 `logs/` 아래의 텍스트 파일 `path`를 바이트 `offset`부터 읽는다. offset 뒤의 온전한 줄(최대 262144바이트)과 그 뒤의 offset을 `{path, size, next, text}`로 답한다. 끝까지 쓰이지 않은 줄은 그 끝이 쓰일 때까지 기다리므로 `next`를 가진 읽는 쪽은 한도를 넘는 파일을 이어 읽고 늘어나는 파일을 따라간다. 파일 밖의 offset, 글자 안의 offset, 텍스트가 아닌 파일은 파일을 밝히는 오류다.
- <a id="following"></a>host는 event 기록기가 자기 파일에 한 묶음을 쓴 뒤 모든 창에 host event `debug-log-changed {path, size}`를 알린다. 창에 알리는 동안 오는 쓰기 알림은 마지막 크기를 가진 알림 하나가 된다. 파일을 따라가는 화면은 자기 `next`부터 `debugReadRange`로 늘어난 줄을 읽는다.

## 보기

모든 파일은 모든 행의 같은 칸에 보기 단추와 저장 단추를 가진다. `core.debug.view {path}`는 host 호출 `debugRead({path})`를 실행하고, 이 호출은 글 파일에는 `{path, size, truncated, kind, text}`로, PNG 파일에는 `{path, size, truncated, kind, image}`로 답한다. `kind`는 `text`나 `image`다. 글 파일의 `text`는 파일의 내용이고, 파일이 더 크면 마지막 262144 byte(문자 경계에서 시작)이며 이때 `truncated`는 true다. PNG 파일의 `image`는 파일 전체의 `data:image/png;base64,` 주소이고 `truncated`는 false다. `logs/` 밖이거나 파일이 아니거나 16 MB보다 큰 PNG 파일이거나 이름이 `.png`인데 PNG signature로 시작하지 않거나 내용이 UTF-8 글이 아닌 다른 파일인 `path`는 그 경로를 밝히는 오류로 거부하고, 화면은 그 오류를 보인다. 화면은 글이나 이미지를 경로와 크기와 함께 보이고, `truncated`가 true이면 `앞부분 생략`을 밝히며, `core.debug.list`를 실행해 목록을 다시 보이는 목록 단추를 둔다. 글은 쓰인 순서(오래된 줄이 먼저)를 유지하고, 화면은 가장 새 줄이 있는 글의 끝으로 스크롤한 채 열린다.

## 타임라인

목록 위의 타임라인 단추는 `core.debug.timeline`을 실행한다. 이 명령은 host 프로세스의 event 파일(`logs/host-<boot>.jsonl`, [logging](logging.ko.md#파일). 회전된 세대 `.1`부터 `.5`는 읽지 않는다)을 `debugRead`로 읽고 그 event를 행 하나의 목록으로 보인다. 폴더에 그런 파일이 없으면 오류로 실패한다.

- 파일은 [logging](logging.ko.md#event)의 event 구조를 따라야 한다: 모든 줄은 정수 `ts_us`와 `seq`, 계약이 선언한 `level`과 `layer`, 문자열 `event`를 가진 JSON 객체이고, `fields`가 있으면 객체다. 첫 줄은 reader가 아는 schema 번호의 `log.open`이다. 이를 어긴 파일은 파일, 줄, 찾은 값을 밝히는 오류로 거부하고, 화면은 그 오류를 보인다. 파일의 글이 잘렸으면(`truncated`가 true) 첫 줄이 일부뿐이므로, reader는 그 줄을 건너뛰고 `log.open`을 요구하지 않으며 화면은 `앞부분 생략`을 밝힌다.
- 모든 파일의 행은 `ts_us`, `seq`, 파일 경로 순으로 정렬한다. 행 하나는 글 한 줄이다: 마이크로초까지의 UTC 시각, `level`, `layer`, `event`, 있으면 `window=`, `surface=`, `session=`, `cids=`, 그리고 field마다 `name=<JSON 값>`.
- `core.debug.timeline.filter {level, layer, text, event, surface, session, cid, from, to, context}`가 필터를 정한다. 주지 않은 member는 값을 유지하고 하나 이상은 필요하다. `level`은 보이는 가장 낮은 수준(`error`, `warn`, `info`, `debug`, `trace`이며 그 수준이나 더 심각한 행이 통과한다), `layer`는 `all`이나 layer, `text`는 행의 글 한 줄에 대한 대소문자 무시 부분 문자열이다. `event`는 event 이름에 대한 대소문자 무시 부분 문자열, `surface`와 `session`은 식별자 전체, `cid`는 행의 `cids` 중 하나, `from`과 `to`는 초와 최대 6자리 소수를 가진 경계 포함 UTC 시각(`2026-10-08T22:53:20.123456Z`)이다. 빈 글은 `text`, `event`, `surface`, `session`, `cid`, `from`, `to`를 열어 둔다. 행은 모든 member를 통과해야 통과한다. `context`는 10진 숫자(최대 4자리)이며, 통과한 각 행 앞뒤의 합친 타임라인 행도 한 번씩 타임라인 순서로 보이고 `data-context`와 흐린 색으로 표시한다. 다른 종류의 값, 달력에 없는 UTC 시각, `to`보다 늦은 `from`, 없는 member는 member와 찾은 값을 밝힌 오류로 거부한다. 새 타임라인은 `trace`, `all`, 빈 글, `0`으로 시작한다. 화면은 level, layer, context 선택 상자와 나머지 member마다 글 입력 칸을 두고 각각 이 명령을 가리키며, `core.debug.list`를 실행하는 목록 단추를 둔다.
- 화면은 가장 새 행이 있는 끝으로 스크롤한 채 열리고, 필터가 바뀌어도 스크롤 위치를 유지한다.
- 각 행 앞에 단추가 있다. `core.debug.timeline.select {row, selected}`는 필터가 무엇을 보이든, 위의 시간 순서로 타임라인의 모든 행 중 0부터 센 위치 `row`의 행을 선택하거나(`selected`가 true) 선택을 해제한다(false). 행이 아닌 `row`와 boolean이 아닌 `selected`는 찾은 값을 밝히는 오류로 거부하고, 같은 호출을 다시 해도 아무것도 바뀌지 않는다. 선택은 필터가 바뀌어도 유지되고 타임라인을 다시 읽으면 끝난다.
- `core.debug.timeline.save`는 선택한 행의 글 줄을 타임라인 순서로, 한 줄씩(화면이 보이는 줄과 같고 각 줄은 줄바꿈으로 끝난다) `name` `soksak-timeline-<time>.txt`(`<time>`은 UTC 시각 `YYYYMMDDTHHMMSSZ`)와 함께 host 호출 `debugSaveText({name, text})`로 보낸다. `core.debug.save`처럼 `{saved}`로 답하며 `{saved: null}`은 저장 창을 취소한 것이지 오류가 아니다. 행이 없는 선택은 오류 `no timeline row is selected`로 거부하고 화면이 그 오류를 보인다. 화면은 선택한 행 저장 단추 옆에 경고 `저장한 파일에는 입력한 글자가 들어 있을 수 있다.`를 보이고([logging](logging.ko.md#개인정보)), 상태가 같은 글을 보고한다.

## 상태 파일

목록은 `logs/`의 모든 파일을 보이며 프로세스의 원본 `.stderr`와 `.crash` 파일([logging](logging.ko.md#파일))도 포함한다. `core.debug.view`는 이 파일의 글을 다른 글 파일처럼 보인다. 상태 파일 `logs/state-<time>.json`에는 상태 단추도 있어 `core.debug.state {path}`를 실행하고, 이 명령은 파일을 `debugRead`로 읽어 트리로 보인다. 목록에 있는 상태 파일이 아닌 `path`는 그 경로를 밝히는 오류로 거부한다.

- 상태 파일은 문자열 `time`, `wailsv3`나 `tauriv2`인 `host`, 객체 `versions`와 `page`, 배열 `windows`를 가진 JSON 객체여야 한다. 이를 어기거나, 글이 읽기 한계에서 잘렸거나, 글이 아닌 파일은 파일과 찾은 값을 밝히는 오류로 거부하고, 화면은 그 오류를 보인다.
- 트리는 파일 순서의 key마다 한 줄이고 깊이만큼 들여 쓴다: 값은 `key: <JSON 값>`, 원소가 `n`개인 객체나 배열은 `key {n}`이나 `key [n]`, 빈 객체나 배열은 `key: {}`나 `key: []`.
- `core.debug.state.compare {with}`는 보이는 상태 파일을 목록의 다른 상태 파일과 비교하고, 값이 다른 경로마다 `path: <보이는 파일의 값> -> <다른 파일의 값>`을 트리 위에 나열한다. 경로는 맨 위부터의 key를 `.`로 이은 것이며, 배열 원소는 `[index]`, 식별자가 아닌 key는 `["key"]`로 쓴다. 한 파일에만 있는 경로는 다른 파일 쪽에 `(없음)`을 보인다. 차이는 보이는 파일의 경로를 파일 순서로, 그다음 다른 파일에만 있는 경로 순이다. 빈 `with`는 비교를 끝내고, 목록의 다른 상태 파일이 아닌 `with`는 그 경로를 밝히는 오류로 거부한다. 화면은 다른 상태 파일의 선택 상자를 두고 이 명령을 가리키며, `core.debug.list`를 실행하는 목록 단추를 둔다.

## Status

`core.debug`는 `{open, recorded, entries, viewing, timeline, state, scroll, operation, error}`를 보고한다: 화면이 열렸는지, 열기가 쓴 상태 파일의 경로나 `null`, 목록의 순서대로 나열된 항목 `{path, size, modified}`, 보이는 파일 `{path, size, truncated, kind, length}`(`length`는 보이는 글의 문자 수이며 이미지는 0)나 `null`, 보이는 타임라인 `{sources, truncated, total, shown, lines, selected, warning, level, layer, text, event, surface, session, cid, from, to, context}`(읽은 파일, 글이 잘린 파일, 행 수, 필터를 통과한 수, context 행을 포함한 보이는 줄 수, 선택한 행 수, 저장의 경고, 필터)나 `null`, 보이는 상태 파일 `{path, lines, with, differences}`(트리 줄 수, 비교하는 상태 파일이나 `null`, 차이 수)나 `null`, 보이는 내용의 스크롤 위치(point, 내용이 시작을 지나 당겨진 동안은 native modal이 보고한 대로 음수이고 숫자가 아닌 값은 거부한다), 실행 중이거나 마지막 작업 `{action, path, state}`(`action`은 `save`, `save-all`, `save-rows`, `path`는 저장한 파일(`save-rows`는 글 파일의 이름)이나 `null`, `state`는 `running`, `done`, `failed`), 마지막 실패한 단계나 작업의 오류나 `null`. 화면이 열려 있는 동안 `core.screen`은 `modal` `debug`를 보고한다.
