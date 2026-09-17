# macOS 공용 네이티브 라이브러리.
#
# src/ 의 공용 소스를 정적 라이브러리 하나로 빌드하고, 사용하는 애플리케이션이 pkg-config 로
# 헤더와 라이브러리 위치를 찾도록 soksak-darwin.pc 를 생성한다.
#
#   make          build/libsoksak-darwin.a, build/soksak-darwin.pc
#   make test             입력 주입, 창 상태, 창 단추 배치, 표시 대기, 웹뷰 초점, 문서 영역 검사를 실행한다. 애플리케이션을 활성화하지 않는다
#   make test-activation  창 활성화 후 호버 검사, 겹친 웹뷰 입력 검사(기준 실행·등록 실행), 웹 인스펙터 검사를
#                         실행한다. 애플리케이션을 활성화해 포커스를 가져간다

SHELL := /bin/sh

SOURCES    := $(wildcard src/*.m)
BUILD      := $(CURDIR)/build
OBJECTS    := $(SOURCES:src/%.m=$(BUILD)/%.o)
LIBRARY    := $(BUILD)/libsoksak-darwin.a
PKGCONFIG  := $(BUILD)/soksak-darwin.pc
FRAMEWORKS := -framework Cocoa -framework WebKit -framework QuartzCore -framework CoreImage -framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo
# 소스가 사용하는 가장 새로운 API 는 macOS 14.0 의 것이다(capture.m 의 ScreenCaptureKit).
# 사용하는 빌드가 같은 최소 버전으로 컴파일·링크하도록 .pc 의 Cflags 와 Libs 에도 넣는다.
MINIMUM    := -mmacosx-version-min=14.0
CFLAGS     := -fblocks -fmodules -Wall -Werror -O2 $(MINIMUM)

.PHONY: all test test-activation clean

all: $(LIBRARY) $(PKGCONFIG)

$(BUILD)/%.o: src/%.m $(wildcard src/*.h src/private/*.h) Makefile | $(BUILD)
	@clang $(CFLAGS) -c $< -o $@

$(LIBRARY): $(OBJECTS)
	@rm -f $@
	@ar rcs $@ $^

$(PKGCONFIG): Makefile | $(BUILD)
	@printf '%s\n' \
	  'Name: soksak-darwin' \
	  'Description: Shared macOS window, webview, and surface layout code' \
	  'Version: 0.0.1' \
	  'Cflags: -I$(CURDIR)/src $(MINIMUM)' \
	  'Libs: -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) $(MINIMUM)' > $@

$(BUILD):
	@mkdir -p $@

$(BUILD)/%_test: tests/%_test.m $(LIBRARY) $(wildcard src/*.h src/private/*.h)
	@clang $(CFLAGS) -I$(CURDIR)/src $< -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

test: $(BUILD)/window_motion_test $(BUILD)/input_inject_test $(BUILD)/window_facts_test $(BUILD)/window_controls_test $(BUILD)/surface_layout_test $(BUILD)/webview_focus_test $(BUILD)/webview_geometry_test $(BUILD)/document_view_test
	@$(BUILD)/window_motion_test
	@$(BUILD)/input_inject_test
	@$(BUILD)/window_facts_test
	@$(BUILD)/window_controls_test
	@$(BUILD)/surface_layout_test
	@$(BUILD)/webview_focus_test
	@$(BUILD)/webview_geometry_test
	@$(BUILD)/document_view_test

test-activation: $(BUILD)/input_activate_test $(BUILD)/webview_input_test $(BUILD)/webview_inspector_test
	@$(BUILD)/input_activate_test
	@$(BUILD)/webview_inspector_test
	@$(BUILD)/webview_input_test --baseline
	@$(BUILD)/webview_input_test

clean:
	@rm -rf $(BUILD)
