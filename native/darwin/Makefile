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
#   make benchmark-occlusion
#                         prints the occlusion state and document.visibilityState of a window A with a web view that a
#                         window B covers fully: A at the top-left corner of the visible frame or away from it, B titled or
#                         borderless, with or without shadows, B the visible frame, the frame of A, or A grown by 20 to 96
#                         points. It orders both windows front without activating the application and asserts nothing
#   make test-pressure    runs the memory pressure check of the document region and of a plain web view. It raises the memory pressure
#                         of the system through memory_pressure, which needs the sudoers rule for /usr/bin/memory_pressure. It asserts
#                         the response of the region and refuses to judge when the 1-minute load is above 20. It prints the footprint
#                         and vmmap malloc zone rows and the collection state of the released array before and after the pressure
#   make benchmark-view-processes [COUNT=<n,n,...>]
#                         measures N plugin views of one window (default N = 1,5,10,20,40), each loading the same local page, in two
#                         variants: the default WebKit process assignment, and each view forced into its own WebContent process by
#                         _WKNavigationActionPolicyAllowInNewProcess. It prints the distinct process count, the total and the
#                         per-process footprint, and the time until every navigation finishes. After the views close, it prints
#                         the processes that exit within 10 seconds and the retained processes that stay alive, with their
#                         footprint, and then the reuse of the retained processes by a fresh set of views. It sends no signal to
#                         a WebContent process. It fails when a navigation does not finish within its limit, or when a WebContent
#                         process that the benchmark retained still exists after the benchmark exits
#   make benchmark-region-cost [URL=<address>] [LONG=<minutes>] [VARIANTS=<name,name>] [RELOAD=<count>] [COLLECTION=<minutes>] [PRESSURE=<level>]
#                         loads an address (default https://www.google.com/) in a 1200×760 window with a 1180×400 region in the
#                         variants of tests/region_cost_benchmark.m (plain web views with one setting each, a document region with no
#                         stream, and a document region with the element and request streams acknowledged). It prints the footprint
#                         total, WebKit malloc, graphics and JS JIT of each WebContent process at 10 and 60 seconds, the differences
#                         of each variant to U (the plain web view with the region's user agent), and the footprint and vmmap rows of
#                         the graphics and malloc allocations of R and U. It prints numbers and asserts nothing.
#                         With LONG (at least 6 minutes) it runs only U and S at the same time, each in its own window, both
#                         ordered front without activating the application. Each minute after the loads it prints a line per
#                         variant with the footprint total, the MALLOC dirty bytes, the WebKit malloc dirty bytes, and the graphics
#                         and JS JIT dirty bytes. At the end it prints the least-squares slope of the total in megabytes per minute
#                         over minutes 5 to LONG for U and S, and the difference S-U. It prints numbers and asserts nothing.
#                         VARIANTS (for example U,V1,V2,V3) measures only the named variants of the table. With RELOAD it runs U
#                         and then S, or the variants of VARIANTS, reloads the address RELOAD times in each (15 seconds apart), and
#                         prints the footprint total, MALLOC_SMALL, WebKit malloc, the load times and the heap counts of Text, HTMLDocument, CSSFontAccessor and NSCTFont after the first load,
#                         after the reloads, and after a simulated memory pressure level PRESSURE (warn, the default, or critical)
#                         set with sudo -n memory_pressure -S for 10 seconds
#                         With COLLECTION (at least 2 minutes) it runs U, R and S at the same time, each in a window ordered front
#                         without activating the application, and prints the load averages and, per variant, the footprint total,
#                         WebKit malloc and the heap counts of Text, HTMLDocument and the JSC:: classes every 2 minutes, and again
#                         after a simulated warn memory pressure of 10 seconds
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

.PHONY: all test test-activation benchmark benchmark-document benchmark-page-layers benchmark-occlusion benchmark-view-processes benchmark-region-cost repeat repeat-suite clean pkgconfig-current

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
	  'Version: 0.0.20' \
	  'Cflags: -I$(CURDIR)/src $(MINIMUM)' \
	  'Libs: -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) $(MINIMUM)' > $@.next
	@if cmp -s $@.next $@; then rm $@.next; else mv $@.next $@; fi

$(BUILD):
	@mkdir -p $@

# Every check links tests/support/no_activation.m. A check that does not declare activation fails if the application
# is active when it exits.
$(BUILD)/%_test: tests/%_test.m tests/support/no_activation.m $(LIBRARY) $(wildcard src/*.h src/private/*.h tests/support/*.h tests/support/*.m)
	@clang $(CFLAGS) -I$(CURDIR)/src -I$(CURDIR)/tests $< tests/support/no_activation.m tests/support/records.m tests/support/temporary_folder.m -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

# A measurement tool is not a test. It prints numbers, asserts nothing, and is not part of the test target.
$(BUILD)/%_benchmark: tests/%_benchmark.m tests/support/temporary_folder.m tests/support/temporary_folder.h $(LIBRARY) $(wildcard src/*.h src/private/*.h)
	@clang $(CFLAGS) -I$(CURDIR)/src -I$(CURDIR)/tests $< tests/support/temporary_folder.m -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

benchmark: $(BUILD)/event_ring_benchmark
	@$(BUILD)/event_ring_benchmark

benchmark-document: $(BUILD)/document_script_benchmark
	@$(BUILD)/document_script_benchmark

benchmark-page-layers: $(BUILD)/page_layers_benchmark
	@$(BUILD)/page_layers_benchmark

benchmark-occlusion: $(BUILD)/occlusion_corner_benchmark
	@$(BUILD)/occlusion_corner_benchmark

benchmark-view-processes: $(BUILD)/view_processes_benchmark
	@rm -f $(BUILD)/view-processes.pids
	@$(BUILD)/view_processes_benchmark --pid-file $(BUILD)/view-processes.pids $(if $(COUNT),--counts $(COUNT))
	@leftover=0; while read pid; do if kill -0 $$pid 2>/dev/null; then echo "FAIL: WebContent process $$pid remains after the benchmark exits"; leftover=1; fi; done < $(BUILD)/view-processes.pids; test $$leftover -eq 0

# The address of the region cost benchmark: make benchmark-region-cost URL=https://example.com/
URL ?= https://www.google.com/
benchmark-region-cost: $(BUILD)/region_cost_benchmark
	@$(BUILD)/region_cost_benchmark $(if $(URL),"$(URL)") $(if $(LONG),--long $(LONG)) $(if $(VARIANTS),--variants $(VARIANTS)) $(if $(RELOAD),--reload $(RELOAD)) $(if $(COLLECTION),--collection $(COLLECTION)) $(if $(PRESSURE),--pressure $(PRESSURE))

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
  memory_pressure_test \
  webview_navigation_test \
  window_controls_test \
  window_titlebar_layout_test \
  window_titlebar_reload_test \
  surface_layout_test \
  webview_focus_test \
  webview_geometry_test \
  webview_process_test \
  webview_process_end_test \
  webview_responsiveness_test \
  document_view_test \
  document_throttle_test \
  document_processes_test \
  document_caches_test \
  document_backforward_test \
  document_form_state_test \
  document_report_test \
  document_plugin_test \
  core_root_cors_test \
  document_core_root_test \
  document_view_load_test \
  view_channel_test \
  document_binary_test \
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

test-pressure: $(BUILD)/document_pressure_test
	@$(BUILD)/document_pressure_test

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
