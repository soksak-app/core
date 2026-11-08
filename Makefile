SHELL := /bin/sh

.PHONY: check-push check-events benchmark-rust benchmark-go check-tools install build test-all check-browser-example check-docs check-commits check-checklist-history install-hooks check-boundaries check-platform-files check-windows-build check-windows-rust check-host-files check-app-tests create-test-certificates test-app-card-sidebar-current test-app-terminal-focus-current test-app-shutdown benchmark-view-drag benchmark-resize-catch-up benchmark-empty-window benchmark-idle-tab benchmark-split-load repeat-app-test benchmark-b3 check-b3 check-exposure check-tests check-hosts-same test-language check-release test-rust-alone repeat-rust repeat-go repeat-node check-temp-files measure-page-memory measure-object-counts measure-host-calls measure-app-usage measure-terminal-redraw measure-trace-share measure-host-allocations check-app-update check-host-debug check-commands test-headless-owners

check-docs:
	@node scripts/check-docs.mjs
	@node scripts/check-failure-table.mjs
	@node scripts/check-private-apis.mjs
	@pnpm exec sok-check docs

.PHONY: check-host-callbacks create-host-callbacks
.PHONY: test-host-callback-worker
test-host-callback-worker: check-host-callbacks
	@$(MAKE) -C native/darwin build-host-callback-worker
	@CGO_ENABLED=0 SOKSAK_NATIVE_CALLBACK_WORKER_LIBRARY='$(abspath native/darwin/build/libhost_callback_worker.dylib)' $(MAKE) repeat-go PACKAGE=./packages/host/mygo/tests/platform/darwin/nativeworker COUNT=1

.PHONY: test-host-callbacks
test-host-callbacks: check-host-callbacks
	@$(MAKE) -C native/darwin build-host-callback-abi
	@CGO_ENABLED=0 SOKSAK_NATIVE_CALLBACK_ABI_LIBRARY='$(abspath native/darwin/build/libhost_callback_abi.dylib)' $(MAKE) repeat-go PACKAGE=./packages/host/mygo/tests/platform/darwin/nativecallback COUNT=1 TAGS=diagnostics

check-host-callbacks:
	@node scripts/check-host-callbacks.mjs

create-host-callbacks:
	@node scripts/check-host-callbacks.mjs --write

# Checks the names of the executables and make targets of this repository (AGENTS.md Implementation).
check-commands:
	@pnpm exec sok-check commands

# Checks the commit message form of RANGE, which holds one or more revision ranges separated by spaces. Example: make check-commits RANGE=origin/main..HEAD
check-commits:
	@test -n "$(RANGE)" || { echo "make check-commits RANGE=<revision range>" >&2; exit 2; }
	@pnpm exec sok-check commits $(RANGE)

# Checks that each commit of RANGE, which holds one or more revision ranges separated by spaces, keeps every closed checklist item closed and
# removes an open item only through a retirement record of the changelog pair. Example: make check-checklist-history RANGE=origin/main..HEAD
check-checklist-history:
	@test -n "$(RANGE)" || { echo "make check-checklist-history RANGE=<revision range>" >&2; exit 2; }
	@pnpm exec sok-check docs --range "$(RANGE)"

# Sets the git hook folder of this checkout to .githooks. The commit-msg hook checks the commit message form.
install-hooks:
	@git config core.hooksPath .githooks

# Runs before a push (the pre-push hook of `make install-hooks`): the commit messages of RANGE, because a published commit message is kept,
# and the checklist history of RANGE, because a published commit that reopens a closed item or removes an open one is kept too: the
# kit compares each commit of RANGE with its first parent, which the check of the working tree against HEAD does not see after a rebase.
# CI runs every other check on the pushed commits, a later commit corrects a failure, and the release gate releases only a green run.
# The pre-push hook sets RANGE to the commits of each pushed ref (scripts/push-range.mjs). Without RANGE, the commits are origin/main..HEAD:
# the commits that the remote main branch does not have. This range exists on every branch, while @{upstream}..HEAD fails with git exit 128
# on a branch without an upstream, which a new branch has until its first push.
check-push:
	@$(MAKE) --no-print-directory check-commits RANGE="$(or $(RANGE),origin/main..HEAD)"
	@$(MAKE) --no-print-directory check-checklist-history RANGE="$(or $(RANGE),origin/main..HEAD)"

# Builds release and checks that the staged frontend and the release executables hold no diagnostic code.
check-release: build-wailsv3-release build-tauriv2-release build-mygo-release
	@node scripts/check-release.mjs --macos-minimum $(MACOS_MINIMUM) --wailsv3-bundle "$(WAILS_RELEASE_BUNDLE)" --tauriv2-bundle "$(TAURI_RELEASE_BUNDLE)" --mygo-bundle "$(MYGO_RELEASE_BUNDLE)"

# Measures the memory of the main page process of a running application at start, idle, and after reload (docs/operations/examples.md).
# APP is wailsv3, tauriv2 or mygo, CONFIG is the configuration folder of that application, BUILD is release (default) or debug. A window of the
# mygo host has no main page, and the measurement fails with "the mygo host has no main page".
# HOST is wailsv3 or tauriv2. Checks with a copy of the built debug bundle that an application update replaces the bundle.
check-app-update:
	@case "$(HOST)" in wailsv3|tauriv2|mygo) ;; *) echo "check-app-update requires HOST=wailsv3|tauriv2|mygo" >&2; exit 2;; esac
	@node scripts/check-app-update.mjs --host $(HOST) --bundle target/debug/sok-$(HOST).app --registry target/registry/index.json

measure-page-memory:
	@case "$(APP)" in wailsv3|tauriv2|mygo) ;; *) echo "measure-page-memory requires APP=wailsv3|tauriv2|mygo CONFIG=DIR [BUILD=release|debug] [MINUTES=60] [RELOADS=20]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "measure-page-memory requires CONFIG=DIR" >&2; exit 2;; esac
	@case "$(BUILD)" in ''|release|debug) ;; *) echo "measure-page-memory requires BUILD=release|debug" >&2; exit 2;; esac
	@node scripts/measure-page-memory.mjs --sok $(if $(filter debug,$(BUILD)),target/debug/sok-$(APP).app,target/release/$(APP)/soksak.app)/Contents/MacOS/sok --config-dir "$(CONFIG)" --idle-minutes $(or $(MINUTES),60) --reloads $(or $(RELOADS),20)

# Sets the trace state TRACE, repeats the operations of scripts/measure-object-counts.mjs for the surface plugins PLUGINS REPETITIONS times against a
# running diagnostic build and prints the object counts, the Go runtime figures and the footprints of the host, page and document processes per
# repetition (docs/operations/examples.md#page-memory); a window of the mygo host has no page process. The diagnostic methods exist only in
# diagnostic builds, so BUILD defaults to debug. B3_OUT=FILE, with at least 30 repetitions, writes the B3 output of S3 to FILE.
measure-object-counts:
	@case "$(APP)" in wailsv3|tauriv2|mygo) ;; *) echo "measure-object-counts requires APP=wailsv3|tauriv2|mygo CONFIG=DIR PLUGINS='ID...' TRACE=0|1 [BUILD=release|debug] [REPETITIONS=20] [B3_OUT=FILE]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "measure-object-counts requires CONFIG=DIR" >&2; exit 2;; esac
	@case "$(strip $(PLUGINS))" in '') echo "measure-object-counts requires PLUGINS='ID...', the surface plugins whose tabs it opens" >&2; exit 2;; esac
	@case "$(BUILD)" in ''|debug|release) ;; *) echo "measure-object-counts requires BUILD=release|debug" >&2; exit 2;; esac
	@node scripts/measure-object-counts.mjs --sok $(if $(filter release,$(BUILD)),target/release/$(APP)/soksak.app,target/debug/sok-$(APP).app)/Contents/MacOS/sok --config-dir "$(CONFIG)" --trace "$(TRACE)" $(foreach plugin,$(PLUGINS),--plugin $(plugin)) --repetitions $(or $(REPETITIONS),20) $(if $(B3_OUT),--b3-out "$(B3_OUT)")

