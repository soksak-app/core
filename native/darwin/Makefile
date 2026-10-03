# macOS 공용 네이티브 라이브러리.
#
# src/ 의 공용 소스를 정적 라이브러리 하나로 빌드하고, 사용하는 애플리케이션이 pkg-config 로
# 헤더와 라이브러리 위치를 찾도록 soksak-darwin.pc 를 생성한다. 위치는 빌드 디렉터리의 절대 경로다. 빌드마다
# 내용을 다시 만들고 내용이 바뀔 때만 파일을 다시 쓰므로, 작업 공간을 옮기면 새 위치를 가리키고 옮기지
# 않으면 파일이 그대로 남는다.
#
#   make          build/libsoksak-darwin.a, build/soksak-darwin.pc
#   make test             입력 주입, 창 상태, 창 단추 배치, 표시 대기, 웹뷰 초점, 문서 영역, 그림 영역, 닫은 창의 해제 검사를 실행한다. 애플리케이션을 활성화하지 않는다
#   make test-activation  창 활성화 후 호버 검사, 겹친 웹뷰 입력 검사(기준 실행·등록 실행), 웹 인스펙터 검사, 문서 영역의 OS 이벤트 대기열 클릭·키 검사, 그림 영역의 한국어 입력기 조합 검사를
#                         실행한다. 애플리케이션을 활성화해 포커스를 가져간다
#   make repeat TEST=<name>_test COUNT=<n>
#                         test 대상 검사 하나를 연속 n번 실행하고 첫 실패에서 실행 번호와 시스템 부하를 보고한다
#   make repeat-suite COUNT=<n>
#                         test 대상 전체를 연속 n번 실행하고 첫 실패에서 실행 번호와 시스템 부하를 보고한다

SHELL := /bin/sh

