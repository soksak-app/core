# Plugin dialog

[English](plugin-dialogs.md)

이 제안은 plugin의 view가 자기 plugin의 page를 창 전체의 dialog로 여는 방법을 정한다(F1129). 승인된 내용은 [plugins](../spec/plugins.ko.md), [native surfaces](../spec/native-surfaces.ko.md), [native modals](../spec/native-modals.ko.md)로 옮기고 이 파일은 지운다.

## 문제

section view는 자기 section의 body 안에만 그리므로, field가 많은 form은 sidebar의 너비에 갇힌다. 창의 native modal은 main page의 요소를 modal web view로 복사한다. plugin page는 자기 view channel(`sok-view`)을 가진 view surface에서 실행되고, native modal의 복사된 문서에는 view channel이 없으므로, 어떤 plugin page도 modal의 내용이 될 수 없다.

## 결정

dialog는 plugin의 view surface인 dialog surface다. 그 seat는 창의 content, 곧 title bar 아래의 plane 전체이며 sidebar를 포함한다. 창은 dialog를 많아야 하나 가지며, dialog와 native modal은 함께 열리지 않는다.

1. **선언.** `plugin.json`은 plugin이 dialog로 여는 page를 manifest 표의 행인 member `dialogs`에 `{<name>: {page}}`로 선언한다. `name`은 command segment의 형식을 따르고, `page`는 view composition의 `page`처럼 plugin의 page 경로다. view만 dialog를 열므로, `dialogs`를 선언하는 plugin은 `surface`나 `sections`를 선언한다. reader는 object가 아닌 `dialogs`, 다른 형식의 name, 다른 member를 가진 항목, plugin 안의 경로가 아닌 page를 view composition page의 오류로 거부한다.
2. **열기.** view는 `runtime.dialog.open {name, params}`를 호출하고, SDK는 `runtime.dialog(name, params)`에 이 호출을 보낸다. `params`는 dialog의 page가 검사하는 JSON 값이다. main page는 다음 셋을 거부한다.
   - plugin이 선언하지 않은 name: `view call runtime.dialog.open <name> is not a dialog of <plugin>`
   - dialog가 열려 있는 동안의 열기: `view call runtime.dialog.open: the window shows the dialog <name> of <plugin>`
   - native modal이 보이는 동안의 열기: `view call runtime.dialog.open: the window shows the modal <id>`

   dialog가 열려 있는 동안 `overlay.show()`는 native modal을 `the window shows the dialog <name> of <plugin>`으로 거부하고, modal을 연 명령은 그 오류로 실패한다. 그 밖에는 main page가 dialog surface를 창의 layout에 더한다. 그 start value는 view의 start value다. `params`, `origin` `{directory: null}`, 창의 `project`, `section` `null`에 새 member `dialog` `{name, opener}`가 더해진다. `opener`는 호출한 view의 surface다.