# Has the main page of a running diagnostic build send CALLS host calls ROUNDS times and prints the footprint of its page process before the calls, after
# them and after a collection (scripts/measure-host-calls.mjs); MINUTES=M waits M minutes without input instead of the calls;
# EVENTS=N has the host send N host events that the page does not listen to instead of the calls. The diagnostic methods exist only in diagnostic builds.
# A window of the mygo host has no main page, and the measurement fails with "the mygo host has no main page".
measure-host-calls:
	@case "$(APP)" in wailsv3|tauriv2|mygo) ;; *) echo "measure-host-calls requires APP=wailsv3|tauriv2|mygo CONFIG=DIR [CALLS=1000 | MINUTES=M | EVENTS=N] [ROUNDS=5]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "measure-host-calls requires CONFIG=DIR" >&2; exit 2;; esac
	@node scripts/measure-host-calls.mjs --sok target/debug/sok-$(APP).app/Contents/MacOS/sok --config-dir "$(CONFIG)" --calls $(or $(CALLS),1000) --idle-minutes $(or $(MINUTES),0) --events $(or $(EVENTS),0) --rounds $(or $(ROUNDS),5)

# Reports the CPU and memory of the running application of CONFIG_DIR by process: host, sidecars, pages, documents and WebKit processes
# (scripts/measure-app-usage.mjs, docs/operations/examples.md). TRACE=0 sets the trace off under the default log policy and TRACE=1 the trace
# on with the class frame at debug before the measurement; TRACE=frame-records, which needs STEP=pointer, sets the trace state of the frame
# records (scripts/measure-trace.mjs) for both moves of the pointer step. STATE prepares a state of the three-host benchmark B3 in a window of 1200 by 760
# points through declared commands (docs/operations/examples.md); IDLE=1 then waits for the cursor idle timeout of every term and terminal tab
# and for 3 seconds without a change of frames of host.window, and for the counts of the gate to be written before the first CPU reading; STEP=pointer measures a pointer move across the window with the moves of
# input.pointer, which take no permission and leave the cursor, in a window that is already the key window and not occluded. B3_OUT writes the B3 record of the
# measurement, its measurements and its conditions, to that file as JSON; one record holds the keys of one trace state, so with STEP=pointer
# TRACE=0|1 writes the keys of the first move without pointerMoveP90Ms and TRACE=frame-records writes pointerMoveP90Ms alone. SOK defaults to the sok binary of target/debug.
measure-app-usage:
	@case "$(CONFIG_DIR)" in '') echo "measure-app-usage requires CONFIG_DIR=DIR TRACE=0|1|frame-records [STATE=S0|S0b|S1|S9|S11|S12|S14|S15] [IDLE=1] [STEP=pointer] [B3_OUT=FILE] [INTERVAL=10] [SOK=PATH]" >&2; exit 2;; esac
	@case "$(IDLE)" in ''|1) ;; *) echo "measure-app-usage takes IDLE=1, not IDLE=$(IDLE)" >&2; exit 2;; esac
	@node scripts/measure-app-usage.mjs --sok $(or $(SOK),target/debug/sok) --config-dir "$(CONFIG_DIR)" --trace "$(TRACE)" --interval $(or $(INTERVAL),10) $(if $(STATE),--state "$(STATE)") $(if $(IDLE),--idle) $(if $(STEP),--step "$(STEP)") $(if $(B3_OUT),--b3-out "$(abspath $(B3_OUT))")

# Reports the CPU time of each process of the running application of CONFIG_DIR for each frame that the image region of a terminal tab
# presents while its program rewrites ROWS rows at RATE frames per second (scripts/measure-terminal-redraw.mjs, docs/operations/examples.md):
# after the trace state of TRACE=0|1, it opens one tab of PLUGIN, whose PLUGIN.input and PLUGIN.screen it uses, in a new project window of
# 760 by 614 points and divides the CPU time by the change of presentedFrames of the region of that tab. B3_OUT writes the B3 record of the
# measurement to that file as JSON. SOK defaults to the sok binary of target/debug.
measure-terminal-redraw:
	@case "$(CONFIG_DIR)" in '') echo "measure-terminal-redraw requires CONFIG_DIR=DIR PLUGIN=ID ROWS=N TRACE=0|1 [B3_OUT=FILE] [RATE=20] [INTERVAL=10] [SOK=PATH]" >&2; exit 2;; esac
	@node scripts/measure-terminal-redraw.mjs --sok $(or $(SOK),target/debug/sok) --config-dir "$(CONFIG_DIR)" --plugin "$(PLUGIN)" --rows "$(ROWS)" --trace "$(TRACE)" --rate $(or $(RATE),20) --interval $(or $(INTERVAL),10) $(if $(B3_OUT),--b3-out "$(abspath $(B3_OUT))")

# Measures the share of the diagnostics in the memory of a running host: in the trace state TRACE=1 and then TRACE=0 it runs five repetitions of
# measure-object-counts and prints the entry of the last repetition, which holds the footprint of the host process (docs/operations/examples.md).
measure-trace-share:
	@case "$(APP)" in wailsv3|tauriv2|mygo) ;; *) echo "measure-trace-share requires APP=wailsv3|tauriv2|mygo CONFIG=DIR PLUGINS='ID...'" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "measure-trace-share requires CONFIG=DIR" >&2; exit 2;; esac
	@for trace in 1 0; do \
	  echo "start TRACE=$$trace"; \
	  out=$$($(MAKE) --no-print-directory measure-object-counts APP=$(APP) CONFIG="$(CONFIG)" PLUGINS="$(PLUGINS)" TRACE=$$trace BUILD=debug REPETITIONS=5) || exit 1; \
	  last=$$(printf '%s\n' "$$out" | grep '^{"repetition":' | tail -1); \
	  test -n "$$last" || { echo "measure-trace-share: measure-object-counts printed no repetition for TRACE=$$trace" >&2; exit 1; }; \
	  echo "end TRACE=$$trace $$last"; \
	done

# Sets the trace state TRACE and prints the live malloc nodes and bytes of the host process of the running application of CONFIG_DIR, the process
# whose command line has --config-dir CONFIG_DIR, at start and after each minute (scripts/measure-host-allocations.mjs,
# docs/operations/examples.md), and the footprint of the host at each step and after it settles. SOK defaults to the sok binary of target/debug.
# B3_OUT=FILE, with at least 60 minutes, writes the B3 output of S4 to FILE.
measure-host-allocations:
	@case "$(CONFIG_DIR)" in '') echo "measure-host-allocations requires CONFIG_DIR=DIR TRACE=0|1 [MINUTES=10] [SOK=PATH] [B3_OUT=FILE]" >&2; exit 2;; esac
	@node scripts/measure-host-allocations.mjs --sok $(or $(SOK),target/debug/sok) --config-dir "$(CONFIG_DIR)" --trace "$(TRACE)" --minutes $(or $(MINUTES),10) $(if $(B3_OUT),--b3-out "$(B3_OUT)")

# Checks that core, plugin, and sidecar sources do not name each other.
check-boundaries:
	@node scripts/check-boundaries.mjs

# Checks that the sources name every event declared in docs/spec/events.json, and applies the event source rules of the kit to the sources (docs/spec/logging.md#event-sources):
# a source of occurrences has an event in its function or a reason marker, and a rule that waits for an entrance item is printed with its count. `--list` also prints each pending finding.
# The audit of the logs that window checks leave is `node scripts/check-events.mjs --logs <configuration folder>...` (docs/operations/examples.md).
check-events:
	@node scripts/check-events.mjs
	@pnpm exec sok-check events --config scripts/event-sources.json

