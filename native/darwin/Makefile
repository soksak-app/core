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
#                         webview focus, view focus, document region, image region, release of a closed window, and window object count.
#                         It does not activate the application
#   make test-activation  runs the hover check after window activation, the overlapping webview input check (baseline run and
#                         registered run), the web inspector check, the OS event queue click and key check of the document region,
#                         the Korean input method composition check of the image region, and the activated view-focus page/key check.
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
#   make repeat-activation-backspace COUNT=<n>
#                         runs the focused ABC-baseline eight-k, Backspace and Space activation target in separate processes, stopping at the first failure
#   make test-ime-source-restoration
#                         checks the input-source baseline setup and cleanup ordering with controlled callbacks; it does not activate
#   make repeat-suite COUNT=<n>
#                         runs the whole test target n times in a row and reports the run number and the system load at the first failure

SHELL := /bin/sh

SOURCES    := $(wildcard src/*.m)
BUILD      := $(CURDIR)/build
PROCESS_IDENTITY_LIBRARY := $(CURDIR)/process-identity/lib/libsoksak-process-identity.a
OBJECTS    := $(SOURCES:src/%.m=$(BUILD)/%.o)
LIBRARY    := $(BUILD)/libsoksak-darwin.a
PKGCONFIG  := $(BUILD)/soksak-darwin.pc
FRAMEWORKS := -framework Cocoa -framework WebKit -framework QuartzCore -framework CoreImage -framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo -framework IOSurface -framework Carbon -framework UserNotifications -lcompression -lz -lc++
ZXING_COMMIT := 287c85df6f961c8efbfb5ffd736cd9457b8b890e
ZXING_URL := https://codeload.github.com/zxing-cpp/zxing-cpp/tar.gz/$(ZXING_COMMIT)
ZXING_SHA256 := 97d952c661b1f79d21aacc2ec544ef05c4d1465f55692cc49622ea6a8166ca7b
ZXING_RELEASE_FILE := $(BUILD)/zxing-cpp-$(ZXING_COMMIT).tar.gz
ZXING_SOURCE := $(BUILD)/zxing-cpp-$(ZXING_COMMIT)
ZXING_BUILD := $(BUILD)/zxing-cpp-build
ZXING_INSTALL := $(BUILD)/zxing-cpp-install
ZXING_LIBRARY := $(ZXING_INSTALL)/lib/libZXing.a
# The newest API the sources use is from macOS 14.4 (getCurrentProcessShareableContentWithCompletionHandler in
# capture.m).
# The same minimum version is also put in Cflags and Libs of the .pc so that the builds that use it compile and link
# with it.
MINIMUM    := -mmacosx-version-min=14.4
CFLAGS     := -fblocks -fmodules -Wall -Werror -O2 $(MINIMUM)
DIAGNOSTIC ?= 1
ifeq ($(DIAGNOSTIC),1)
CFLAGS     += -DSOKSAK_DIAGNOSTIC
endif

.PHONY: all capture-text-path test test-capture-frame-identity test-capture-stop-intake test-activation test-view-focus-restore test-activation-backspace repeat-activation-backspace build-ime-activation-target test-ime-cli test-activation-backspace-reference test-ime-source-restoration test-ime-wire-document benchmark benchmark-document benchmark-page-layers benchmark-occlusion benchmark-view-processes benchmark-region-cost repeat repeat-suite clean pkgconfig-current

all: $(LIBRARY) $(PKGCONFIG)

$(BUILD)/%.o: src/%.m $(wildcard src/*.h src/private/*.h) Makefile $(ZXING_LIBRARY) | $(BUILD)
	@clang $(CFLAGS) -I$(ZXING_INSTALL)/include -c $< -o $@

$(ZXING_RELEASE_FILE): | $(BUILD)
	@set -eu; curl -L --fail --show-error $(ZXING_URL) -o $@.part; \
	  printf '%s  %s\n' '$(ZXING_SHA256)' '$@.part' | shasum -a 256 -c -; \
	  mv $@.part $@

$(ZXING_SOURCE)/LICENSE: $(ZXING_RELEASE_FILE) | $(BUILD)
	@mkdir -p $(ZXING_SOURCE)
	@tar -xzf $(ZXING_RELEASE_FILE) --strip-components=1 -C $(ZXING_SOURCE)
	@test -f $@

$(ZXING_LIBRARY): $(ZXING_SOURCE)/LICENSE
	@cmake -S $(ZXING_SOURCE)/core -B $(ZXING_BUILD) \
	  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=14.4 \
	  -DCMAKE_INSTALL_PREFIX=$(ZXING_INSTALL) -DBUILD_SHARED_LIBS=OFF \
	  -DZXING_READERS=ON -DZXING_WRITERS=OFF -DZXING_C_API=ON \
	  -DZXING_ENABLE_1D=OFF -DZXING_ENABLE_AZTEC=OFF -DZXING_ENABLE_DATAMATRIX=OFF \
	  -DZXING_ENABLE_MAXICODE=OFF -DZXING_ENABLE_PDF417=OFF -DZXING_ENABLE_QRCODE=ON
	@cmake --build $(ZXING_BUILD) --config Release --target ZXing -j 4
	@cmake --install $(ZXING_BUILD) --config Release
	@mkdir -p $(ZXING_INSTALL)/share/licenses/ZXing
	@cp $(CURDIR)/THIRD_PARTY_LICENSES/ZXing-LICENSE.txt $(ZXING_INSTALL)/share/licenses/ZXing/LICENSE
	@test -f $(ZXING_LIBRARY)

$(LIBRARY): $(OBJECTS) $(ZXING_LIBRARY)
	@rm -f $@
	@libtool -static -o $@ $(OBJECTS) $(ZXING_LIBRARY)

# The file content depends on the current location, so every build compares it. pkgconfig-current marks that this
# comparison is required.
$(PKGCONFIG): pkgconfig-current | $(BUILD)
	@printf '%s\n' \
	  'Name: soksak-darwin' \
	  'Description: Shared macOS window, webview, and surface layout code' \
	  'Version: 0.0.21' \
	  'Cflags: -I$(CURDIR)/src $(MINIMUM)' \
	  'Libs: -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) $(MINIMUM)' > $@.next
	@if cmp -s $@.next $@; then rm $@.next; else mv $@.next $@; fi

$(BUILD):
	@mkdir -p $@

# Every check links tests/support/no_activation.m. A check that does not declare activation fails if the application
# is active when it exits.
$(PROCESS_IDENTITY_LIBRARY):
	@$(MAKE) -C $(CURDIR)/process-identity all

$(BUILD)/%_test: tests/%_test.m tests/support/no_activation.m $(LIBRARY) $(PROCESS_IDENTITY_LIBRARY) $(wildcard src/*.h src/private/*.h tests/support/*.h tests/support/*.m)
	@clang $(CFLAGS) -I$(CURDIR)/process-identity/include -DVIEW_PAGE_CASES='"$(VIEW_PAGE_CASES)"' -I$(CURDIR)/src -I$(CURDIR)/tests $< tests/support/no_activation.m tests/support/records.m tests/support/temporary_folder.m tests/support/view_import_map.m -L$(BUILD) -lsoksak-darwin -L$(CURDIR)/process-identity/lib -lsoksak-process-identity $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

# Vision reads captured pixels only in this check executable, outside application rendering.
$(BUILD)/capture_text_test: tests/capture_text_test.m tests/support/no_activation.m | $(BUILD)
	@clang $(CFLAGS) $< tests/support/no_activation.m -framework Foundation -framework AppKit -framework Vision -framework CoreText -o $@

capture-text-path: $(BUILD)/capture_text_test
	@printf '%s\n' '$(abspath $(BUILD)/capture_text_test)'

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

$(BUILD)/capture_stop_intake_test: src/capture.m

$(BUILD)/capture_cleanup_test: src/capture.m

$(BUILD)/capture_preparation_test: src/capture.m

$(BUILD)/capture_pressure_test: src/capture.m

$(BUILD)/capture_storage_test: src/capture.m

$(BUILD)/capture_metadata_test: src/capture.m

$(BUILD)/capture_resize_test: src/capture.m

$(BUILD)/capture_presentation_test: tests/capture_presentation_test.m $(BUILD)/libsoksak-darwin.a $(wildcard src/*.h src/private/*.h)
	@clang $(CFLAGS) -I$(CURDIR)/src -I$(CURDIR)/tests $< tests/support/no_activation.m -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) -framework Metal -framework Network $(MINIMUM) -o $@

$(BUILD)/image_capture_match_test: tests/image_capture_match_test.m $(BUILD)/libsoksak-darwin.a $(wildcard src/*.h src/private/*.h)
	@clang $(CFLAGS) -I$(CURDIR)/src $< tests/support/no_activation.m -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

$(BUILD)/capture_frame_identity_test: tests/capture_frame_identity_test.m $(BUILD)/libsoksak-darwin.a $(wildcard src/*.h src/private/*.h)
	@clang $(CFLAGS) -I$(CURDIR)/src $< -L$(BUILD) -lsoksak-darwin $(FRAMEWORKS) $(MINIMUM) -o $@

# The native tests in the order they run: executables of the build folder, with an argument after a comma. They run one at a time
# through the test runner (scripts/native-tests.mjs), which writes the start, the end and the elapsed time of each; NATIVE_TEST_ONLY=<text>
# runs only the entries that contain the text.
NATIVE_TESTS = observe_test \
  ime_cli_test \
  image_region_input_transaction_test \
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
  input_reference_test \
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
  process_label_test \
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
  view_import_map_test \
  document_view_import_map_test \
  document_core_root_test \
  document_view_load_test \
  view_channel_test \
  view_focus_test \
  plugin_host_view_test \
  document_binary_test \
  document_typing_test \
  document_press_test \
  image_nonce_ownership_test \
  image_region_test \
  image_region_decoration_test \
  ime_reference_state_test \
  ime_source_restore_test \
  ime_wire_document_test \
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
  capture_stop_intake_test \
  capture_callback_test \
  capture_cleanup_test \
  capture_preparation_test \
  capture_pressure_test \
  capture_storage_test \
  capture_metadata_test \
  capture_presentation_test \
  image_capture_match_test \
  capture_frame_identity_test \
  capture_frame_identity_capture_test \
  capture_resize_test \
  capture_frame_test \
  capture_text_test \
  dock_menu_test \
  appearance_test \
  notifications_test \
  notifications_test.app/Contents/MacOS/notifications_test,--bundled

comma := ,
NATIVE_TEST_EXECUTABLES := $(foreach entry,$(NATIVE_TESTS),$(firstword $(subst $(comma), ,$(entry))))
NATIVE_TEST_RUNNER := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../../scripts/native-tests.mjs)
# The shared cases of the view page insertion, which the plugin-api test and the native tests run (docs/spec/plugin-processes.md, rule 4).
VIEW_PAGE_CASES := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../../packages/plugin-api/contract/view-page.json)

test: $(addprefix $(BUILD)/,$(NATIVE_TEST_EXECUTABLES))
	@node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) $(NATIVE_TESTS)

test-capture-frame-identity: $(BUILD)/capture_frame_identity_test
	@node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) capture_frame_identity_test

test-capture-stop-intake: $(BUILD)/capture_stop_intake_test
	@node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) capture_stop_intake_test

test-pressure: $(BUILD)/document_pressure_test
	@$(BUILD)/document_pressure_test

test-activation: $(BUILD)/input_activate_test $(BUILD)/webview_input_test $(BUILD)/webview_inspector_test $(BUILD)/window_fullscreen_test $(BUILD)/document_view_test $(BUILD)/image_region_ime_test $(BUILD)/view_focus_test
	@$(BUILD)/input_activate_test
	@$(BUILD)/webview_inspector_test
	@$(BUILD)/window_fullscreen_test
	@$(BUILD)/webview_input_test --baseline
	@$(BUILD)/webview_input_test
	@$(BUILD)/document_view_test --activation
	@$(BUILD)/image_region_test --activation
	@$(BUILD)/image_region_ime_test
	@$(BUILD)/view_focus_test --activation

test-view-focus-restore: $(BUILD)/view_focus_test
	@$(BUILD)/view_focus_test --frontmost-restore-test

# Focused Korean IME comparison. This records the outer input source and frontmost application, establishes ABC,
# activates the test application, selects Korean 2-set, and sends eight k keys, Backspace, and Space to an AppKit reference and an image region.
# Run only with approval for an activation-tier input check.
test-activation-backspace: $(BUILD)/image_region_ime_test $(BUILD)/ime_source_probe
	@SOKSAK_IME_SOURCE_PROBE="$(BUILD)/ime_source_probe" node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) image_region_ime_test,--backspace-trace-abc-baseline

# Build the activation executable without running it; the absolute prerequisite is the only supported build target.
build-ime-activation-target: $(BUILD)/image_region_ime_test $(BUILD)/ime_source_probe

test-ime-cli: $(BUILD)/ime_cli_test
	@node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) ime_cli_test

$(BUILD)/ime_cli_test: tests/ime_cli_test.m tests/support/ime_cli.m tests/support/ime_cli.h Makefile | $(BUILD)
	@clang -fblocks -Wall -Werror -O2 -mmacosx-version-min=14.4 -I$(CURDIR)/tests $< tests/support/ime_cli.m -o $@

# Repeat the focused activation variant and preserve each child output plus an independent source read after process exit.
repeat-activation-backspace: $(BUILD)/image_region_ime_test $(BUILD)/ime_source_probe
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-activation-backspace requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@set -eu; \
	  evidence_root=$$(mktemp -d "$${TMPDIR:-/tmp}/soksak-F239-47-8-activation-repeat.XXXXXX"); \
	  echo "EVIDENCE: $$evidence_root"; \
	  i=1; while [ $$i -le $(COUNT) ]; do \
	  run_dir="$$evidence_root/run-$$i"; mkdir -p "$$run_dir"; \
	  probe_folder="$$run_dir/source-probe-before"; mkdir -p "$$probe_folder"; \
	  SOKSAK_NATIVE_TEST_RUN_FOLDER="$$probe_folder" node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) ime_source_probe > "$$run_dir/source-probe-before-runner.log" 2>&1; \
	  node -e 'const fs=require("node:fs"); const path=require("node:path"); const root=process.argv[1]; const manifest=JSON.parse(fs.readFileSync(path.join(root,"manifest.json"),"utf8")); if(manifest.tests.length!==1||manifest.tests[0].status!=="pass") throw Error("source probe test did not pass"); const snapshot=JSON.parse(fs.readFileSync(path.join(root,manifest.tests[0].output),"utf8")); if(typeof snapshot.source!=="string"||!Number.isSafeInteger(snapshot.frontmostPID)||snapshot.frontmostPID<=0) throw Error("source probe returned invalid state"); process.stdout.write(JSON.stringify(snapshot)+"\n")' "$$probe_folder" > "$$run_dir/pre-run.json"; \
	  expected_source=$$(node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(x.source)' "$$run_dir/pre-run.json"); \
	  expected_pid=$$(node -e 'const x=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(x.frontmostPID))' "$$run_dir/pre-run.json"); \
	  if [ -z "$$expected_source" ] || [ "$$expected_pid" = "0" ]; then echo "FAIL: run $$i source or frontmost process is unavailable; evidence $$run_dir" >&2; exit 1; fi; \
	  echo "START: image_region_ime_test --backspace-trace-abc-baseline run $$i of $(COUNT)"; \
	  test_status=0; \
	  SOKSAK_NATIVE_TEST_RUN_FOLDER="$$run_dir/native" SOKSAK_IME_SOURCE_PROBE="$(BUILD)/ime_source_probe" SOKSAK_IME_EXPECTED_OUTER_SOURCE="$$expected_source" SOKSAK_IME_EXPECTED_OUTER_FRONTMOST_PID="$$expected_pid" node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) image_region_ime_test,--backspace-trace-abc-baseline || test_status=$$?; \
	  post_probe_folder="$$run_dir/source-probe-after"; mkdir -p "$$post_probe_folder"; \
	  probe_status=0; SOKSAK_NATIVE_TEST_RUN_FOLDER="$$post_probe_folder" node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) ime_source_probe > "$$run_dir/source-probe-after-runner.log" 2>&1 || probe_status=$$?; \
	  if [ $$probe_status -eq 0 ]; then node -e 'const fs=require("node:fs"); const path=require("node:path"); const root=process.argv[1]; const manifest=JSON.parse(fs.readFileSync(path.join(root,"manifest.json"),"utf8")); if(manifest.tests.length!==1||manifest.tests[0].status!=="pass") throw Error("source probe test did not pass"); const snapshot=JSON.parse(fs.readFileSync(path.join(root,manifest.tests[0].output),"utf8")); if(typeof snapshot.source!=="string"||!Number.isSafeInteger(snapshot.frontmostPID)||snapshot.frontmostPID<=0) throw Error("source probe returned invalid state"); process.stdout.write(JSON.stringify(snapshot)+"\n")' "$$post_probe_folder" > "$$run_dir/post-exit.json" || probe_status=$$?; else cat "$$run_dir/source-probe-after-runner.log"; fi; \
	  comparison_status=0; if [ $$probe_status -eq 0 ]; then node -e 'const fs=require("node:fs"); const before=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const after=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); const same=before.source===after.source && before.frontmostPID===after.frontmostPID; console.log((same?"PASS":"FAIL")+": post-exit source/app "+JSON.stringify(after)+" "+(same?"matches":"does not match")+" pre-run "+JSON.stringify(before)); process.exitCode=same?0:1' "$$run_dir/pre-run.json" "$$run_dir/post-exit.json" || comparison_status=$$?; else comparison_status=1; fi; \
	  if [ $$test_status -ne 0 ] || [ $$probe_status -ne 0 ] || [ $$comparison_status -ne 0 ]; then echo "FAIL: image_region_ime_test --backspace-trace-abc-baseline run $$i of $(COUNT); test=$$test_status probe=$$probe_status baseline=$$comparison_status evidence $$run_dir; load $$(uptime)" >&2; exit 1; fi; \
	  i=$$((i + 1)); \
	done; echo "PASS: image_region_ime_test --backspace-trace-abc-baseline passed $(COUNT) consecutive runs"

test-activation-backspace-reference: $(BUILD)/ime_reference_state_test
	@$(BUILD)/ime_reference_state_test

test-ime-source-restoration: $(BUILD)/ime_source_restore_test
	@$(BUILD)/ime_source_restore_test

$(BUILD)/image_region_ime_test: tests/image_region_ime_test.m tests/support/ime_cli.m tests/support/ime_cli.h tests/support/ime_source_restore.m tests/support/ime_source_restore.h Makefile $(LIBRARY) $(PROCESS_IDENTITY_LIBRARY) $(wildcard src/*.h src/private/*.h tests/support/*.h tests/support/*.m)
	@clang $(CFLAGS) -DVIEW_PAGE_CASES='"$(VIEW_PAGE_CASES)"' -I$(CURDIR)/process-identity/include -I$(CURDIR)/src -I$(CURDIR)/tests $< tests/support/ime_cli.m tests/support/ime_source_restore.m tests/support/no_activation.m tests/support/records.m tests/support/temporary_folder.m tests/support/view_import_map.m -L$(BUILD) -lsoksak-darwin -L$(CURDIR)/process-identity/lib -lsoksak-process-identity $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

$(BUILD)/ime_source_probe: tests/ime_source_probe.m Makefile | $(BUILD)
	@clang $(CFLAGS) $< $(FRAMEWORKS) -o $@

$(BUILD)/ime_source_restore_test: tests/ime_source_restore_test.m tests/support/ime_source_restore.m tests/support/ime_source_restore.h $(LIBRARY) $(PROCESS_IDENTITY_LIBRARY) $(wildcard src/*.h src/private/*.h tests/support/*.h tests/support/*.m)
	@clang $(CFLAGS) -I$(CURDIR)/process-identity/include -I$(CURDIR)/src -I$(CURDIR)/tests $< tests/support/ime_source_restore.m tests/support/no_activation.m -L$(BUILD) -lsoksak-darwin -L$(CURDIR)/process-identity/lib -lsoksak-process-identity $(FRAMEWORKS) -framework Network $(MINIMUM) -o $@

test-ime-wire-document: $(BUILD)/ime_wire_document_test
	@$(BUILD)/ime_wire_document_test

repeat: $(BUILD)/$(TEST)
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat requires TEST=<name>_test and a positive COUNT" >&2; exit 2;; esac
	@i=1; while [ $$i -le $(COUNT) ]; do \
	  echo "START: $(TEST) run $$i of $(COUNT)"; \
	  node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) $(TEST) || { echo "FAIL: $(TEST) run $$i of $(COUNT); load $$(uptime)" >&2; exit 1; }; \
	  i=$$((i + 1)); \
	done; echo "PASS: $(TEST) passed $(COUNT) consecutive runs"

# Each run of the suite is one run of scripts/native-tests.mjs over the suite, so every test is named, timed and limited as in test.
repeat-suite: $(addprefix $(BUILD)/,$(NATIVE_TEST_EXECUTABLES))
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-suite requires a positive COUNT" >&2; exit 2;; esac
	@i=1; while [ $$i -le $(COUNT) ]; do \
	  echo "START: test suite run $$i of $(COUNT)"; \
	  node $(NATIVE_TEST_RUNNER) $(abspath $(BUILD)) $(NATIVE_TESTS) || { echo "FAIL: test suite run $$i of $(COUNT) ($$(uptime))" >&2; exit 1; }; \
	  i=$$((i + 1)); \
	done; echo "PASS: test suite passed $(COUNT) consecutive runs"

clean:
	@rm -rf $(BUILD)
