# Shared native library for macOS.
#
# Builds the shared sources in src/ into one static library and generates soksak-darwin.pc so that the applications
# that use it find the header and library locations through pkg-config. The locations are absolute paths of the build
# directory. Every build regenerates the content and rewrites the file only when the content changes, so moving the
# workspace points the file at the new location and leaving it in place keeps the file unchanged.
#
#   make          build/libsoksak-darwin.a, build/soksak-darwin.pc
#   make test             runs the checks for input injection, mouse button observation, window state, window button layout,
#                         title bar height display inside a layout transaction, the start transaction of a re-read, display wait,
#                         webview focus, document region, image region, release of a closed window, and window object count.
#                         It does not activate the application
#   make test-activation  runs the hover check after window activation, the overlapping webview input check (baseline run and
#                         registered run), the web inspector check, the OS event queue click and key check of the document region,
#                         and the Korean input method composition check of the image region.
#                         It activates the application and takes the focus
#   make benchmark        measures the calling thread cost of one record (the current text record and the event ring). It prints numbers and asserts nothing
#   make benchmark-document
#                         measures the WebContent footprint and the state report bytes of a document region whose page changes a tree of 2000
#                         elements, at 0, 1000, 5000 and 10000 changes. It prints numbers and asserts nothing
#   make benchmark-page-layers
#                         measures the graphics footprint of the WebContent process of the main web view for six layer variants of
#                         the workbench page in a 1200×760 window (opaque, transparent with the fixed background, the paint clip, the
#                         rail overlay, a spinner, and no isolation), the median of three loads of each, and the difference of each
#                         to the baseline in window buffers.
#                         It prints numbers and asserts nothing
#   make repeat TEST=<name>_test COUNT=<n>
#                         runs one check of the test target n times in a row and reports the run number and the system load at the first failure
#   make repeat-suite COUNT=<n>
#                         runs the whole test target n times in a row and reports the run number and the system load at the first failure

SHELL := /bin/sh