# The TLS certificates of the registry window check (docs/operations/examples.md). Creates a certificate authority owned by the check and a server certificate for 127.0.0.1.
# openssl reads only the configuration file that the target writes, so no machine configuration adds an extension.
# The check application of a diagnostic build starts with --registry-ca <folder>/ca.pem. An existing certificate is not replaced. Each certificate,
# also an existing one, is parsed before the target ends, and a folder whose certificate does not parse is removed and the target fails, so a
# later run creates it again.
E2E_REGISTRY_TLS = $(or $(SOKSAK_CONFIG_ROOT),$(TMPDIR))/soksak-check-registry-tls
E2E_REGISTRY_TLS_PARSE = node -e 'const { X509Certificate } = require("node:crypto"); for (const file of process.argv.slice(1)) { try { new X509Certificate(require("node:fs").readFileSync(file)); } catch (error) { console.error(`$${file} holds no certificate: $${error.message}`); process.exit(1); } }'
create-test-certificates:
	@test -n "$(or $(SOKSAK_CONFIG_ROOT),$(TMPDIR))" || { echo "create-test-certificates needs TMPDIR or SOKSAK_CONFIG_ROOT" >&2; exit 2; }
	@if [ ! -f "$(E2E_REGISTRY_TLS)/ca.pem" ]; then \
	  set -e; mkdir -p "$(E2E_REGISTRY_TLS)"; cd "$(E2E_REGISTRY_TLS)"; \
	  printf '[req]\ndistinguished_name=name\nx509_extensions=authority\n[name]\n[authority]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' > tls.cnf; \
	  printf 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext; \
	  openssl version; \
	  openssl req -config tls.cnf -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=soksak check registry authority" -keyout ca-key.pem -out ca.pem; \
	  openssl req -config tls.cnf -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout server-key.pem -out server.csr; \
	  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3650 -extfile server.ext -out server.pem; \
	  rm -f server.csr ca.srl server.ext tls.cnf; fi
	@$(E2E_REGISTRY_TLS_PARSE) "$(E2E_REGISTRY_TLS)/ca.pem" "$(E2E_REGISTRY_TLS)/server.pem" || { rm -rf "$(E2E_REGISTRY_TLS)"; exit 1; }
	@echo "$(E2E_REGISTRY_TLS)"

# Checks that window checks use only the declared entries of the endpoint and native input.
# Opens a project in the staged browser example and checks with headless Chrome that no page error occurs.
check-browser-example: copy-frontend-browser
	@pnpm -F @soksak/browser check

# The browser example has no host, so the plugins of the pack that apps/browser/environment.json names in `install` are installed into
# BROWSER_CONFIG and the staging provides that installation as a host does (the staging layout of docs/spec/plugins.md).
BROWSER_CONFIG = target/browser-config

copy-frontend-browser: build-registry
	@rm -rf $(BROWSER_CONFIG)
	@target/debug/sok registry use $(REGISTRY)/index.json --config-dir $(BROWSER_CONFIG)
	@ids=$$(node -e "const env = require('$(CURDIR)/apps/browser/environment.json'); const pack = require('$(CURDIR)/$(REGISTRY)/index.json').packs.find((p) => p.name === env.install); if (!pack) throw new Error('apps/browser/environment.json install names no pack: ' + env.install); console.log(pack.plugins.join(' '))") || exit 1; for id in $$ids; do target/debug/sok plugin install $$id --config-dir $(BROWSER_CONFIG) || exit 1; done
	@pnpm -F @soksak/browser exec sok-copy-frontend build --installed $(CURDIR)/$(BROWSER_CONFIG)

run-browser: copy-frontend-browser
	@python3 -m http.server 8749 -d apps/browser/build

check-app-tests:
	@node scripts/check-app-tests.mjs

# Checks that UI operations run commands and that every displayed name is declared and registered.
check-exposure:
	@node scripts/check-exposure.mjs

# Checks the connection of the full source and test lists. It is separate from the result of behavior verification.
check-tests:
	@node scripts/check-tests.mjs

# Mechanically checks that the public API surfaces of the two hosts (call names, connections, endpoint methods) are the same (docs/spec/host-parity.md).
check-hosts-same:
	@node scripts/check-hosts-same.mjs

# JS/TS, Rust, Go, Objective-C, and shell test cases use the same observable case contract. Each case of a compiled language
# declares its build in scripts/language-test-cases.json, and the adapter runs it before the tests under a limit of its own.
# The cases build with the declared macOS minimum: go-env holds MACOSX_DEPLOYMENT_TARGET, which cargo also reads.
test-language: check-cargo
	@$(call go-env) node scripts/language-test-adapters.mjs scripts/language-test-cases.json

# Runs each test of a Rust package alone in a new process. Finds tests that depend on state another test created or on test order.
# Reports the test name at the first failure. MANIFEST is the Cargo.toml of the workspace that holds the package and FEATURES is the --features value of cargo.
MANIFEST ?= Cargo.toml
# The limit in seconds of one Rust test in test-rust-alone and repeat-rust; the runner kills a test at it (scripts/rust-tests.mjs).
TEST_TIMEOUT ?= 120
# The limit in seconds of one benchmark in benchmark-rust and benchmark-go; the runner kills a benchmark at it (scripts/benchmarks.mjs).
BENCH_TIMEOUT ?= 300
ifneq ($(origin TEST_TARGET),undefined)
export TEST_TARGET
endif
ifneq ($(origin RUST_PROFILE),undefined)
export RUST_PROFILE
endif
test-rust-alone: check-cargo
	@case "$(PACKAGE)" in '') echo "test-rust-alone requires PACKAGE=<cargo package> [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@$(CARGO_ENV) $(CARGO) test --locked -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --no-run
	@$(CARGO_ENV) node scripts/rust-tests.mjs --manifest $(MANIFEST) --package $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) $(if $(filter undefined,$(origin RUST_PROFILE)),,--profile "$$RUST_PROFILE") --count 1 --timeout $(TEST_TIMEOUT)

# Runs the tests of a Rust package COUNT times in sequence. With TEST, runs only the test of that name.
# This target reproduces and accepts an intermittent failure. At the first failure it reports the run number, the system load, and the output of that run.
# Measures the cost of the recorder. It is not a test: it prints numbers and asserts nothing. The Rust writer is measured with cargo bench and the native ring with the benchmark of native/darwin.
benchmark-rust: check-cargo
	@$(CARGO_ENV) node scripts/benchmarks.mjs cargo event_log_benchmark --timeout $(BENCH_TIMEOUT) -- $(CARGO) bench --manifest-path $(MANIFEST) -p soksak-host-tauriv2 --bench event_log_benchmark
	@$(CARGO_ENV) node scripts/benchmarks.mjs cargo event_native_benchmark --timeout $(BENCH_TIMEOUT) -- $(CARGO) bench --manifest-path $(MANIFEST) -p soksak-host-tauriv2 --bench event_native_benchmark

benchmark-go:
	@$(GO_ENV) node scripts/benchmarks.mjs go ./packages/host/go/tests 'EventLogEmit|NativePull' --timeout $(BENCH_TIMEOUT) --ldflags='$(GO_LINK)'

repeat-rust: check-cargo
	@case "$(PACKAGE)" in '') echo "repeat-rust requires PACKAGE=<cargo package> COUNT=<n> [TEST_TARGET=lib|test:<target>] [TEST=<name>] [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-rust requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@$(CARGO_ENV) node scripts/rust-tests.mjs --manifest $(MANIFEST) --package $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) $(if $(filter undefined,$(origin RUST_PROFILE)),,--profile "$$RUST_PROFILE") $(if $(filter undefined,$(origin TEST_TARGET)),,--test-target "$$TEST_TARGET") $(if $(TEST),--test '$(TEST)') --count $(COUNT) --timeout $(TEST_TIMEOUT)

# Runs the tests of the Go packages of PACKAGE COUNT times in sequence. TEST is the go test -run regular expression and TAGS is the go test -tags value.
# GO_LDFLAGS forwards caller-selected generic linker flags; it has no platform-specific default.
# Each test of each package is its own process with the limit TEST_TIMEOUT, named when it starts and reported with its result and elapsed time (scripts/go-tests.mjs).
# A pattern whose packages have no test files fails when none has test files; a run in which no test matches fails.
# This target reproduces and accepts an intermittent failure. The runner reports the run number and the system load at the first failure.
repeat-go:
	@case "$(PACKAGE)" in '') echo "repeat-go requires PACKAGE=<go package path> COUNT=<n> [TEST=<regexp>] [TAGS=<tags>] [GO_LDFLAGS=<flags>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-go requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@$(call go-env) node scripts/go-tests.mjs --package '$(PACKAGE)' $(if $(TAGS),--tags '$(TAGS)') $(if $(TEST),--test '$(TEST)') --count $(COUNT) --timeout $(TEST_TIMEOUT) --ldflags='$(GO_LDFLAGS)' --cgo-ldflags='$(GO_LINK)'

