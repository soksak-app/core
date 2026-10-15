# 외부 애플리케이션 표면

[English](external-app-surface.md)

이 제안은 F192에 속한다. 다른 toolkit의 애플리케이션을 그 interface를 plugin page로 다시 쓰지 않고 표면 안에 띄운다.

## 문제

다른 toolkit으로 interface를 만든 애플리케이션은 지금 그 interface를 plugin page로 다시 써야만 띄울 수 있다. 창 캡처는 캡처의 지연을 더하고, 애플리케이션이 자기 창으로 여는 popup을 잃는다.

## 방식

애플리케이션은 sidecar가 image region에 넘기는 공유 버퍼에 그리고, 입력을 자기 toolkit의 event로 받는다. vt sidecar가 IOSurface에 그리고 page가 region 입력과 DOM pointer event를 전달하는 터미널의 경로를 일반화한 것이다.

작업은 각각 버릴 수 있는 두 측면이다:

- **측면 1, 표면.** 어떤 애플리케이션도 이름하지 않는다: embed protocol과 client library, 애플리케이션 sidecar, 애플리케이션 plugin. 관문을 넘지 못하면 branch와 그 저장소를 버린다.
- **측면 2, 예시 애플리케이션의 어댑터**(Slint로 만든 영상 편집기, AGPL-3.0이며 interface로만 닿는 모듈에 대한 예외가 있다). embed protocol에만 의존하고, 그 애플리케이션의 license 아래 자기 저장소에 둔다. 관문을 넘지 못하면 그 저장소만 버린다.

Slint, egui·wgpu, Qt, 웹 interface를 처음부터 고려한다. 측면 2는 Slint 어댑터를 구현하고, 측면 1의 설계 검토는 protocol이 나머지를 막지 않는지 확인한다.

## 범위

표면은 공유 버퍼에 그리는 애플리케이션을 보인다: toolkit이 애플리케이션이 고른 대상에 window를 그리게 허용하고(Slint platform, egui나 wgpu texture, Qt `QQuickRenderControl`), 어댑터를 더할 소스가 있는 애플리케이션이다. 웹 interface는 document region에 보인다. 운영체제가 window를 합성하고 렌더링 대상을 고를 수 없는 애플리케이션, 예컨대 네이티브 AppKit 애플리케이션은 지원하지 않는다: macOS에는 다른 프로세스의 window나 view를 window 안에 두는 공개 interface가 없고, 그 window를 캡처하고 입력을 주입하는 방식은 캡처의 지연을 더하고 popup을 잃어 관문을 만족하지 못한다.

## 있는 것

- image region은 supplier sidecar가 host에 `{"image":{name, generation, raster, token:{kind:"iosurface-global", id, nonce}, width, height, scale, format:"bgra8", sequence}}`로 넘기는 frame을 보인다. host는 `image.consumed`로 답하고 `{"image":{"configure":{name, generation, raster, width, height, scale}}}`로 supplier에 크기를 알린다([native surfaces](../spec/native-surfaces.ko.md)).
- image region은 page에 `key`, `insert`, `compose`, `focus`를 보고한다. pointer와 wheel event는 region을 지나 page로 가고, page가 그 의미와 cursor를 정한다.
- 터미널 page는 region 입력을 sidecar 요청 `input`으로, DOM pointer event를 `mouse`, `scroll`, `selection.*`으로 전달한다.
- sidecar는 표준 입력과 출력으로 줄마다 JSON object 하나를 주고받는다([sidecars](../spec/sidecars.ko.md)).

## 측면 1

### core

첫 구현은 core를 바꾸지 않는다: 애플리케이션 plugin은 터미널처럼 pointer, scroll, cursor를 page로 전달하고, 크기, 배율, frame token은 기존 image region 경로를 쓴다. 관문이 page 경로가 지연의 원인임을 보일 때만 core를 바꾼다. 후보는 native view에서 pointer event를 보고하는 region 입력 범위와 cursor rect이고, 각각 명세를 먼저 쓰고 Red와 Green으로 시험한다.

### embed protocol과 client library

