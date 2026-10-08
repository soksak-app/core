# 디버그 화면

[English](debug.md)

디버그 화면은 결함을 만난 사람이 애플리케이션의 모든 진단 기록을 넘겨줄 수 있게 한다. 애플리케이션의 모든 진단 파일은 `<config-dir>/logs/`에 있다([진단](diagnostics.ko.md), [hosts](hosts.ko.md#애플리케이션-로그)). 디버그 화면은 현재 상태를 그 폴더에 기록하고, 그 파일들을 나열하며, 파일 하나나 전부를 그 사람이 고른 곳에 저장한다.

## 열기

두 host의 도움말 메뉴에 디버그(Debug)가 있다([host contract](host-contract.ko.md#애플리케이션-메뉴)). 디버그는 key 창에서, key 창이 없으면 main 창에서 `core.debug.open`을 실행한다. 화면은 × 버튼(`core.debug.close`)으로 닫는 `dialog` [native modal](native-modals.ko.md)이다.

열기는 상태를 기록한 뒤 파일을 나열한다.

1. page는 registry가 제공하는 모든 status, 곧 core status와 모든 표면의 status 값을 이름과 표면별로 모아 host 호출 `debugRecord({page})`로 보낸다. 읽기에 실패한 status는 그 오류와 함께 기록한다.
2. host는 `logs/state-<time>.json`에 `{time, host, versions, windows, page}`를 쓴다. `host`는 `wailsv3`나 `tauriv2`다. `versions`는 core version, macOS version, `plugins/installed.json`의 내용을 담는다. `windows`는 창마다 `windows.list` 항목, `host.window`, `host.sidecars`, `host.screens`를 담는다. `page`는 page가 보낸 값이다. `<time>`은 UTC 시각 `YYYYMMDDTHHMMSSZ`다.
3. 진단 빌드에서 host는 각 창의 정지 캡처를 `logs/captures/`에 쓴다.
4. host 호출은 `<config-dir>`에 대한 상태 파일의 상대 경로 `{path}`로 답한다.

한 단계가 실패하면 그 실패를 화면의 오류 표시로 보이고, 다른 단계는 계속 실행한다.

## 파일

host 호출 `debugFiles()`는 `<config-dir>/logs/` 아래 모든 파일을 `path` 순으로 `[{path, size, modified}]`로 답한다. `path`는 `<config-dir>`에 대한 상대 경로, `size`는 byte, `modified`는 epoch 이후 millisecond의 수정 시각이다. 화면은 파일마다 크기, 시각, 저장 버튼을 보이고, 목록 위에 모두 저장을 둔다.

- `core.debug.save {path}`는 host 호출 `debugSave({path})`를 실행한다. host는 파일 이름으로 macOS 저장 창을 보이고 고른 곳에 파일을 복사한다. 고른 경로 `{saved}`로, 취소하면 `{saved: null}`로 답한다. `logs/` 밖이거나 파일이 없는 `path`는 그 경로를 밝히는 오류로 거부한다.
- `core.debug.saveAll`은 host 호출 `debugSaveAll()`을 실행한다. host는 이름 `soksak-<host>-debug-<time>.tar.gz`로 저장 창을 보이고 `<config-dir>/logs/`를 gzip으로 압축한 tar 파일로 쓴다. `debugSave`처럼 답한다.

## Status

`core.debug`는 `{open, recorded, files, operation, error}`를 보고한다: 화면이 열렸는지, 열기가 쓴 상태 파일의 경로나 `null`, 나열된 파일, 실행 중이거나 마지막 작업 `{action, path, state}`(`state`는 `running`, `done`, `failed`), 마지막 실패한 작업의 오류나 `null`.