# Runs the tests whose name matches the pattern in a Node test file COUNT times in sequence from the repository root.
# Each repeat is one process of node --test with the limit TEST_TIMEOUT: the runner kills it at the limit and names it when it starts
# (scripts/repeat-node.mjs). Each test of a repeat gets the same limit through --test-timeout.
# This target reproduces and accepts an intermittent failure. The runner reports the run number and the system load at the first failure.
# A repeat fails when no passed test matches the pattern.
repeat-node:
	@case "$(FILE)" in '') echo "repeat-node requires FILE=<test file> NAME=<test name pattern> COUNT=<n>" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-node requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@node scripts/repeat-node.mjs --file '$(FILE)' --name='$(NAME)' --count $(COUNT) --timeout $(TEST_TIMEOUT)

# Runs COMMAND with a temporary folder of its own and fails when it leaves a soksak- entry there, except the window-check
# configuration folders soksak-check-* (docs/operations/examples.md#temporary-folders): make check-temp-files COMMAND="pnpm test"
check-temp-files:
	@test -n '$(COMMAND)' || { echo 'check-temp-files requires COMMAND=<command>' >&2; exit 2; }
	@node scripts/check-temp-files.mjs /bin/sh -c '$(COMMAND)'

# Checks that operating-system-specific code exists only under platform/<os>/.
check-platform-files:
	@node scripts/check-platform-files.mjs

# Compiles the sources of the two native hosts for the Windows target in the default build and the diagnostic build. The file layout checks of check-platform-files and check-host-files
# do not check the Windows implementation (platform/windows/) or the operating system API use of shared code, so this check
# verifies them by compilation. Host tests run only on macOS (docs/spec/host-contract.md), so they are not compiled.
WINDOWS_GOARCH      = arm64
check-windows-build:
	@echo "START: Go host library go vet GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/go && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet ./src/...
	@echo "PASS: Go host library for windows/$(WINDOWS_GOARCH)"
	@echo "START: Go host library go vet -tags diagnostics GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/go && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet -tags diagnostics ./src/...
	@echo "PASS: Go diagnostics host library for windows/$(WINDOWS_GOARCH)"
	@echo "START: Wails framework adapter go vet GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/wailsv3 && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet ./src/...
	@echo "PASS: Wails framework adapter for windows/$(WINDOWS_GOARCH)"
	@echo "START: Wails framework adapter go vet -tags diagnostics GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/wailsv3 && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet -tags diagnostics ./src/...
	@echo "PASS: Wails diagnostics framework adapter for windows/$(WINDOWS_GOARCH)"
	@echo "START: mygo framework adapter go vet GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/mygo && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet ./src/...
	@echo "PASS: mygo framework adapter for windows/$(WINDOWS_GOARCH)"
	@echo "START: mygo framework adapter go vet -tags diagnostics GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/mygo && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet -tags diagnostics ./src/...
	@echo "PASS: mygo diagnostics framework adapter for windows/$(WINDOWS_GOARCH)"

# Compiles the sources of the Rust host library for the Windows target in the default build and the diagnostic build, as
# check-windows-build does for the Go hosts. Host tests run only on macOS (docs/spec/host-contract.md), so they are not compiled.
# The target does not change the toolchain: it fails when the Windows target of rustup is not installed.
WINDOWS_RUST_TARGET = x86_64-pc-windows-msvc
check-windows-rust: check-cargo
	@$(dir $(CARGO))rustup target list --installed | grep -qx '$(WINDOWS_RUST_TARGET)' || { echo "the Rust target $(WINDOWS_RUST_TARGET) is not installed; run rustup target add $(WINDOWS_RUST_TARGET)" >&2; exit 1; }
	@echo "START: Rust host library cargo check --target $(WINDOWS_RUST_TARGET)"
	@$(CARGO_ENV) $(CARGO) check --locked -p soksak-host --target $(WINDOWS_RUST_TARGET)
	@echo "PASS: Rust host library for $(WINDOWS_RUST_TARGET)"
	@echo "START: Rust host library cargo check --target $(WINDOWS_RUST_TARGET) --features diagnostics"
	@$(CARGO_ENV) $(CARGO) check --locked -p soksak-host --target $(WINDOWS_RUST_TARGET) --features diagnostics
	@echo "PASS: Rust diagnostics host library for $(WINDOWS_RUST_TARGET)"

# Compiles the sources and the tests of the two native hosts and the two native apps for macOS in the configuration of the debug apps.
# A source behind a diagnostic feature or tag fails here and not in the build of an app. The Go tests link the native test library,
# so it is built. The core frontend is staged because the apps include it at compile time.
check-host-debug: check-cargo build-native build-native-tests copy-core-frontend-wailsv3 copy-core-frontend-tauriv2 copy-core-frontend-mygo
	@echo "START: Rust hosts cargo check --tests --features $(TAURI_DEBUG_FEATURES)"
	@$(CARGO_ENV) $(CARGO) check --locked --tests -p soksak-sok -p soksak-host -p soksak-host-tauriv2 -p sok-tauriv2 --features $(TAURI_DEBUG_FEATURES)
	@echo "PASS: Rust hosts in the debug configuration"
	@echo "START: Go hosts go vet -tags \"$(WAILS_DEBUG_TAGS)\""
	@$(GO_ENV) go vet -C apps/wailsv3 -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@CGO_ENABLED=0 $(call go-env) go vet -C apps/mygo -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@$(GO_ENV) go vet -C packages/host/go -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@$(GO_ENV) go vet -C packages/host/wailsv3 -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@CGO_ENABLED=0 $(call go-env) go vet -C packages/host/mygo -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@$(GO_ENV) go vet -C packages/sok/go -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@echo "PASS: Go hosts in the debug configuration"

# Checks that the file structures of the two native hosts and the two native apps differ only in the allowed ways.
check-host-files: check-windows-build check-host-debug
	@node scripts/check-host-files.mjs

check-tools:
	@scripts/check-tools.sh

install: check-tools
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile

build: install
	@pnpm build

# Runs the headless owner tests of the verification pipeline: the Node tests of scripts/test, e2e/test and
# packages/window-check/test, which start no application and need no display. The owners of a platform implementation take
# its facilities by injection, so they run on any system; CI runs this selection on Linux. A test that needs a live facility of
# macOS (the SDK, FSEvents, sample) is a system owner placed in platform/darwin/system/, which the macOS jobs run.
test-headless-owners:
	@node scripts/node-tests.mjs --only scripts/test/ --only e2e/test/ --only packages/window-check/test/ --exclude-folder platform/darwin/system

test-all: install check-docs check-exposure check-tests check-hosts-same
	@pnpm test
	@$(MAKE) test-language
	@pnpm check-breaks
	@$(MAKE) --no-print-directory build
	@git diff --exit-code -- packages/soksak/dist

# Applications. The two native apps and the sidecar executables are placed in target/{debug,release}. Each app assembles its frontend from environment.json and stages the
# frontend into the app directory before the build. The two native apps include the staged frontend at compile time with go:embed and
# generate_context!.
#
# Each app is built in two profiles, debug and release. release uses the standard size-reducing
# options of each tool (the cargo release profile, -s -w -trimpath of Go). debug is a diagnostic build (the Go tag and the cargo
# feature diagnostics). While the declared release version is 0.0.x, release is a diagnostic build too, so a defect on a
# user's machine is recorded when it appears (AGENTS.md); a later version series builds release without diagnostics.
COMMA := ,
# The build configuration of the debug apps. check-host-debug compiles the same configuration.
TAURI_DEBUG_FEATURES = diagnostics,dev
WAILS_DEBUG_TAGS     = diagnostics dev
# The declared core release candidate is the RELEASE constant of scripts/check-versions.mjs.
DIAGNOSTIC_RELEASE := $(filter 0.0.%,$(shell sed -n 's/^export const RELEASE = "\(.*\)";$$/\1/p' scripts/check-versions.mjs))
.PHONY: build-native fetch-native build-registry build-fixture-registry fixture-registry install-registry install-plugins copy-frontend-browser run-browser copy-frontend-wailsv3 copy-frontend-tauriv2 copy-frontend-mygo copy-core-frontend-wailsv3 copy-core-frontend-tauriv2 copy-core-frontend-mygo test-wailsv3 test-tauriv2 test-mygo test-hosts check-release-wailsv3 check-release-tauriv2 check-release-mygo check-rust-format check-rust-clippy check-go-format run-tauriv2 run-tauriv2-release build-tauriv2 build-tauriv2-release run-wailsv3 run-wailsv3-release build-wailsv3 build-wailsv3-release run-mygo run-mygo-release build-mygo build-mygo-release test-app test-app-candidate test-app-capture-input-close test-app-host-go test-app-activation test-app-real test-app-person test-app-section-design benchmark-input-latency measure-examples-size run-tauriv2 run-tauriv2-release run-wailsv3 run-wailsv3-release test-app