- sidecar는 socket 경로를 환경에 넣어 애플리케이션을 시작하고, 애플리케이션 안의 어댑터가 그곳에 접속한다.
- 애플리케이션은 크기와 배율, 입력(키, input method 조합과 확정, pointer 이동과 버튼, scroll, focus), 종료를 받는다.
- 애플리케이션은 각 frame token, cursor 모양, input method caret, 자기 상태를 보낸다.
- 공유 버퍼 token은 운영체제마다 정의한다: darwin `iosurface-global`, windows DXGI 공유 handle, linux dmabuf. host는 darwin token을 구현하고, windows와 linux는 R2-7을 기다린다.
- client library는 toolkit 중립(C interface를 가진 Rust crate)이다: 공유 버퍼(이중 또는 삼중)를 만들고 protocol을 말한다.
- 메뉴, tooltip, drop-down은 애플리케이션이 같은 버퍼에 그린다. Slint platform, egui, `QQuickRenderControl`은 그것들을 한 render target에 그릴 수 있다. 열기 패널 같은 시스템 대화상자만 자기 창으로 뜬다.

### 애플리케이션 sidecar와 plugin

- sidecar는 애플리케이션을 시작·종료하고, embed socket을 열고, 각 frame token을 자기가 공급하는 image region에 넘기며, page가 보낸 입력을 전달한다.
- plugin은 image region 하나를 보이고, region 입력과 DOM pointer·scroll event를 전달하며, cursor 모양을 정한다. 애플리케이션이 웹 주소이면 대신 document region에 보인다.
- 관문을 위해, 시험 애플리케이션이 매 frame 움직이는 그림을 그리고 입력에 곧바로 답한다.

### 측면 1의 관문

실제 표면에서 시험 애플리케이션으로:

- 60과 120 Hz의 frame 간격 p99가 두 frame 이하이고 빠진 frame이 없다.
- pointer 이동부터 그 결과의 present까지의 지연이 부하 없는 기계에서 중앙값 25 ms 이하, p90 40 ms 이하다.
- core를 바꾸지 않거나, 바꾸더라도 region 입력 범위와 cursor에 머물고 기존 region을 바꾸지 않는다.

지연은 모든 단계(native 입력, host relay, page, sidecar, 애플리케이션, present)의 기록으로 계산하므로, 지연을 만드는 단계가 수치로 드러난다.

## 측면 2

- 어댑터는 공유 버퍼에 그리고 embed 입력을 창 event(pointer, 키, input method preedit와 commit, scroll, 배율)로 바꾸는 Slint platform을 고른다. 애플리케이션이 정하는 cursor는 embed 메시지로 보낸다.
- 애플리케이션의 변경은 창 platform 선택에 머문다. 편집 code를 바꿔야 하면 측면 2를 멈춘다.
- 다른 어떤 저장소도 이 저장소의 code를 link하지 않고, 애플리케이션에는 embed protocol로만 닿는다. 애플리케이션의 이름과 mark는 쓰지 않는다.
- 관문: 애플리케이션이 표면에서 project를 열고 재생하고 편집하며, 재생 중에 측면 1의 관문을 만족한다.

## 연결 plugin

애플리케이션은 연결 plugin으로 사람들에게 닿으며, [connector plugins](connector-plugins.ko.md)가 그것을 정한다.

## 저장소

새 저장소(embed kit, 애플리케이션 sidecar, 애플리케이션 plugin, 어댑터)는 로컬 저장소로 버전 0.0.1에서 시작한다. 원격과 registry 항목은 관문을 넘은 뒤에 만들어, 버린 측면이 게시된 흔적을 남기지 않게 한다.

## 순서

1. branch `feat/app-surface-F194`에서 체크리스트에 F192와 하위 항목을 둔다.
2. embed protocol, client library, 시험 애플리케이션(F194.1). 이어서 sidecar와 plugin(F194.2). 각 단위를 Red와 Green으로 시험한다.
3. 측면 1의 관문(F194.3). 넘거나, 결과를 기록하고 측면 1을 버린다.
4. 측면 2(F194.4)와 그 관문.
5. 넘은 측면만 병합한다.