SOURCES    := $(wildcard src/*.m)
BUILD      := $(CURDIR)/build
OBJECTS    := $(SOURCES:src/%.m=$(BUILD)/%.o)
LIBRARY    := $(BUILD)/libsoksak-darwin.a
PKGCONFIG  := $(BUILD)/soksak-darwin.pc
FRAMEWORKS := -framework Cocoa -framework WebKit -framework QuartzCore -framework CoreImage -framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo -framework IOSurface -framework Carbon -framework UserNotifications -lcompression -lz
# 소스가 사용하는 가장 새로운 API 는 macOS 14.4 의 것이다(capture.m 의
# getCurrentProcessShareableContentWithCompletionHandler).
# 사용하는 빌드가 같은 최소 버전으로 컴파일·링크하도록 .pc 의 Cflags 와 Libs 에도 넣는다.
MINIMUM    := -mmacosx-version-min=14.4
CFLAGS     := -fblocks -fmodules -Wall -Werror -O2 $(MINIMUM)

.PHONY: all test test-activation repeat repeat-suite clean pkgconfig-current

all: $(LIBRARY) $(PKGCONFIG)

$(BUILD)/%.o: src/%.m $(wildcard src/*.h src/private/*.h) Makefile | $(BUILD)
	@clang $(CFLAGS) -c $< -o $@

$(LIBRARY): $(OBJECTS)
	@rm -f $@
	@ar rcs $@ $^

# 파일 내용은 현재 위치에서 결정되므로 매 빌드 비교한다. pkgconfig-current 는 이 비교를 요구하는 표지다.
$(PKGCONFIG): pkgconfig-current | $(BUILD)
	@printf '%s\n' \
	  'Name: soksak-darwin' \
	  'Description: Shared macOS window, webview, and surface layout code' \
	  'Version: 0.0.2' \
	  'Cflags: -I$(CURDIR)/src $(MINIMUM)' \
	  'Libs: -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) $(MINIMUM)' > $@.next
	@if cmp -s $@.next $@; then rm $@.next; else mv $@.next $@; fi

$(BUILD):
	@mkdir -p $@

# 모든 검사는 tests/support/no_activation.m 을 링크한다. 활성화를 선언하지 않은 검사는 종료할 때 활성이면 실패한다.
$(BUILD)/%_test: tests/%_test.m tests/support/no_activation.m $(LIBRARY) $(wildcard src/*.h src/private/*.h tests/support/*.h tests/support/*.m)
	@clang $(CFLAGS) -I$(CURDIR)/src $< tests/support/no_activation.m -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

# 수용 검사 본문을 포함하는 검사는 그 본문이 바뀌면 다시 빌드한다.
$(BUILD)/capture_checker_test $(BUILD)/capture_file_checker_test $(BUILD)/capture_lifecycle_test $(BUILD)/capture_directory_checker_test: tests/capture_test.m

# 알림 센터는 번들에서 실행된 프로세스만 받으므로 알림 검사는 번들 안에서도 실행한다.
$(BUILD)/notifications_test.app/Contents/MacOS/notifications_test: $(BUILD)/notifications_test tests/support/notifications_test.plist
	@mkdir -p $(dir $@)
	@cp tests/support/notifications_test.plist $(BUILD)/notifications_test.app/Contents/Info.plist
	@cp $< $@

$(BUILD)/capture_file_checker_test: tests/capture_test.m

$(BUILD)/capture_checker_test: tests/capture_test.m

$(BUILD)/capture_lifecycle_test: tests/capture_test.m src/capture.m

$(BUILD)/capture_callback_test: src/capture.m

$(BUILD)/capture_cleanup_test: src/capture.m

$(BUILD)/capture_preparation_test: src/capture.m

$(BUILD)/capture_pressure_test: src/capture.m

$(BUILD)/capture_storage_test: src/capture.m

$(BUILD)/capture_metadata_test: src/capture.m

$(BUILD)/capture_resize_test: src/capture.m

test: $(BUILD)/capture_callback_test $(BUILD)/capture_cleanup_test $(BUILD)/capture_preparation_test $(BUILD)/capture_lifecycle_test $(BUILD)/capture_cycles_test $(BUILD)/capture_stop_late_test $(BUILD)/capture_directory_checker_test $(BUILD)/capture_frame_test $(BUILD)/capture_storage_test $(BUILD)/capture_metadata_test $(BUILD)/capture_resize_test $(BUILD)/capture_file_checker_test $(BUILD)/capture_checker_test $(BUILD)/capture_pressure_test $(BUILD)/webview_input_receipts_test $(BUILD)/notifications_test.app/Contents/MacOS/notifications_test $(BUILD)/window_motion_test $(BUILD)/input_inject_test $(BUILD)/window_facts_test $(BUILD)/window_controls_test $(BUILD)/surface_layout_test $(BUILD)/webview_focus_test $(BUILD)/webview_geometry_test $(BUILD)/webview_process_test $(BUILD)/document_view_test $(BUILD)/image_region_test $(BUILD)/ui_queue_test $(BUILD)/surface_host_test $(BUILD)/clipboard_test $(BUILD)/link_test $(BUILD)/capture_test $(BUILD)/dock_menu_test $(BUILD)/appearance_test $(BUILD)/window_occlusion_test $(BUILD)/window_reveal_test $(BUILD)/window_release_test
	@$(BUILD)/surface_host_test
	@$(BUILD)/ui_queue_test
	@$(BUILD)/window_motion_test
	@$(BUILD)/input_inject_test
	@$(BUILD)/webview_input_receipts_test
	@$(BUILD)/window_facts_test
	@$(BUILD)/window_occlusion_test
	@$(BUILD)/window_reveal_test
	@$(BUILD)/window_release_test
	@$(BUILD)/window_controls_test
	@$(BUILD)/surface_layout_test
	@$(BUILD)/webview_focus_test
	@$(BUILD)/webview_geometry_test
	@$(BUILD)/webview_process_test
	@$(BUILD)/document_view_test
	@$(BUILD)/image_region_test
	@$(BUILD)/clipboard_test
	@$(BUILD)/link_test
	@$(BUILD)/capture_test
	@$(BUILD)/capture_checker_test
	@$(BUILD)/capture_file_checker_test
	@$(BUILD)/capture_directory_checker_test
	@$(BUILD)/capture_lifecycle_test
	@$(BUILD)/capture_cycles_test
	@$(BUILD)/capture_stop_late_test
	@$(BUILD)/capture_callback_test
	@$(BUILD)/capture_cleanup_test
	@$(BUILD)/capture_preparation_test
	@$(BUILD)/capture_pressure_test
	@$(BUILD)/capture_storage_test
	@$(BUILD)/capture_metadata_test
	@$(BUILD)/capture_resize_test
	@$(BUILD)/capture_frame_test
	@$(BUILD)/dock_menu_test
	@$(BUILD)/appearance_test
	@$(BUILD)/notifications_test
	@$(BUILD)/notifications_test.app/Contents/MacOS/notifications_test --bundled

test-activation: $(BUILD)/input_activate_test $(BUILD)/webview_input_test $(BUILD)/webview_inspector_test $(BUILD)/window_fullscreen_test $(BUILD)/document_view_test $(BUILD)/image_region_ime_test
	@$(BUILD)/input_activate_test
	@$(BUILD)/webview_inspector_test
	@$(BUILD)/window_fullscreen_test
	@$(BUILD)/webview_input_test --baseline
	@$(BUILD)/webview_input_test
	@$(BUILD)/document_view_test --activation
	@$(BUILD)/image_region_test --activation
	@$(BUILD)/image_region_ime_test

repeat: $(BUILD)/$(TEST)
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat requires TEST=<name>_test and a positive COUNT" >&2; exit 2;; esac
	@i=1; while [ $$i -le $(COUNT) ]; do \
	  $(BUILD)/$(TEST) > /dev/null || { echo "FAIL: $(TEST) run $$i of $(COUNT) ($$(uptime))" >&2; exit 1; }; \
	  i=$$((i + 1)); \
	done; echo "PASS: $(TEST) passed $(COUNT) consecutive runs"

repeat-suite:
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-suite requires a positive COUNT" >&2; exit 2;; esac
	@i=1; while [ $$i -le $(COUNT) ]; do \
	  $(MAKE) --no-print-directory test > /dev/null || { echo "FAIL: test suite run $$i of $(COUNT) ($$(uptime))" >&2; exit 1; }; \
	  i=$$((i + 1)); \
	done; echo "PASS: test suite passed $(COUNT) consecutive runs"

clean:
	@rm -rf $(BUILD)