# rustup installs cargo in $(CARGO_HOME)/bin, which is ~/.cargo/bin when CARGO_HOME is not set, and adds the path to
# the shell profile. The shell of make does not read the profile, and a hosted runner sets CARGO_HOME outside HOME.
CARGO_HOME ?= $(HOME)/.cargo
export PATH := $(CARGO_HOME)/bin:$(PATH)
# GNU Make 3.81 runs a recipe line without shell characters itself and looks its program up in its own PATH, not in the
# exported one, and $(shell) does not receive the exported PATH either; so cargo is resolved once with that PATH and every
# recipe runs $(CARGO). The scripts that a recipe starts read the exported CARGO through cargoCommand of
# @soksak/window-check. check-cargo stops a target that runs cargo when none was found.
export CARGO := $(shell PATH="$(PATH)" command -v cargo)

.PHONY: check-cargo
check-cargo:
	@test -n "$(CARGO)" || { echo "make: cargo is on neither PATH nor $(CARGO_HOME)/bin; rustup installs it there" >&2; exit 1; }

# The minimum macOS version of the native apps. The capture code uses the macOS 14.4 API
# getCurrentProcessShareableContentWithCompletionHandler. This is the one declaration of the version: native/darwin reads it,
# and every Go and Rust command of a target gets it here (docs/spec/hosts.md#nativedarwin).
# Go passes it to cgo packages through CGO_CFLAGS and their external linker through -extldflags.
# Cgo-free native profiles pass GO_INTERNAL_LINK to the Go internal linker. Clang reads
# MACOSX_DEPLOYMENT_TARGET for a compile or a link without a version flag. Rust and cc read MACOSX_DEPLOYMENT_TARGET.
MACOS_MINIMUM = 14.4
export PKG_CONFIG_PATH := $(CURDIR)/native/darwin/build
# go build puts CGO_CFLAGS into the cache key but not the contents of the static libraries that cgo links.
# Putting the library hash into CGO_CFLAGS recompiles and relinks the cgo packages when a library changes.
GO_CFLAGS    = -O2 -g -mmacosx-version-min=$(MACOS_MINIMUM)
# The environment of a Go command; the argument adds to CGO_CFLAGS. Cgo links also pass GO_LINK.
go-env       = MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM) CGO_CFLAGS="$(GO_CFLAGS)$(if $(1), $(1))"
GO_ENV       = $(call go-env,-DSOKSAK_DARWIN_LIBRARY=$$(shasum -a 256 native/darwin/build/libsoksak-darwin.a | cut -c1-16))
GO_LINK      = -extldflags=-mmacosx-version-min=$(MACOS_MINIMUM)
# The cgo-free Go linker does not read MACOSX_DEPLOYMENT_TARGET.
GO_INTERNAL_LINK = -macos=$(MACOS_MINIMUM)
CARGO_ENV    = MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM)

# The notification center of macOS delivers only to processes started from a bundle, so applications run from the bundle
# (docs/spec/hosts.md). Sidecars are also placed in Contents/MacOS of the bundle.
TAURI_DEBUG_BUNDLE   = target/debug/sok-tauriv2.app
TAURI_RELEASE_BUNDLE = target/release/tauriv2/soksak.app
WAILS_DEBUG_BUNDLE   = target/debug/sok-wailsv3.app
WAILS_RELEASE_BUNDLE = target/release/wailsv3/soksak.app
MYGO_DEBUG_BUNDLE    = target/debug/sok-mygo.app
MYGO_RELEASE_BUNDLE  = target/release/mygo/soksak.app
TAURI_DEBUG   = $(TAURI_DEBUG_BUNDLE)/Contents/MacOS/sok-tauriv2
TAURI_RELEASE = $(TAURI_RELEASE_BUNDLE)/Contents/MacOS/sok-tauriv2
WAILS_DEBUG   = $(WAILS_DEBUG_BUNDLE)/Contents/MacOS/sok-wailsv3
WAILS_RELEASE = $(WAILS_RELEASE_BUNDLE)/Contents/MacOS/sok-wailsv3
MYGO_DEBUG    = $(MYGO_DEBUG_BUNDLE)/Contents/MacOS/sok-mygo
MYGO_RELEASE  = $(MYGO_RELEASE_BUNDLE)/Contents/MacOS/sok-mygo

# Writes the Info.plist and the Dock icon of the bundle. The first argument is the bundle and the second is the application. The app name
# is set by CFBundleDisplayName of Info.plist (the supported languages are declared in CFBundleLocalizations of the same plist).
# When the name differs by language, the .lproj/InfoPlist.strings of that language is added again at that time.
# The Contents of the bundle are created anew at each build so an earlier sidecar or other removed file cannot remain in the bundle. The Darwin
# preparation helper checks the target before this mutation and refuses with the active process PID and bundle path when a process is executing
# from its Contents/MacOS directory.
bundle-info = node scripts/platform/darwin/prepare-app-bundle.mjs --bundle "$(1)" --app "$(2)"
# So that the debug bundle runs beside the release application, appends .dev to the release identifier in Info.plist and uses the bundle name
# as the executable name (docs/spec/hosts.md#frontend-and-executables). The first argument is the bundle and the second is the application.
bundle-dev = plutil -replace CFBundleIdentifier -string "$$(plutil -extract CFBundleIdentifier raw $(1)/Contents/Info.plist).dev" $(1)/Contents/Info.plist \
	&& plutil -replace CFBundleName -string sok-$(2) $(1)/Contents/Info.plist
# Seals the executables and the Info.plist in the bundle with an ad hoc signature and registers the bundle with LaunchServices again. The Dock
# shows the icon from the registered bundle information, and LaunchServices does not reread the registration when only files inside the bundle change.
LSREGISTER = /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
bundle-sign = codesign --sign - --force --deep $(1) && $(LSREGISTER) -f $(1)

# Builds the command line sok (docs/spec/cli.md) and places it beside the executables of the bundle. The first argument is the bundle and the second is the profile.
sok-wailsv3 = $(call go-env) go build -C packages/sok/go $(if $(filter release,$(2)),-trimpath) -ldflags "$(if $(filter release,$(2)),-s -w )$(GO_LINK)" $(if $(filter debug,$(2)),-tags "$(WAILS_DEBUG_TAGS)",$(if $(DIAGNOSTIC_RELEASE),-tags diagnostics)) -o ../../../$(1)/Contents/MacOS/sok ./src/cmd/sok
sok-mygo = CGO_ENABLED=0 MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM) go build -C packages/sok/go $(if $(filter release,$(2)),-trimpath) -ldflags "$(if $(filter release,$(2)),-s -w )$(GO_INTERNAL_LINK)" $(if $(filter debug,$(2)),-tags "diagnostics dev mygo",-tags "$(if $(DIAGNOSTIC_RELEASE),diagnostics )mygo") -o ../../../$(1)/Contents/MacOS/sok ./src/cmd/sok
sok-tauriv2 = $(CARGO_ENV) $(CARGO) build --locked -p soksak-sok $(if $(filter release,$(2)),--release) $(if $(filter debug,$(2)),--features $(TAURI_DEBUG_FEATURES),$(if $(DIAGNOSTIC_RELEASE),--features diagnostics)) && cp target/$(2)/sok $(1)/Contents/MacOS/sok

# The native library build reads only the native sources. The Go bindings that the checks of the callback and host API declarations
# hold are compiled by the Go hosts, so those checks run with the builds and tests of the Go hosts, which install Go; the Rust host and
# the native tests install no Go.
build-native:
	@$(MAKE) -C native/darwin MACOS_MINIMUM=$(MACOS_MINIMUM)