SOURCES    := $(wildcard src/*.m)
BUILD      := $(CURDIR)/build
OBJECTS    := $(SOURCES:src/%.m=$(BUILD)/%.o)
LIBRARY    := $(BUILD)/libsoksak-darwin.a
PKGCONFIG  := $(BUILD)/soksak-darwin.pc
FRAMEWORKS := -framework Cocoa -framework WebKit -framework QuartzCore -framework CoreImage -framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo -framework IOSurface -framework Carbon -framework UserNotifications -lcompression -lz
# The newest API the sources use is from macOS 14.4 (getCurrentProcessShareableContentWithCompletionHandler in
# capture.m).
# The same minimum version is also put in Cflags and Libs of the .pc so that the builds that use it compile and link
# with it.
MINIMUM    := -mmacosx-version-min=14.4
CFLAGS     := -fblocks -fmodules -Wall -Werror -O2 $(MINIMUM)

.PHONY: all test test-activation benchmark benchmark-document benchmark-page-layers repeat repeat-suite clean pkgconfig-current

all: $(LIBRARY) $(PKGCONFIG)

$(BUILD)/%.o: src/%.m $(wildcard src/*.h src/private/*.h) Makefile | $(BUILD)
	@clang $(CFLAGS) -c $< -o $@

$(LIBRARY): $(OBJECTS)
	@rm -f $@
	@ar rcs $@ $^

# The file content depends on the current location, so every build compares it. pkgconfig-current marks that this
# comparison is required.
$(PKGCONFIG): pkgconfig-current | $(BUILD)
	@printf '%s\n' \
	  'Name: soksak-darwin' \
	  'Description: Shared macOS window, webview, and surface layout code' \
	  'Version: 0.0.18' \
	  'Cflags: -I$(CURDIR)/src $(MINIMUM)' \
	  'Libs: -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) $(MINIMUM)' > $@.next
	@if cmp -s $@.next $@; then rm $@.next; else mv $@.next $@; fi

$(BUILD):
	@mkdir -p $@

# Every check links tests/support/no_activation.m. A check that does not declare activation fails if the application
# is active when it exits.
$(BUILD)/%_test: tests/%_test.m tests/support/no_activation.m $(LIBRARY) $(wildcard src/*.h src/private/*.h tests/support/*.h tests/support/*.m)
	@clang $(CFLAGS) -I$(CURDIR)/src -I$(CURDIR)/tests $< tests/support/no_activation.m tests/support/records.m -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

# A measurement tool is not a test. It prints numbers, asserts nothing, and is not part of the test target.
$(BUILD)/%_benchmark: tests/%_benchmark.m $(LIBRARY) $(wildcard src/*.h src/private/*.h)
	@clang $(CFLAGS) -I$(CURDIR)/src $< -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

benchmark: $(BUILD)/event_ring_benchmark
	@$(BUILD)/event_ring_benchmark

benchmark-document: $(BUILD)/document_script_benchmark
	@$(BUILD)/document_script_benchmark

benchmark-page-layers: $(BUILD)/page_layers_benchmark
	@$(BUILD)/page_layers_benchmark

# A check that includes the acceptance check body is rebuilt when that body changes.
$(BUILD)/capture_checker_test $(BUILD)/capture_file_checker_test $(BUILD)/capture_lifecycle_test $(BUILD)/capture_directory_checker_test: tests/capture_test.m

# Notification Center accepts only processes started from a bundle, so the notification check also runs inside a
# bundle.
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

# The native tests in the order they run: executables of the build folder, with an argument after a comma. They run one at a time
# through the test runner (scripts/native-tests.mjs), which writes the start, the end and the elapsed time of each; NATIVE_TEST_ONLY=<text>
# runs only the entries that contain the text.
NATIVE_TESTS = observe_test \
  image_region_hangul_test \
  activity_observers_test \
  activity_observers_allocation_test \
  application_log_test \
  application_log_fatal_test \
  event_ring_test \
  surface_host_test \
  ui_queue_test \
  window_motion_test \
  input_inject_test \
  mouse_buttons_test \
  webview_input_receipts_test \
  webview_input_records_test \
  window_facts_test \
  window_occlusion_test \
  window_reveal_test \
  window_release_test \
  modal_release_test \
  window_objects_test \
  page_objects_test \
  process_exit_test \
  quit_request_test \
  webview_navigation_test \
  window_controls_test \
  window_titlebar_layout_test \
  window_titlebar_reload_test \
  surface_layout_test \
  webview_focus_test \
  webview_geometry_test \
  webview_process_test \
  webview_process_end_test \
  document_view_test \
  document_throttle_test \
  document_processes_test \
  document_caches_test \
  document_plugin_test \
  document_typing_test \
  document_press_test \
  image_region_test \
  input_source_test \
  clipboard_test \
  link_test \
  diagnostic_reports_test \
  capture_test \
  capture_checker_test \
  capture_file_checker_test \
  capture_directory_checker_test \
  capture_lifecycle_test \
  capture_cycles_test \
  capture_stop_late_test \
  capture_callback_test \
  capture_cleanup_test \
  capture_preparation_test \
  capture_pressure_test \
  capture_storage_test \
  capture_metadata_test \
  capture_resize_test \
  capture_frame_test \
  dock_menu_test \
  appearance_test \
  notifications_test \
  notifications_test.app/Contents/MacOS/notifications_test,--bundled

comma := ,
NATIVE_TEST_EXECUTABLES := $(foreach entry,$(NATIVE_TESTS),$(firstword $(subst $(comma), ,$(entry))))
NATIVE_TEST_RUNNER := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../../scripts/native-tests.mjs)

test: $(addprefix $(BUILD)/,$(NATIVE_TEST_EXECUTABLES))
	@node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) $(NATIVE_TESTS)

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
