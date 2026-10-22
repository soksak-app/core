# 선언 tree 노드 사이의 화살표 키

[English](tree-keys.md)

이 제안은 F238-d-22를 정한다. 선언 tree의 행 사이를 화살표 키로 이동하는 것을 선언된 동작으로 둘지 정한다. 받아들인 내용은 [선언 UI](../spec/declared-ui.ko.md)와 [exposure](../spec/exposure.ko.md)로 옮기고, 이 제안은 지운다.

## 범위

검증은 네 가지를 정한다.

1. workbench가 화살표 키로 선언 tree의 보이는 행 사이에서 키보드 focus를 옮기는가.
2. 키 대응표.
3. 각 키가 AGENTS.md가 모든 단축키에 요구하는 대로 선언된 명령에 닿는 방법.
4. 그것을 보이는 시험.

핵심 반론은 결정이 명세나 AGENTS.md 규칙과 어긋나거나, 구현할 수 없거나, 두 구현이 다르게 처리할 경우를 남긴다는 것을 보여야 한다. 범위 밖: 문구, 보조 기술을 위한 role과 속성(접근성 주장은 F212.12를 기다린다), list, plugin view.

## 문제

module section은 자기 tree를 그리고 키를 처리할 수 있었다. 선언 tree는 `open`이 있는 노드의 Enter 말고는 키 처리기가 없다(`declared-ui.md`, Binding). 그래서 선언 UI로 옮기기 전에 화살표 키로 tree를 이동하던 사람은 더 이상 그럴 수 없다(`decision-review-F238-d.md`의 결정 D9.9가 그 비용을 적는다). tree의 키보드 이동은 공통 기능이므로 plugin마다가 아니라 core에 속한다.

## 결정

1. workbench는 선언 tree 노드의 focus된 control(노드의 label button 또는 펼침 control)에서 화살표 키를 처리한다.
2. 키 대응표(보이는 tree 노드를 그린 순서로):
   - Down은 focus를 focus 대상이 있는 다음 보이는 tree 노드로, Up은 이전 노드로 옮긴다. 그런 노드의 마지막이나 처음에서는 focus가 그대로다.
   - Right는 접힌 가지에서 `core.declared-ui.tree.expand`를 `expanded: true`로 실행하고, 펼친 가지에서 focus 대상이 있는 첫 자식 노드로 focus를 옮기고(그런 자식 노드가 없으면 focus가 그대로다), 잎에서는 아무것도 하지 않는다.
   - Left는 펼친 가지에서 `core.declared-ui.tree.expand`를 `expanded: false`로 실행하고, 접힌 가지나 잎에서 부모 노드로 focus를 옮기며, 루트 노드에서는 아무것도 하지 않는다.
   - Home과 End는 focus 대상이 있는 첫 보이는 tree 노드와 마지막 보이는 tree 노드로 focus를 옮긴다.
   - 수정 키(Shift, Control, Alt, Meta)가 함께 눌린 키는 처리하지 않는다.
3. 처리하는 키는 AGENTS.md가 모든 단축키에 요구하는 대로 선언된 명령을 실행한다. focus 이동은 `packages/workbench/exposure.json`에 선언한 `core.declared-ui.tree.move {status, tree, path, key}`를 실행하고, 그 처리기가 focus를 옮긴다. 접힌 가지의 Right와 펼친 가지의 Left는 `core.declared-ui.tree.expand`를 실행하고, 그 밖에 처리하는 키는 `core.declared-ui.tree.move`를 실행한다. 키와 명령의 짝마다 owner가 `workbench`인 `packages/workbench/shortcuts.json`의 행이 하나씩 있고, ArrowRight와 ArrowLeft는 When 열이 가지 상태("a collapsed branch has focus", "an expanded branch has focus")를 적는 행을 둘씩 가지므로 `scripts/test/shortcut-table.test.mjs`가 키 비교를 다룬다(`exposure.md`, 단축키 표).
   - tree 노드의 focus 대상은 label control이 있고 켜져 있으면 그것이고, 아니면 가지의 펼침 control이다. focus 대상이 없는 tree 노드는 Down, Up, Home, End가 건너뛰고 Left의 대상이 아니다.
4. 처리한 키는 `preventDefault`를 불러 sidebar가 그 키로 scroll되지 않게 한다. 처리하지 않은 키는 기본 동작을 지킨다.
5. 다시 그려도 address가 남는 control의 요소는 유지되므로(`declared-ui.md`, Binding) focus가 남는다. 받아들인 값이 focus된 control을 없애면 focus는 focus 대상이 있는 가장 가까운 앞 tree 노드로, 없으면 focus 대상이 있는 첫 tree 노드로 옮긴다. 거부나 출처 변경이 그것을 없애면 focus는 문서 body로 옮긴다.
6. 명세 변경(영어와 한국어): `declared-ui.md` 136행("No other declared UI element has a key handler.")을 "Declared tree nodes also handle the ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home and End keys without a modifier, as the Tree keys section of this document specifies. No other declared UI element has a key handler."로 바꾸고, 1~5를 담은 Tree keys 절을 새로 둔다. `exposure.md` 56행에 "A declared UI tree node handles the keys that the Tree keys section of declared UI specifies."를 더한다.

## 시험

fake binder와 fake 출처로 그린 tree에 대한 workbench 단위 시험: 접힌 가지, 펼친 가지, 잎, 첫 행과 마지막 행에서 대응표의 각 키, 수정 키, focus된 행을 없애는 다시 그리기. 각 시험은 활성 요소를 control address로, 출처로 보낸 펼침 요청을 단언한다. Red는 화살표 키가 focus를 옮기지 않는 바꾸지 않은 workbench다.

## 검증 기록

- 1차, 감사자 A: 결정이 뒤집는 `declared-ui.md`와 `exposure.md`의 키 처리기 문장, 선언된 명령과 단축키 표 행이 없는 focus 이동, label control이 없거나 꺼진 행, 거부나 출처 변경 뒤의 focus. 모두 수용해 위에 합쳤다.
- 2차, 감사자 B: 가지 상태마다 Right와 Left가 실행하는 명령, 키와 명령 짝마다 하나인 단축키 행, 첫 자식에 focus 대상이 없거나 자식이 오지 않았을 때의 Right 대상, "tree node"의 두 번째 이름인 "tree row". 모두 수용해 위에 합쳤다.
- 3차, 감사자 C: focus 대상 규칙과 맞지 않는 Down, Up, Home, End와 tree 노드를 "행"으로 부른 것: 수용해 위에 합쳤다. "focus target"은 구현이 `packages/plugin-api/terms.json`에 더한다. `shortcuts.json`의 정확한 행과 `exposure.md`(+ko)의 표 행, 6의 한국어 문장과 한국어 제목, 단축키 표 시험이 읽는 `event.key === "<Name>"` 비교는 구현 항목이 쓰고 그 시험이 정할 세부이므로, 검증은 3차 뒤 남은 핵심 반론 없이 닫는다.