.PHONY: build-native-mygo check-host-api create-host-api
check-host-api:
	@node scripts/check-host-api.mjs

create-host-api:
	@node scripts/check-host-api.mjs --write

build-native-mygo: check-host-callbacks check-host-api
	@$(MAKE) -C native/darwin MACOS_MINIMUM=$(MACOS_MINIMUM) build-mygo

.PHONY: build-native-tests
build-native-tests:
	@$(MAKE) -C native/darwin MACOS_MINIMUM=$(MACOS_MINIMUM) build-host-test build-host-callback-abi build-host-callback-worker

# Fetches and checksum-validates the pinned native dependency without compiling it.
fetch-native:
	@$(MAKE) -C native/darwin MACOS_MINIMUM=$(MACOS_MINIMUM) fetch

# The workspace registry. Packs the sibling plugin repositories that scripts/workspace-registry.json declares with their make pack,
# builds every declared sidecar from its repository and releases them for the current platform, and then
# creates index.json in target/registry (docs/spec/plugins.md#repositories).
# Diagnostic builds and window checks install from here.
# SIDECARS=diagnostic runs `make release PROFILE=release FEATURES=diagnostics` of each sidecar repository, so a Rust sidecar builds the
# release profile with its feature diagnostics and a sidecar whose make release takes neither variable builds as it always does, and
# writes beside index.json sidecar-revisions.json, the revision of each sidecar repository that it built and whether its working tree
# held changes outside that revision.
# SIDECARS=diagnostic PLUGINS=public packs no plugin and builds no sidecar: it writes into target/registry-public an index of the plugins
# of the index of the public registry beside the sidecar releases that make build-registry SIDECARS=diagnostic wrote into target/registry,
# and fails when they are missing.
# PLUGINS also names the surface plugin ids of make measure-object-counts and make measure-trace-share (PLUGINS='ID...'), which do not depend on
# registry; a recipe that sets PLUGINS for those targets and also runs registry passes PLUGINS explicitly to each sub-make.
WORKSPACE_REGISTRY = target/registry
# The index of the public registry (docs/spec/registry.md).
PUBLIC_REGISTRY_INDEX = https://soksak-app.github.io/registry/index.json
REGISTRY = $(if $(filter public,$(PLUGINS)),target/registry-public,$(WORKSPACE_REGISTRY))

build-registry: check-cargo
	@$(CARGO_ENV) $(CARGO) build --locked -p soksak-sok
	@node scripts/workspace-registry.mjs --sok target/debug/sok --out $(REGISTRY) $(if $(SIDECARS),--sidecars $(SIDECARS)) \
		$(if $(PLUGINS),--plugins $(PLUGINS) --sidecar-registry $(WORKSPACE_REGISTRY) --public-index $(PUBLIC_REGISTRY_INDEX))

