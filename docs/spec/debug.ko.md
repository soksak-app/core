# 디버그 화면

[English](debug.md)

디버그 화면은 결함을 만난 사람이 애플리케이션의 모든 진단 기록을 넘겨줄 수 있게 한다. 애플리케이션의 모든 진단 파일은 `<config-dir>/logs/`에 있다([진단](diagnostics.ko.md), [hosts](hosts.ko.md#애플리케이션-로그)). 디버그 화면은 현재 상태를 그 폴더에 기록하고, 그 파일들을 나열하며, 파일 하나나 전부를 그 사람이 고른 곳에 저장한다.

## 열기

두 host의 도움말 메뉴에 디버그(Debug)가 있다([host contract](host-contract.ko.md#애플리케이션-메뉴)). 디버그는 애플리케이션 main 창의 메인 page에서 `core.debug.open`을 실행한다. 보기 메뉴의 글자 크기 항목과 같은 창이다([글자 크기](text-size.ko.md)). 화면은 × 버튼(`core.debug.close`)으로 닫는 `dialog` [native modal](native-modals.ko.md)이다. 화면을 열면 설정 modal이 닫히고, 설정 modal을 열면 화면이 닫힌다. 애플리케이션 host가 없는 page에는 디버그 화면이 없고, 거기서 `core.debug.open`은 오류로 실패한다.

열기는 상태를 기록한 뒤 파일을 나열한다.

1. page는 registry가 제공하는 모든 status, 곧 core status와 모든 표면의 status 값을 이름과 표면별로 모아 host 호출 `debugRecord({page})`로 보낸다. 읽기에 실패한 status는 그 오류와 함께 기록한다.
2. host는 `logs/state-<time>.json`에 `{time, host, versions, windows, page}`를 쓴다. `host`는 `wailsv3`나 `tauriv2`다. `versions`는 core version, macOS version, `plugins/installed.json`의 내용을 담는다. `windows`는 창마다 `windows.list` 항목, `host.window`, `host.sidecars`, `host.screens`를 담는다. `page`는 page가 보낸 값이다. `<time>`은 UTC 시각 `YYYYMMDDTHHMMSSZ`다.
3. 진단 빌드에서 host는 각 창의 정지 캡처를 `logs/captures/`에 쓴다.
4. host 호출은 `<config-dir>`에 대한 상태 파일의 상대 경로 `{path}`로 답한다.

한 단계가 실패하면 그 실패를 화면의 오류 표시로 보이고, 다른 단계는 계속 실행한다.

## 파일

host 호출 `debugFiles()`는 `<config-dir>/logs/` 아래 모든 파일을 `path` 순으로 `[{path, size, modified}]`로 답한다. `path`는 `<config-dir>`에 대한 상대 경로, `size`는 byte, `modified`는 epoch 이후 millisecond의 수정 시각이다. 화면은 파일마다 크기, 시각, 저장 버튼을 가장 새 파일부터(`modified`, 같으면 `path`순으로) 보이고, 목록 위에 모두 저장을 둔다.

- `core.debug.save {path}`는 host 호출 `debugSave({path})`를 실행한다. host는 파일 이름으로 macOS 저장 창을 보이고 고른 곳에 파일을 복사한다. 고른 경로 `{saved}`로, 취소하면 `{saved: null}`로 답한다. `logs/` 밖이거나 파일이 없는 `path`는 그 경로를 밝히는 오류로 거부한다.
- `core.debug.save-all`은 host 호출 `debugSaveAll()`을 실행한다. host는 이름 `soksak-<host>-debug-<time>.tar.gz`로 저장 창을 보이고 `<config-dir>/logs/`를 gzip으로 압축한 tar 파일로 쓴다. `debugSave`처럼 답한다.

## 보기

모든 파일은 모든 행의 같은 칸에 보기 단추와 저장 단추를 가진다. `core.debug.view {path}`는 host 호출 `debugRead({path})`를 실행하고, 이 호출은 글 파일에는 `{path, size, truncated, kind, text}`로, PNG 파일에는 `{path, size, truncated, kind, image}`로 답한다. `kind`는 `text`나 `image`다. 글 파일의 `text`는 파일의 내용이고, 파일이 더 크면 마지막 262144 byte(문자 경계에서 시작)이며 이때 `truncated`는 true다. PNG 파일의 `image`는 파일 전체의 `data:image/png;base64,` 주소이고 `truncated`는 false다. `logs/` 밖이거나 파일이 아니거나 16 MB보다 큰 PNG 파일이거나 이름이 `.png`인데 PNG signature로 시작하지 않거나 내용이 UTF-8 글이 아닌 다른 파일인 `path`는 그 경로를 밝히는 오류로 거부하고, 화면은 그 오류를 보인다. 화면은 글이나 이미지를 경로와 크기와 함께 보이고, `truncated`가 true이면 `앞부분 생략`을 밝히며, `core.debug.list`를 실행해 목록을 다시 보이는 목록 단추를 둔다. 글은 쓰인 순서(오래된 줄이 먼저)를 유지하고, 화면은 가장 새 줄이 있는 글의 끝으로 스크롤한 채 열린다.

## Status

`core.debug`는 `{open, recorded, entries, viewing, scroll, operation, error}`를 보고한다: 화면이 열렸는지, 열기가 쓴 상태 파일의 경로나 `null`, 목록의 순서대로 나열된 항목 `{path, size, modified}`, 보이는 파일 `{path, size, truncated, kind, length}`(`length`는 보이는 글의 문자 수이며 이미지는 0)나 `null`, 보이는 내용의 스크롤 위치(point), 실행 중이거나 마지막 작업 `{action, path, state}`(`action`은 `save`나 `save-all`, `path`는 저장한 파일이나 `null`, `state`는 `running`, `done`, `failed`), 마지막 실패한 단계나 작업의 오류나 `null`. 화면이 열려 있는 동안 `core.screen`은 `modal` `debug`를 보고한다.