3. **Seat와 순서.** layout이 dialog surface를 가지는 동안 compositor는 창의 content의 frame인 dialog seat를 잰다. dialog surface를 가진 layout은 그 seat를 잰 뒤에만 완전하며, 그 seat는 보인다. dialog surface는 tab이나 section surface와 같은 placement sequence로 배치된다. native container는 dialog surface의 surface host를 다른 모든 surface host 위에 둔다. dialog host가 있는 동안 만든 host는 그 아래에 넣고, 어떤 동작도 surface host를 올리지 않는다. dialog의 문서는 투명하다. 모든 host에서 start value에 `dialog`가 있는 page는 `@soksak/plugin-api`가 50% 불투명도의 검정 backdrop을 root element에 둔다. page는 자기 card를 직접 그린다.
4. **입력.** dialog가 열려 있는 동안 workbench는 boundary의 grab area를 window overlay로 보내지 않는다. main page에도 dialog 위에서 pointer를 받는 요소가 없다. 그래서 창의 content의 모든 점이 dialog host의 점이 된다. main page의 요소는 dialog modal 뒤처럼 inert다([exposure](../spec/exposure.ko.md)). main page는 보이는 native modal에서 하는 것과 같이 열린 dialog surface에서도 둘을 끌어낸다. `packages/workbench/host.js`의 `windowOverlays`와 `behindDialog`가 둘 중 어느 쪽이든 읽는다.

   keyboard에서 dialog는 종류가 `dialog`인 modal이다. 열려 있는 동안 keyboard는 그 안에 머물고, focus ring의 이동은 keyboard를 가져가지 않는다. dialog가 닫히면 keyboard는 focus ring을 가진 card의 active surface로 돌아간다([exposure](../spec/exposure.ko.md)). dialog를 처음 보이는 placement가 창의 key 대기를 시작한다. 대기는 그 placement가 present되면 끝나며, 이는 dialog view의 첫 frame을 포함한다. 그 뒤 workbench가 dialog에 keyboard를 주고(`surfaceFocus`), 기다린 key는 순서대로 dialog로 전달된다. [native modals](../spec/native-modals.ko.md#키보드)의 key 대기의 다른 끝도 이 대기를 끝낸다.
5. **배경.** host는 배치된 surface에서 dialog 상태를 끌어낸다. dialog surface가 배치되어 보이는 동안 창의 dialog 상태는 켜진다. 그러면 host는 각 document web view, dialog가 아닌 각 view surface의 page, 각 region과 image region을 흐리게 하며, 이는 mode가 `dialog`인 native modal과 같다. Wails와 Tauri host의 main page는 자기 내용에 blur를 적용하고, mygo workbench는 자기가 그리는 dialog처럼 자기 위에 blur를 그린다.
6. **닫기.** dialog view는 `runtime.dialog.close {result}`를 호출한다. main page는 dialog surface를 지우고 열기 호출에 `result`로 답한다. 다른 view의 close 호출은 `view call runtime.dialog.close is served only to a dialog`로 거부된다. 열기 호출의 cancel은 dialog surface를 지운다.

   열기 호출은 [plugin processes](../spec/plugin-processes.ko.md) 규칙 3의 reason을 따르며, 이 변경은 규칙 3에 두 문장을 적는다.
   - view call은 main page가 답한다. main page가 다른 view에서 답을 끌어낼 때도 그렇다. 따라서 process의 끝은 끝나는 view가 한 호출만 끝낸다.
   - 호출한 surface가 닫힌 호출은 `surface-closed`로 끝난다. tab view의 unload는 surface를 닫지 않으며, 그 view의 호출은 process의 끝으로 끝난다.

   그래서 opener surface가 닫히면 열기 호출은 `surface-closed`로 끝나고 dialog가 지워진다. opener process가 끝나면 열기 호출은 `process-ended`로 끝난다. main page가 끝나면 둘 다 끝난다. dialog view는 process가 끝나면 모든 view처럼 자기 start value로 다시 시작하고, 열기 호출은 열린 채로 남는다. 재시작이 [view surfaces](../spec/plugins.ko.md#view-표면)의 한도에 이른 dialog surface는 닫힌다. 그때 오류 표시는 place `dialog <plugin> <name>`으로 `the view failed 4 times within 300 seconds and is created again when its dialog is opened again`을 보이고, 열기 호출은 그 text로 실패한다. 닫는 방법은 page가 정한다. 닫기 button이나 Escape가 그 예이며, page는 그때 `runtime.dialog.close`를 호출한다.
7. **Status.**
   - `core.modal`은 열린 dialog를 `{id, mode: "dialog", document: null, plugin}`로 알린다. `id`는 dialog surface이고 `plugin`은 그 plugin이다. native modal은 `plugin`을 `null`로 알린다.
   - `core.surfaces`는 dialog surface를 card나 section 대신 자기 plugin과 `dialog` `{name, opener}`로 나열한다.
8. **기록.** [view surfaces](../spec/native-surfaces.ko.md#view-표면)의 제공되는 view call은 두 호출과 그 거부를 나열한다.

## 답한 반론

- 끝난 dialog process는 view를 다시 시작한다. 재시작은 모든 view의 규칙이고, 열기 호출은 열린 채로 남는다(6항).
- 열기 호출은 규칙 3의 reason을 쓴다. 규칙 3은 두 가지를 적는다. process의 끝은 끝나는 view가 한 호출만 끝낸다. 호출한 surface가 닫힌 호출은 `surface-closed`로 끝난다(6항).
- dialog에는 다시 열 tab이 없으므로, dialog의 재시작 한도는 자기 text를 가진다(6항).
- `core.modal`은 자기 형식을 지키고 `plugin`을 더한다. dialog의 inert 규칙은 dialog surface 뒤에도 적용된다(4항, 7항).
- native modal과 dialog는 서로를 거부하므로, 한 규칙이 양쪽 방향에 적용된다(2항).
- 열기 호출의 cancel은 dialog를 지운다. 닫는 방법은 page가 가진다(6항).
- start value는 `origin`, `project`, `section`, 새 member `dialog`를 정한다(2항).
- seat가 sidebar를 덮으므로, dialog 뒤의 section view는 pointer를 받지 않는다(3항).
- window overlay는 main page를 surface host보다 앞에 둔다. 그래서 dialog가 열려 있는 동안 workbench는 grab area를 보내지 않는다(4항).
- host의 `dialog()`는 modal과 workbench flag만 읽는다. 그래서 host는 배치된 dialog surface에서 blur를 끌어낸다(5항).
- `addSubview:`는 새 host를 맨 위에 둔다. 그래서 native container는 나중의 host를 dialog host 아래에 넣는다(3항).
- keyboard는 종류가 `dialog`인 modal의 규칙을 따른다. keyboard는 dialog 안에 머물고, ring의 이동은 keyboard를 가져가지 않는다(4항).
- `view.ready`는 document start에 보내지므로, key 대기는 dialog를 처음 보이는 placement에서 시작한다. 대기는 그 placement가 present되면, 곧 dialog view의 첫 frame 뒤에 끝난다(4항).
- 재시작 한도에 이른 dialog는 오류 표시로 오류를 보인다(6항).
- host는 각 view surface의 page를 자기 documents에 등록하고(Go host의 `mountView`), blur는 그 documents를 돈다. 그래서 그 page는 이미 흐려지며, 바뀌는 것은 dialog 상태뿐이다(5항).
- dialog process는 열기 호출의 peer가 아니다. 규칙 3은 끝나는 view가 가진 호출을 끝내는데, 열기 호출은 opener의 것이다(6항).
- `windowOverlays`와 `behindDialog`는 native modal뿐 아니라 dialog surface도 읽는다(4항).
- [native modals](../spec/native-modals.ko.md)에는 dialog web view가 새로 만든 surface 위에 남는다는 문장이 있다. 이 문장은 native modal web view를 가리키며, 그 web view는 dialog surface가 열려 있지 않을 때만 열린다. dialog surface의 쌓임 규칙은 [native surfaces](../spec/native-surfaces.ko.md#surface-host-container)의 surface host container로 간다(3항).
- [native modals](../spec/native-modals.ko.md)의 표에 dialog surface의 행이 생기며, 그 영역은 창의 content다. mode가 `dialog`인 native modal은 main content viewport를 지킨다(3항).
- 어떤 동작도 surface host를 올리지 않는다. native modal web view를 올리는 동작은 dialog가 열려 있지 않을 때만 실행된다(3항).
- dialog seat는 자기 완전성 규칙을 가진 seat 종류다(3항).
- backdrop은 모든 host에서 dialog page의 root에 있고, mygo workbench는 자기 위에 blur를 그린다(3항, 5항).

## 기각

- plugin page를 load하는 modal web view: 이 방법은 page에 view channel을 주지 않는다. 호출을 위한 surface identity도, placement sequence 안의 자리도 주지 않는다. 그러면 view의 호출, status, record에 두 번째 경로가 필요하다.
- document region을 통해 native modal의 복사된 문서 안에 두는 page: document region은 surface의 web document를 보여 주며, view channel을 가진 plugin page를 보여 주지 않는다([document regions](../spec/native-surfaces.ko.md#문서-영역)).
- dialog surface 아래에 main page가 그리는 backdrop: 창의 surface는 main web view 위에 있으므로, main page의 backdrop은 그 아래에 남는다.
- 호출에서 경로로 지정하는 dialog page: 선언된 page는 호출이 실행되기 전에 reader가 검사하는 계약이다.