# The fixture registry (docs/spec/plugin-processes.md#verification-boundaries). Packs every fake plugin of e2e/fixtures and releases
# every fake sidecar of e2e/fixtures/sidecars for the current platform, and then creates index.json in target/fixture-registry with
# one pack fixtures of every fixture plugin. It reads no plugin or sidecar repository and no registry index. Each fake sidecar is
# built first with its own build script, because its release holds the executable that its sidecar.json declares.
# fixture-registry builds the fake sidecars and the registry with the sok that FIXTURE_SOK names and builds no sok: a candidate or
# prebuilt run of scripts/test-app.mjs builds it from its checkout into its configuration root with the sok of a bundle under test.
FIXTURE_REGISTRY = target/fixture-registry
FIXTURE_SOK = target/debug/sok
FIXTURE_SIDECARS = $(patsubst %/sidecar.json,%,$(wildcard e2e/fixtures/sidecars/*/sidecar.json))

build-fixture-registry: check-cargo
	@$(CARGO_ENV) $(CARGO) build --locked -p soksak-sok
	@$(MAKE) --no-print-directory fixture-registry FIXTURE_SOK=target/debug/sok FIXTURE_REGISTRY=$(FIXTURE_REGISTRY)

fixture-registry:
	@for dir in $(FIXTURE_SIDECARS); do $(CARGO_ENV) pnpm --dir "$$dir" run build || exit 1; done
	@node scripts/fixture-registry.mjs --sok "$(FIXTURE_SOK)" --out "$(FIXTURE_REGISTRY)"

# The installation stage of the workspace: `make install` of every plugin and sidecar repository that scripts/workspace-registry.json
# declares. A fresh checkout runs it once before make build-registry builds and packs those repositories.
install-registry:
	@node scripts/workspace-registry.mjs --install

# Installs every plugin of the workspace registry into the CONFIG configuration folder. Applications do not hold plugins in the bundle, so
# window checks and development runs install with this target before they start the application. Workspace plugins are changed without changing
# the version, so when the same version is already installed the installation changes nothing. Therefore the installed plugins are
# removed first and installed again. Build the registry explicitly before installation; each host consumes the same built inputs.
install-plugins:
	@test -n "$(CONFIG)" || { echo "make install-plugins CONFIG=<configuration directory>" >&2; exit 2; }
	@test -x target/debug/sok || { echo "target/debug/sok is missing or not executable; run make build-registry before installation" >&2; exit 2; }
	@test -f "$(REGISTRY)/index.json" || { echo "$(REGISTRY)/index.json is missing; run make build-registry before installation" >&2; exit 2; }
	@target/debug/sok registry use $(REGISTRY)/index.json --config-dir "$(CONFIG)"
	@for id in $$(node -e 'const f = "$(CONFIG)/plugins/installed.json"; const fs = require("fs"); console.log(fs.existsSync(f) ? Object.keys(JSON.parse(fs.readFileSync(f, "utf8")).plugins).join(" ") : "")'); do \
		target/debug/sok plugin remove $$id --config-dir "$(CONFIG)" || exit 1; done
	@for id in $$(node -e 'console.log(JSON.parse(require("fs").readFileSync("$(REGISTRY)/index.json", "utf8")).plugins.map((p) => p.id).join(" "))'); do \
		target/debug/sok plugin install $$id --config-dir "$(CONFIG)" || exit 1; done

# Stages the frontend. The argument is an extra flag. debug includes the page diagnostic module (--diagnostics) and release does not
# include it. Plugins and sidecars are not put in the bundle; they are installed into the configuration folder (make install-plugins).
copy-wailsv3 = pnpm -F @soksak/wailsv3 exec sok-copy-frontend src/frontend $(1)
copy-tauriv2 = pnpm -F @soksak/tauriv2 exec sok-copy-frontend src/frontend $(1)
# No page runs the workbench on the mygo host, so its staging is the view root.
copy-mygo = pnpm -F @soksak/mygo exec sok-copy-frontend src/frontend --no-main-page $(1)

# Staging does not touch the bundle. The bundle is rebuilt only by the build targets. This keeps the executable of the debug app that checks use
# from being removed by the staging of a check target such as test-native.
copy-frontend-wailsv3: build build-registry
	@$(call copy-wailsv3,--diagnostics --registry-index "$(abspath $(REGISTRY)/index.json)")

copy-frontend-tauriv2: build build-registry
	@$(call copy-tauriv2,--diagnostics --registry-index "$(abspath $(REGISTRY)/index.json)")

copy-frontend-mygo: build build-registry
	@$(call copy-mygo,--diagnostics --registry-index "$(abspath $(REGISTRY)/index.json)")

# Stages only the core frontend for independent host language checks. Registry builds belong to full host and release checks.
copy-core-frontend-wailsv3: build
	@$(call copy-wailsv3,--diagnostics)

copy-core-frontend-tauriv2: build
	@$(call copy-tauriv2,--diagnostics)

copy-core-frontend-mygo: build
	@$(call copy-mygo,--diagnostics)

# generate_context! includes the frontend, so this rebuilds the crate.
build-tauriv2: check-cargo build-native copy-frontend-tauriv2
	@$(call bundle-info,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@$(call bundle-dev,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) $(CARGO) build --locked -p sok-tauriv2 --features $(TAURI_DEBUG_FEATURES)
	@cp target/debug/sok-tauriv2 $(TAURI_DEBUG)
	@$(call sok-tauriv2,$(TAURI_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(TAURI_DEBUG_BUNDLE))

build-tauriv2-release: check-cargo build-native build
	@$(call bundle-info,$(TAURI_RELEASE_BUNDLE),tauriv2)
	@$(call copy-tauriv2,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) $(CARGO) build --locked --release -p sok-tauriv2 $(if $(DIAGNOSTIC_RELEASE),--features diagnostics)
	@cp target/release/sok-tauriv2 $(TAURI_RELEASE)
	@$(call sok-tauriv2,$(TAURI_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(TAURI_RELEASE_BUNDLE))

build-wailsv3: check-host-callbacks check-host-api build-native copy-frontend-wailsv3
	@$(call bundle-info,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(call bundle-dev,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(GO_ENV) go build -C apps/wailsv3 -tags "$(WAILS_DEBUG_TAGS)" -ldflags "$(GO_LINK)" -o ../../$(WAILS_DEBUG) ./src
	@$(call sok-wailsv3,$(WAILS_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(WAILS_DEBUG_BUNDLE))

build-wailsv3-release: check-host-callbacks check-host-api build-native build
	@$(call bundle-info,$(WAILS_RELEASE_BUNDLE),wailsv3)
	@$(call copy-wailsv3,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@$(GO_ENV) go build -C apps/wailsv3 -trimpath $(if $(DIAGNOSTIC_RELEASE),-tags diagnostics) -ldflags "-s -w $(GO_LINK)" -o ../../$(WAILS_RELEASE) ./src
	@$(call sok-wailsv3,$(WAILS_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(WAILS_RELEASE_BUNDLE))

build-mygo: build-native-mygo copy-frontend-mygo
	@$(call bundle-info,$(MYGO_DEBUG_BUNDLE),mygo)
	@$(call bundle-dev,$(MYGO_DEBUG_BUNDLE),mygo)
	@CGO_ENABLED=0 MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM) go build -C apps/mygo -tags "diagnostics dev" -ldflags "$(GO_INTERNAL_LINK)" -o ../../$(MYGO_DEBUG) ./src
	@mkdir -p $(MYGO_DEBUG_BUNDLE)/Contents/Frameworks
	@cp native/darwin/build/mygo/libsoksak-darwin.dylib $(MYGO_DEBUG_BUNDLE)/Contents/Frameworks/
	@$(call sok-mygo,$(MYGO_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(MYGO_DEBUG_BUNDLE))

build-mygo-release: build-native-mygo build
	@$(call bundle-info,$(MYGO_RELEASE_BUNDLE),mygo)
	@$(call copy-mygo,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@CGO_ENABLED=0 MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM) go build -C apps/mygo -trimpath $(if $(DIAGNOSTIC_RELEASE),-tags diagnostics) -ldflags "-s -w $(GO_INTERNAL_LINK)" -o ../../$(MYGO_RELEASE) ./src
	@mkdir -p $(MYGO_RELEASE_BUNDLE)/Contents/Frameworks
	@cp native/darwin/build/mygo/libsoksak-darwin.dylib $(MYGO_RELEASE_BUNDLE)/Contents/Frameworks/
	@$(call sok-mygo,$(MYGO_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(MYGO_RELEASE_BUNDLE))

run-tauriv2: build-tauriv2
	@./$(TAURI_DEBUG)

run-tauriv2-release: build-tauriv2-release
	@./$(TAURI_RELEASE)

run-wailsv3: build-wailsv3
	@./$(WAILS_DEBUG)

run-wailsv3-release: build-wailsv3-release
	@./$(WAILS_RELEASE)

run-mygo: build-mygo
	@./$(MYGO_DEBUG)

run-mygo-release: build-mygo-release
	@./$(MYGO_RELEASE)

# Unit checks of native code. Runs the shared input check and the host contract check, which runs the tests of the two hosts.
# The checks of a sidecar run in each sidecar repository.
test-native: build-native copy-core-frontend-wailsv3 copy-core-frontend-tauriv2
	@$(MAKE) check-rust-format
	@$(MAKE) check-rust-clippy
	@$(MAKE) check-go-format
	@$(MAKE) -C native/darwin MACOS_MINIMUM=$(MACOS_MINIMUM) test
	@$(MAKE) test-hosts

# Checks that every Go file the repository tracks is in gofmt form. Reports every file of a different form and fails.
check-go-format:
	@files=$$(git ls-files '*.go'); \
	  unformatted=$$(gofmt -l $$files) || exit 1; \
	  if [ -n "$$unformatted" ]; then echo "Go files not in gofmt format:" >&2; echo "$$unformatted" >&2; exit 1; fi; \
	  echo "Go format check passed: $$(echo $$files | wc -w | tr -d ' ') files"

# Checks every package and test of the Rust workspace in the diagnostic build and the default build without clippy warnings.
# generate_context! of sok-tauriv2 reads the staged frontend (frontendDist), so the check stages it first, as test-native does.
check-rust-clippy: check-cargo build-native copy-core-frontend-tauriv2
	@$(CARGO_ENV) $(CARGO) clippy --locked --workspace --tests --features soksak-host-tauriv2/diagnostics -- -D warnings
	@$(CARGO_ENV) $(CARGO) clippy --locked --workspace --tests -- -D warnings
	@echo "Rust clippy check passed: 1 workspace, diagnostics and default builds"

# Checks that every package of the Rust workspace is in rustfmt form.
check-rust-format: check-cargo
	@$(CARGO) fmt --all --check
	@echo "Rust format check passed: 1 workspace"

# Runs the tests of the hosts in the default configuration and the diagnostic configuration and checks from the results that the host contract cases
# (docs/spec/host-contract.md) run at the same level.
# Host contract tests build their fixture plugins and sidecars under test-owned temporary directories.
test-hosts: check-cargo build-native-mygo build-native-tests copy-core-frontend-wailsv3 copy-core-frontend-tauriv2 copy-core-frontend-mygo
	@$(call go-env) $(CARGO_ENV) node scripts/test-hosts.mjs --go-ldflags="$(GO_INTERNAL_LINK)" --cgo-ldflags="$(GO_LINK)"

# Per-language CI checks use the same selected host contract without discovering or building the other host.
test-wailsv3: check-host-callbacks check-host-api build-native build-native-tests copy-core-frontend-wailsv3
	@$(call go-env) node scripts/test-hosts.mjs --host wailsv3 --cgo-ldflags="$(GO_LINK)"

test-tauriv2: check-cargo build-native copy-core-frontend-tauriv2
	@$(CARGO_ENV) node scripts/test-hosts.mjs --host tauriv2

# The contract run of the mygo host, and the unit tests of its workbench and of its application.
test-mygo: build-native-mygo build-native-tests copy-core-frontend-mygo
	@CGO_ENABLED=0 $(call go-env) node scripts/go-tests.mjs --package './packages/workbench-mygo/...' --count 1 --timeout $(TEST_TIMEOUT) --ldflags='$(GO_INTERNAL_LINK)'
	@$(call go-env) node scripts/test-hosts.mjs --host mygo --go-ldflags="$(GO_INTERNAL_LINK)"
	@pnpm -F @soksak/mygo test

# Release host checks build and audit only the selected application bundle; the release reads no registry (docs/spec/verification.md).
check-release-wailsv3: build-wailsv3-release
	@node scripts/check-release.mjs --host wailsv3 --macos-minimum $(MACOS_MINIMUM) --wailsv3-bundle "$(WAILS_RELEASE_BUNDLE)"

check-release-tauriv2: build-tauriv2-release
	@node scripts/check-release.mjs --host tauriv2 --macos-minimum $(MACOS_MINIMUM) --tauriv2-bundle "$(TAURI_RELEASE_BUNDLE)"

check-release-mygo: build-mygo-release
	@node scripts/check-release.mjs --host mygo --macos-minimum $(MACOS_MINIMUM) --mygo-bundle "$(MYGO_RELEASE_BUNDLE)"

# The window checks drive running applications in sequence through the local endpoint; the harness does not start them.
# The end-to-end checks (docs/operations/examples.md#test-kinds): the window checks of the running applications and the native
# end-to-end tests. They need a display, so they run only locally. test-app-activation runs the activation tier and test-app-real the
# real-input tier, which a person approves because they activate the applications and change the input source; test-app-person runs
# the checks that a person operates at the machine.
# Each e2e target builds the three debug applications and the fixture registry of e2e/fixtures, and scripts/test-app.mjs runs the
# window-check script and the native end-to-end target of its tier in a new configuration root under target/e2e: it installs every
# fixture plugin into each application, starts the applications, runs the checks and quits the applications.
E2E_BUILD = build-wailsv3 build-tauriv2 build-mygo build-fixture-registry
# The registered Go TestE2E cases currently belong to the mygo adapter. The source
# inventory in test-kinds.test.mjs rejects future cases outside this declared scope.
# Display and activation requirements remain those of each case.
test-app-host-go: build-native-mygo build-native-tests
	@CGO_ENABLED=0 $(call go-env) node scripts/go-tests.mjs --package './packages/host/mygo/tests/...' --tags 'e2e diagnostics mygo' --test '^TestE2E' --count 1 --timeout $(TEST_TIMEOUT) --ldflags='$(GO_INTERNAL_LINK)'

test-app: check-docs check-app-tests check-exposure $(E2E_BUILD)
	@node scripts/test-app.mjs --script test-app --native test-app $(if $(WHEN_IDLE),--when-idle $(WHEN_IDLE))

# Focused native application checks; preparation, auditing and cleanup use the ordinary window runner.
test-app-capture-input-close: check-docs check-app-tests check-exposure $(E2E_BUILD)
	@node scripts/test-app.mjs --script test-app:capture-input-close $(if $(WHEN_IDLE),--when-idle $(WHEN_IDLE))

# Acceptance consumes the downloaded candidate bundles and frozen component context without rebuilding them.
test-app-candidate:
	@test -n "$(CONTEXT)" && test -n "$(SCRIPT)" || { echo "make test-app-candidate CONTEXT=<context.json> SCRIPT=<declared script>" >&2; exit 2; }
	@node scripts/test-app.mjs --candidate "$(CONTEXT)" --script "$(SCRIPT)" $(if $(WHEN_IDLE),--when-idle $(WHEN_IDLE))

test-app-activation: $(E2E_BUILD)
	@node scripts/test-app.mjs --script test-app:activation --native test-app-activation

test-app-real: $(E2E_BUILD)
	@node scripts/test-app.mjs --script test-app:real

test-app-person: $(E2E_BUILD)
	@node scripts/test-app.mjs --script test-app:person

# These targets run one observation, benchmark or repeat against applications that already run; they build and start nothing.
# Leaves stills of the sections in target/section-design for inspection at original resolution.
test-app-section-design: $(E2E_BUILD)
	@node scripts/test-app.mjs --script test-app:section-design

test-app-card-sidebar-current:
	@pnpm -F @soksak/e2e run test-app:card-sidebar-current

test-app-terminal-focus-current:
	@pnpm -F @soksak/e2e run test-app:terminal-focus-current

test-app-shutdown:
	@pnpm -F @soksak/e2e run test-app:shutdown

# B3_OUT=FILE writes the B3 output of the benchmark to FILE (e2e/benchmark/cases/b3-run.mjs). The view drag and the resize catch-up
# measure in two states and take with B3_OUT the state TRACE, one of the state names of the benchmark in B3_MEASUREMENTS of
# e2e/benchmark/measurements.mjs: TRACE=0|frame-records for the view drag and TRACE=captured|frame-records for the resize catch-up; the
# view drag takes ACCESSIBILITY=1, FLOOR=1 and GC_LOOP=1 (e2e/benchmark/cases/view-drag.mjs). The benchmark refuses a value that it does
# not take.
B3_BENCHMARK_ENV = $(if $(B3_OUT),SOKSAK_B3_OUT="$(abspath $(B3_OUT))") $(if $(TRACE),SOKSAK_B3_TRACE="$(TRACE)")
benchmark-view-drag:
	@$(B3_BENCHMARK_ENV) $(if $(ACCESSIBILITY),SOKSAK_ACCESSIBILITY="$(ACCESSIBILITY)") $(if $(FLOOR),SOKSAK_FLOOR="$(FLOOR)") \
	  $(if $(GC_LOOP),SOKSAK_GC_LOOP="$(GC_LOOP)") pnpm -F @soksak/e2e run benchmark:view-drag

benchmark-resize-catch-up:
	@$(B3_BENCHMARK_ENV) pnpm -F @soksak/e2e run benchmark:resize-catch-up

# The benchmark of an empty mygo window (docs/operations/examples.md#empty-window-benchmark): it opens a window of the framework without
# the mygo framework adapter. SECONDS is the time over which it reads the CPU.
benchmark-empty-window:
	@CGO_ENABLED=0 $(call go-env) go -C packages/host/mygo run -ldflags "$(GO_INTERNAL_LINK)" ./benchmark/platform/darwin $(if $(SECONDS),--seconds $(SECONDS))

benchmark-idle-tab:
	@$(B3_BENCHMARK_ENV) pnpm -F @soksak/e2e run benchmark:idle-tab

benchmark-split-load:
	@$(B3_BENCHMARK_ENV) pnpm -F @soksak/e2e run benchmark:split-load

benchmark-plain-view:
	@pnpm -F @soksak/e2e run benchmark:plain-view

# The time from a key to its arrival in the input probe of an open application (docs/operations/examples.md#input-latency): APP names the application, by
# default mygo, and SOKSAK_CONFIG_DIR the configuration folder that the application runs with.
benchmark-input-latency:
	@$(B3_BENCHMARK_ENV) SOKSAK_APP=$(or $(APP),mygo) node scripts/node-tests.mjs --script benchmark:input-latency --concurrency 1 --timeout 600

repeat-app-test:
	@case "$(FILE)" in '') echo "repeat-app-test requires FILE=<test file> NAME=<test name pattern> COUNT=<n>" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-app-test requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@pnpm -F @soksak/e2e run repeat --file '$(FILE)' --name '$(NAME)' --count $(COUNT)

# The three-host benchmark B3 (scripts/benchmark-b3.mjs, docs/operations/examples.md#three-host-benchmark): it checks the BASELINE checkout
# against the baseline record b3/baseline.json of the git common directory, builds the release bundles of this checkout and of BASELINE and the two registry indexes, starts and
# quits each application for each run of each scenario and writes one session folder under b3 of the git common directory for make check-b3. It runs
# the accessibility client of S13, which needs the Accessibility permission, so a person runs S13 (F622).
benchmark-b3:
	@case "$(PHASE)" in 1|final) ;; *) echo "benchmark-b3 requires PHASE=1|final RUNS=<n> BASELINE=<checkout>" >&2; exit 2;; esac
	@case "$(RUNS)" in ''|*[!0-9]*|0*) echo "benchmark-b3 requires PHASE=1|final RUNS=<n> BASELINE=<checkout>" >&2; exit 2;; esac
	@case "$(BASELINE)" in '') echo "benchmark-b3 requires PHASE=1|final RUNS=<n> BASELINE=<checkout>" >&2; exit 2;; esac
	@node scripts/benchmark-b3.mjs --phase $(PHASE) --runs $(RUNS) --baseline "$(BASELINE)"

# Judges a session folder of make benchmark-b3 against docs/spec/performance-goals.json without starting an application and prints each
# value with its runs, its spread and its result (scripts/b3-judge.mjs, docs/operations/examples.md#three-host-benchmark).
check-b3:
	@case "$(SESSION)" in '') echo "check-b3 requires SESSION=<session folder of make benchmark-b3>" >&2; exit 2;; esac
	@node scripts/b3-judge.mjs --session "$(SESSION)"

# The two-profile builds of the three apps and their sizes.
measure-examples-size: build-tauriv2 build-tauriv2-release build-wailsv3-release build-wailsv3 build-mygo build-mygo-release
	@printf "%-10s %10s %10s\n" "" debug release
	@printf "%-10s %9.1fM %9.1fM\n" tauriv2 \
	  $$(echo "$$(stat -f%z $(TAURI_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(TAURI_RELEASE))/1048576" | bc -l)
	@printf "%-10s %9.1fM %9.1fM\n" wailsv3 \
	  $$(echo "$$(stat -f%z $(WAILS_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(WAILS_RELEASE))/1048576" | bc -l)
	@printf "%-10s %9.1fM %9.1fM\n" mygo \
	  $$(echo "$$(stat -f%z $(MYGO_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(MYGO_RELEASE))/1048576" | bc -l)
