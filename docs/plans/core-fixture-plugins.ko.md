# Core fixture plugin

[English](core-fixture-plugins.md)

checklist 항목 F25.2의 제안이다. 그 규모에 대한 사용자의 승인을 기다린다. 승인된 내용은 명세로 옮기고 이 파일은 지운다.

## 문제

package의 test는 다른 package의 구현을 검증하지 않는다. core의 window 검사는 이 규칙을 어긴다. core 검사 파일 42개가 `fresh`로 시작하는데, 이 함수는 terminal tab이 있는 `diagnostics.fixture`를 열고 terminal plugin을 기다린다. compositor, presentation, placement, sidebar, settings 검사는 terminal plugin의 native image region, files plugin의 section, browser plugin의 document region을 잰다. 그 plugin이 바뀌면 core 검사가 실패할 수 있고, core 검사는 그 plugin 없이 실행할 수 없다.

## 제안

1. **core의 fixture plugin.** 폴더 `fixtures/plugins/`는 core 검사만을 위한 plugin을 가진다. 각각 `plugin.json`, page, core 검사가 재는 가장 작은 동작을 가진다.
   - `fixture-image`: fixture sidecar가 raster를 주는 image region 하나를 가진 surface page, 그 session과 cell 크기의 status, 크기를 바꾸고 presentation을 일부러 실패시키는 command.
   - `fixture-sections`: sidebar, set, orientation 검사를 위한 control과 status를 가진 세로와 가로 section.
   - `fixture-document`: document region과 modal 검사를 위한 document region 하나를 가진 surface page.
2. **core의 fixture image sidecar.** `fixtures/sidecars/image`는 [native surfaces](../spec/native-surfaces.ko.md#그림-영역)의 image supplier 쪽을 구현하는 작은 Rust sidecar다. 요청한 크기의 단색 raster를 IOSurface에 그리고, image envelope를 보내며, host가 답할 때까지 각 transfer image를 유지하고, session을 해제한 뒤 `closed`에 답한다. shell은 실행하지 않는다.
3. **이름 대신 선언.** `scripts/workspace-registry.json`이 `make registry`와 `make install-plugins`를 위해 fixture plugin과 fixture sidecar를 선언하고, `diagnostics.fixture`는 terminal plugin의 이름 대신 선언된 fixture에서 배치를 가져온다.
4. **검사.** `e2e/fixture.mjs`의 `fresh`는 fixture image surface를 기다리고, 42개 검사 파일은 terminal, files, browser의 status와 command를 fixture의 것으로 바꾼다. terminal, browser, files 동작의 검사는 F25.3에서 F25.5에 걸쳐 각 저장소로 옮긴다.

## 비용

2026-10-05에 측정했다. core 검사 파일 42개 중 terminal의 status나 command를 직접 쓰는 것은 `project-directory`, `library`, `projects`, `text-size`뿐이고, 나머지는 `fresh`가 terminal 표면을 기다리기 때문에만 terminal plugin에 의존하므로 `fresh`와 그 네 파일이 바뀐다. terminal service의 IOSurface frame 코드는 1,301줄이다. fixture sidecar는 단색 raster 하나를 그리고 그 envelope에 답하므로 수백 줄이다. 작업은 하루에서 이틀이며, 각 단계의 앞뒤로 두 host에서 window suite가 통과해야 한다.

## 순서

사용자가 정하면 F25.2는 release(R2) 뒤로 간다. 그렇지 않으면 fixture sidecar와 그 계약 test부터 시작하고, 다음 fixture plugin, 그다음 검사를 파일 묶음 단위로 바꾼다.
