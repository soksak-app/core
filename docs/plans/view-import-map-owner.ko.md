# View import map 소유자

[English](view-import-map-owner.md)

이 제안은 F212.12-1-10-6을 결정한다. 호스트가 제공하는 각 view page에 core의 view import map을 넣으므로, plugin page는 자기 import map을 갖지 않는다. 승인된 내용이 [plugin processes](../spec/plugin-processes.ko.md), [plugins](../spec/plugins.ko.md), [native surfaces](../spec/native-surfaces.ko.md)에 들어간 뒤 이 문서를 제거한다.

## 사실

- view import map은 `packages/plugin-api/index.js`의 상수 `VIEW_IMPORTS`다. 항목은 다섯 개이며 `soksak`, `@soksak/plugin-api`, `@soksak/plugin-api/view`, `@soksak/plugin-api/screen-hash`, `@soksak/shared/`다.
- 각 plugin view page는 head의 `<script type="importmap">`에 자기 사본을 가진다. `plugins/terminal/ui/terminal.html`은 1행에 doctype, 4~5행에 사본이 있고 module script는 body에 있다.
- `checkViewPage`(`packages/plugin-api/index.js`)는 `VIEW_IMPORTS`와 같은 map이 정확히 하나 있어야 한다. `checkViewLiteral`(`packages/plugin-api/view-check.js` 47~54행)은 plugin literal의 `viewImports`가 그것과 같아야 하며, `view-check.js` 20행은 `view-start.js`의 SHA-256을 고정한다.
- `checkViewModules`(`packages/plugin-api/view-modules.js` 14행)는 page가 아니라 `index.js`에서 `VIEW_IMPORTS`를 가져온다.
- view는 native 함수 하나(`native/darwin/src/document_view.m`, plugin 파일 응답 약 395~418행, core root 응답 약 420~448행)가 제공한다. Go(`packages/host/wailsv3/src/platform/darwin/document.go`)와 Rust(`packages/host/tauriv2/src/platform/darwin/document.rs`)는 모두 `sp_document_create`로 view를 만든다. Windows에는 view 지원이 없다(`platform/windows/unsupported.go`).
- plugin 파일 응답은 `dataWithContentsOfFile`로 파일 전체를 읽고 그 길이로 `Content-Length`를 정한다. 스트리밍 응답은 없다.
- 설치 검사는 release zip의 `sha256`이다(`docs/spec/installation.md` 55행). 압축을 풀기 전에 검사한다.
- 명세는 호스트가 map을 주입하지 않는다고 적는다(`docs/spec/plugin-processes.md` rule 4, `docs/spec/plugins.md` 168행).
- core가 screen-hash 항목을 추가했을 때 map을 복사한 모든 plugin page에 그 항목이 없었다(`docs/features.md` F212.12-1-10-1과 -2, shell P16, hwp H26).
- 측정: `native/darwin/tests/view_import_map_test.m`은 doctype 뒤에 map을, body에 module을 둔 page를 제공한다. bare specifier는 `sok://core/m.js`로 해석되며, 세 번 실행했다.

## 결정

1. native view handler는 실행 중인 core의 map을 doctype token 바로 뒤에 넣는다. 대상은 view composition page뿐이다(`isView`). document region page는 바뀌지 않는다.
2. 이미 import map을 가졌거나 doctype으로 시작하지 않는 view page는 파일 이름을 밝힌 명시적 오류로 거부한다. 두 map을 합치거나 바꾸지 않는다.
3. map 텍스트는 실행 중인 호스트의 staged frontend에서 온다. staging 도구는 `core-root.json`을 쓰듯 `VIEW_IMPORTS`를 staged frontend의 파일로 쓰고(`docs/spec/plugins.md`의 staged layout), 호스트는 시작할 때 그 텍스트를 native handler에 넘긴다. 두 호스트는 같은 native 구현을 거친다.
4. `Content-Length`는 삽입 뒤에 계산한다. view 적재마다 한 기록이 page 경로와 삽입한 map의 SHA-256을 남긴다.
5. `checkViewPage`는 import map이 없고 doctype으로 시작함을 요구한다. `viewImports`는 view literal에서 빠진다. `checkViewModules`는 오프라인 module graph 검사를 위해 `VIEW_IMPORTS`를 계속 읽는다.
6. plugin 저장소는 각 view page와 자기 test 사본에서 map을 제거한다. core는 목록을 보고하며 plugin 저장소를 바꾸지 않는다.

## 이유

- pack 시점의 사본은 plugin이 고정한 core release에만 맞는다. 호스트는 자기가 실행하는 core의 module을 제공하므로, 호스트 쪽 삽입만이 map과 제공되는 module을 한 버전에 묶는다.
- map은 core와 호스트의 계약이다(`공통 기능은 core에 속한다`). plugin이 가진 사본마다 정의가 하나 더 생긴다.

## 반론과 답

1. 제공하는 bytes의 재작성(무결성, `Content-Length`, 스트리밍). 답: 스트리밍은 없고 파일은 전체를 읽으며, `Content-Length`는 재작성 뒤에 계산한다. 설치 hash는 삽입이 바꾸지 않는 release zip을 덮는다. 제공되는 page는 패키징된 파일에 호스트가 소유한 map을 더한 것이며, 명세가 그것을 적는다.
2. map과 module script의 순서, 두 map. 답: 삽입은 doctype 뒤, 모든 태그 앞에 있으므로 첫 module script보다 먼저 온다(위 측정). 자기 map을 가진 page는 거부되므로 map이 둘이 되는 일은 없다.
3. document-start user script가 map을 넣는다. 답: 주 경로로는 기각한다. document-start script는 DOM이 생기기 전에 실행되며, MutationObserver로 넣는 삽입은 parser가 module script를 준비하는 순서보다 앞선다고 보장되지 않는다. 측정하지 않았고 추진하지 않는다.
4. 오프라인 검사. 답: `checkViewModules`는 고정된 `@soksak/plugin-api`의 `VIEW_IMPORTS`를 읽으므로 module graph 검사는 오프라인으로 돈다. 제거되는 것은 page map의 동등성 검사뿐이다.
5. 디버깅에서 page 원문과 실행되는 내용이 다르다. 답: handler는 view 적재마다 page 경로와 map SHA-256을 한 기록으로 남긴다. 호스트가 주입하는 view-start, theme, start-value script가 이미 실행 page를 바꾸므로, 이 변경은 문서화된 주입이 하나 더 늘어나는 것이다.
6. 대안. build 때 plugin이 복사하는 map 파일은 F212.12-1-10-1이 보인 drift를 다시 만든다. pack 시점에 생성한 map은 map을 고정된 core에 묶으므로, 이 제안이 없애려는 불일치를 남긴다. `src`로 불러오는 import map은 명세에 없고 측정하지 않았다.
7. 호스트 사이의 parity. 답: 두 호스트는 같은 darwin view 함수로 view를 만들므로 삽입은 한 곳에만 있다. 계약 case(입력 HTML과 기대 출력)를 native test와 plugin-api test가 함께 실행한다.
8. obsolete code path를 제거하라는 규칙. 답: page map과 그 검사는 새 경로 옆에 남기지 않고 제거한다. 자기 map을 가진 page의 거부가 동등성 검사를 대신하며, page map을 읽는 fallback은 없다.

## 체크리스트

`docs/features.md`의 F212.12-1-10-6a부터 -6f까지 항목이 단계를 담는다.
