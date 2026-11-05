SHELL := /bin/sh

.PHONY: push-check events-check census-check failures-check benchmark-rust benchmark-go preflight prepare build verify browser-example-check docs-check records-check commits-check hooks boundaries platforms windows-build-check hosts-check e2e-check e2e-registry-tls e2e-terminal-sidebar-current e2e-terminal-focus-current e2e-shutdown e2e-benchmark-view-drag e2e-benchmark-resize-catch-up e2e-benchmark-empty-window e2e-benchmark-idle-tab e2e-benchmark-split-load e2e-repeat e2e-b3 b3-judge exposure-check parity-check host-parity-check language-test release-check rust-tests-alone rust-repeat go-repeat node-repeat temp-audit page-memory object-counts host-calls app-usage terminal-redraw-usage trace-share host-allocations app-update-check host-debug-check

docs-check:
	@node scripts/check-docs.mjs
	@node scripts/check-failure-table.mjs
	@node scripts/check-private-apis.mjs
	@pnpm exec soksak-check records

# Checks that the documents and configuration comments state only facts about the repository (AGENTS.md Documentation).
records-check:
	@pnpm exec soksak-check records

# Checks the commit message form of RANGE, which holds one or more revision ranges separated by spaces. Example: make commits-check RANGE=origin/main..HEAD
commits-check:
	@test -n "$(RANGE)" || { echo "make commits-check RANGE=<revision range>" >&2; exit 2; }
	@pnpm exec soksak-check commits $(RANGE)

# Sets the git hook folder of this checkout to .githooks. The commit-msg hook checks the commit message form.
hooks:
	@git config core.hooksPath .githooks

# Runs before a push (the pre-push hook of `make hooks`): the commit messages of RANGE, because a published commit message is kept.
# CI runs every other check on the pushed commits, a later commit corrects a failure, and the release gate releases only a green run.
# The pre-push hook sets RANGE to the commits of each pushed ref (scripts/push-range.mjs). Without RANGE, the commits are origin/main..HEAD:
# the commits that the remote main branch does not have. This range exists on every branch, while @{upstream}..HEAD fails with git exit 128
# on a branch without an upstream, which a new branch has until its first push.
push-check:
	@$(MAKE) --no-print-directory commits-check RANGE="$(or $(RANGE),origin/main..HEAD)"

# Builds release and checks that the staged frontend and the release executables hold no diagnostic code.
release-check: wailsv3-build-release tauriv2-build-release mygo-build-release
	@node scripts/check-release.mjs --macos-minimum $(MACOS_MINIMUM) --wailsv3-bundle "$(WAILS_RELEASE_BUNDLE)" --tauriv2-bundle "$(TAURI_RELEASE_BUNDLE)" --mygo-bundle "$(MYGO_RELEASE_BUNDLE)"

# Measures the memory of the main page process of a running application at start, idle, and after reload (docs/operations/examples.md).
# APP is wailsv3, tauriv2 or mygo, CONFIG is the configuration folder of that application, BUILD is release (default) or debug. A window of the
# mygo host has no main page, and the measurement fails with "the mygo host has no main page".
# HOST is wailsv3 or tauriv2. Checks with a copy of the built debug bundle that an application update replaces the bundle.
app-update-check:
	@case "$(HOST)" in wailsv3|tauriv2|mygo) ;; *) echo "app-update-check requires HOST=wailsv3|tauriv2|mygo" >&2; exit 2;; esac
	@node scripts/check-app-update.mjs --host $(HOST) --bundle target/debug/soksak-$(HOST).app --registry target/registry/index.json

page-memory:
	@case "$(APP)" in wailsv3|tauriv2|mygo) ;; *) echo "page-memory requires APP=wailsv3|tauriv2|mygo CONFIG=DIR [BUILD=release|debug] [MINUTES=60] [RELOADS=20]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "page-memory requires CONFIG=DIR" >&2; exit 2;; esac
	@case "$(BUILD)" in ''|release|debug) ;; *) echo "page-memory requires BUILD=release|debug" >&2; exit 2;; esac
	@node scripts/measure-page-memory.mjs --sok $(if $(filter debug,$(BUILD)),target/debug/soksak-$(APP).app,target/release/$(APP)/soksak.app)/Contents/MacOS/sok --config-dir "$(CONFIG)" --idle-minutes $(or $(MINUTES),60) --reloads $(or $(RELOADS),20)

# Sets the trace state TRACE, repeats the operations of scripts/measure-object-counts.mjs for the surface plugins PLUGINS REPETITIONS times against a
# running diagnostic build and prints the object counts, the Go runtime figures and the footprints of the host, page and document processes per
# repetition (docs/operations/examples.md#page-memory); a window of the mygo host has no page process. The diagnostic methods exist only in
# diagnostic builds, so BUILD defaults to debug. B3_OUT=FILE, with at least 30 repetitions, writes the B3 output of S3 to FILE.
object-counts:
	@case "$(APP)" in wailsv3|tauriv2|mygo) ;; *) echo "object-counts requires APP=wailsv3|tauriv2|mygo CONFIG=DIR PLUGINS='ID...' TRACE=0|1 [BUILD=release|debug] [REPETITIONS=20] [B3_OUT=FILE]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "object-counts requires CONFIG=DIR" >&2; exit 2;; esac
	@case "$(strip $(PLUGINS))" in '') echo "object-counts requires PLUGINS='ID...', the surface plugins whose tabs it opens" >&2; exit 2;; esac
	@case "$(BUILD)" in ''|debug|release) ;; *) echo "object-counts requires BUILD=release|debug" >&2; exit 2;; esac
	@node scripts/measure-object-counts.mjs --sok $(if $(filter release,$(BUILD)),target/release/$(APP)/soksak.app,target/debug/soksak-$(APP).app)/Contents/MacOS/sok --config-dir "$(CONFIG)" --trace "$(TRACE)" $(foreach plugin,$(PLUGINS),--plugin $(plugin)) --repetitions $(or $(REPETITIONS),20) $(if $(B3_OUT),--b3-out "$(B3_OUT)")

# Has the main page of a running diagnostic build send CALLS host calls ROUNDS times and prints the footprint of its page process before the calls, after
# them and after a collection (scripts/measure-host-calls.mjs); MINUTES=M waits M minutes without input instead of the calls;
# EVENTS=N has the host send N host events that the page does not listen to instead of the calls. The diagnostic methods exist only in diagnostic builds.
# A window of the mygo host has no main page, and the measurement fails with "the mygo host has no main page".
host-calls:
	@case "$(APP)" in wailsv3|tauriv2|mygo) ;; *) echo "host-calls requires APP=wailsv3|tauriv2|mygo CONFIG=DIR [CALLS=1000 | MINUTES=M | EVENTS=N] [ROUNDS=5]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "host-calls requires CONFIG=DIR" >&2; exit 2;; esac
	@node scripts/measure-host-calls.mjs --sok target/debug/soksak-$(APP).app/Contents/MacOS/sok --config-dir "$(CONFIG)" --calls $(or $(CALLS),1000) --idle-minutes $(or $(MINUTES),0) --events $(or $(EVENTS),0) --rounds $(or $(ROUNDS),5)

# Reports the CPU and memory of the running application of CONFIG_DIR by process: host, sidecars, pages, documents and WebKit processes
# (scripts/measure-app-usage.mjs, docs/operations/examples.md). TRACE=0 sets the trace off under the default log policy and TRACE=1 the trace
# on with the class frame at debug before the measurement; TRACE=frame-records, which needs STEP=pointer, sets the trace state of the frame
# records (scripts/measure-trace.mjs) for both moves of the pointer step. STATE prepares a state of the three-host benchmark B3 in a window of 1200 by 760
# points through declared commands (docs/operations/examples.md); IDLE=1 then waits for the cursor idle timeout of every term and terminal tab
# and for 3 seconds without a change of frames of host.window; STEP=pointer measures a pointer move across the window with the HID moves of
# e2e/real/hid.mjs, which needs the Accessibility permission and brings the window to the front. B3_OUT writes the B3 record of the
# measurement, its measurements and its conditions, to that file as JSON; one record holds the keys of one trace state, so with STEP=pointer
# TRACE=0|1 writes the keys of the first move without hitTestP90Ms and TRACE=frame-records writes hitTestP90Ms alone. SOK defaults to the sok binary of target/debug.
app-usage:
	@case "$(CONFIG_DIR)" in '') echo "app-usage requires CONFIG_DIR=DIR TRACE=0|1|frame-records [STATE=S0|S0b|S1|S9|S11|S12|S14|S15] [IDLE=1] [STEP=pointer] [B3_OUT=FILE] [INTERVAL=10] [SOK=PATH]" >&2; exit 2;; esac
	@case "$(IDLE)" in ''|1) ;; *) echo "app-usage takes IDLE=1, not IDLE=$(IDLE)" >&2; exit 2;; esac
	@node scripts/measure-app-usage.mjs --sok $(or $(SOK),target/debug/sok) --config-dir "$(CONFIG_DIR)" --trace "$(TRACE)" --interval $(or $(INTERVAL),10) $(if $(STATE),--state "$(STATE)") $(if $(IDLE),--idle) $(if $(STEP),--step "$(STEP)") $(if $(B3_OUT),--b3-out "$(abspath $(B3_OUT))")

# Reports the CPU time of each process of the running application of CONFIG_DIR for each frame that the image region of a terminal tab
# presents while its program rewrites ROWS rows at RATE frames per second (scripts/measure-terminal-redraw.mjs, docs/operations/examples.md):
# after the trace state of TRACE=0|1, it opens one tab of PLUGIN, whose PLUGIN.input and PLUGIN.screen it uses, in a new project window of
# 760 by 614 points and divides the CPU time by the change of presentedFrames of the region of that tab. B3_OUT writes the B3 record of the
# measurement to that file as JSON. SOK defaults to the sok binary of target/debug.
terminal-redraw-usage:
	@case "$(CONFIG_DIR)" in '') echo "terminal-redraw-usage requires CONFIG_DIR=DIR PLUGIN=ID ROWS=N TRACE=0|1 [B3_OUT=FILE] [RATE=20] [INTERVAL=10] [SOK=PATH]" >&2; exit 2;; esac
	@node scripts/measure-terminal-redraw.mjs --sok $(or $(SOK),target/debug/sok) --config-dir "$(CONFIG_DIR)" --plugin "$(PLUGIN)" --rows "$(ROWS)" --trace "$(TRACE)" --rate $(or $(RATE),20) --interval $(or $(INTERVAL),10) $(if $(B3_OUT),--b3-out "$(abspath $(B3_OUT))")

# Measures the share of the diagnostics in the memory of a running host: in the trace state TRACE=1 and then TRACE=0 it runs five repetitions of
# object-counts and prints the entry of the last repetition, which holds the footprint of the host process (docs/operations/examples.md).
trace-share:
	@case "$(APP)" in wailsv3|tauriv2|mygo) ;; *) echo "trace-share requires APP=wailsv3|tauriv2|mygo CONFIG=DIR PLUGINS='ID...'" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "trace-share requires CONFIG=DIR" >&2; exit 2;; esac
	@for trace in 1 0; do \
	  echo "start TRACE=$$trace"; \
	  out=$$($(MAKE) --no-print-directory object-counts APP=$(APP) CONFIG="$(CONFIG)" PLUGINS="$(PLUGINS)" TRACE=$$trace BUILD=debug REPETITIONS=5) || exit 1; \
	  last=$$(printf '%s\n' "$$out" | grep '^{"repetition":' | tail -1); \
	  test -n "$$last" || { echo "trace-share: object-counts printed no repetition for TRACE=$$trace" >&2; exit 1; }; \
	  echo "end TRACE=$$trace $$last"; \
	done

# Sets the trace state TRACE and prints the live malloc nodes and bytes of the host process of the running application of CONFIG_DIR, the process
# whose command line has --config-dir CONFIG_DIR, at start and after each minute (scripts/measure-host-allocations.mjs,
# docs/operations/examples.md), and the footprint of the host at each step and after it settles. SOK defaults to the sok binary of target/debug.
# B3_OUT=FILE, with at least 60 minutes, writes the B3 output of S4 to FILE.
host-allocations:
	@case "$(CONFIG_DIR)" in '') echo "host-allocations requires CONFIG_DIR=DIR TRACE=0|1 [MINUTES=10] [SOK=PATH] [B3_OUT=FILE]" >&2; exit 2;; esac
	@node scripts/measure-host-allocations.mjs --sok $(or $(SOK),target/debug/sok) --config-dir "$(CONFIG_DIR)" --trace "$(TRACE)" --minutes $(or $(MINUTES),10) $(if $(B3_OUT),--b3-out "$(B3_OUT)")

# Checks that core, plugin, and sidecar sources do not name each other.
boundaries:
	@node scripts/check-boundaries.mjs

# Checks that the sources name every event declared in docs/spec/events.json. The audit of the logs that window checks leave is
# `node scripts/check-events.mjs --logs <configuration folder>...` (docs/operations/examples.md).
events-check:
	@node scripts/check-events.mjs

# Applies the census rules of the kit to the sources (docs/spec/logging.md#census): a source of occurrences has an event
# in its function or a reason marker, and a rule that waits for an entrance item is printed with its count. `--list` also prints each pending finding.
census-check:
	@pnpm exec soksak-check census --config scripts/census.json

# Checks that every error record whose place is written in the sources of the hosts and the native library has a row in the failure table of docs/spec/diagnostics.md.
failures-check:
	@node scripts/check-failure-table.mjs

# The TLS certificates of the registry window check (docs/operations/examples.md). Creates a certificate authority owned by the check and a server certificate for 127.0.0.1.
# openssl reads only the configuration file that the target writes, so no machine configuration adds an extension.
# The check application of a diagnostic build starts with --registry-ca <folder>/ca.pem. An existing certificate is not replaced. Each certificate,
# also an existing one, is parsed before the target ends, and a folder whose certificate does not parse is removed and the target fails, so a
# later run creates it again.
E2E_REGISTRY_TLS = $(or $(SOKSAK_CONFIG_ROOT),$(TMPDIR))/soksak-check-registry-tls
E2E_REGISTRY_TLS_PARSE = node -e 'const { X509Certificate } = require("node:crypto"); for (const file of process.argv.slice(1)) { try { new X509Certificate(require("node:fs").readFileSync(file)); } catch (error) { console.error(`$${file} holds no certificate: $${error.message}`); process.exit(1); } }'
e2e-registry-tls:
	@test -n "$(or $(SOKSAK_CONFIG_ROOT),$(TMPDIR))" || { echo "e2e-registry-tls needs TMPDIR or SOKSAK_CONFIG_ROOT" >&2; exit 2; }
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
browser-example-check: browser-frontend
	@pnpm -F @soksak/browser check

# The browser example has no host, so the plugins of the pack that apps/browser/environment.json names in `install` are installed into
# BROWSER_CONFIG and the staging provides that installation as a host does (the staging layout of docs/spec/plugins.md).
BROWSER_CONFIG = target/browser-config

browser-frontend: registry
	@rm -rf $(BROWSER_CONFIG)
	@target/debug/sok registry use $(REGISTRY)/index.json --config-dir $(BROWSER_CONFIG)
	@ids=$$(node -e "const env = require('$(CURDIR)/apps/browser/environment.json'); const pack = require('$(CURDIR)/$(REGISTRY)/index.json').packs.find((p) => p.name === env.install); if (!pack) throw new Error('apps/browser/environment.json install names no pack: ' + env.install); console.log(pack.plugins.join(' '))") || exit 1; for id in $$ids; do target/debug/sok plugin install $$id --config-dir $(BROWSER_CONFIG) || exit 1; done
	@pnpm -F @soksak/browser exec soksak-stage build --installed $(CURDIR)/$(BROWSER_CONFIG)

browser-example: browser-frontend
	@python3 -m http.server 8749 -d apps/browser/build

e2e-check:
	@node scripts/check-e2e.mjs

# Checks that UI operations run commands and that every displayed name is declared and registered.
exposure-check:
	@node scripts/check-exposure.mjs

# Checks the connection of the full source and test lists. It is separate from the result of behavior verification.
parity-check:
	@node scripts/check-test-parity.mjs

# Mechanically checks that the public API surfaces of the two hosts (call names, connections, endpoint methods) are the same (docs/spec/host-parity.md).
host-parity-check:
	@node scripts/check-host-parity.mjs

# JS/TS, Rust, Go, Objective-C, and shell test cases use the same observable case contract.
language-test: native-darwin
	@$(MAKE) -C native/darwin $(CURDIR)/native/darwin/build/appearance_test
	@node scripts/language-test-adapters.mjs scripts/language-test-cases.json

# Runs each test of a Rust package alone in a new process. Finds tests that depend on state another test created or on test order.
# Reports the test name at the first failure. MANIFEST is the Cargo.toml of the workspace that holds the package and FEATURES is the --features value of cargo.
MANIFEST ?= Cargo.toml
# The limit in seconds of one Rust test in rust-tests-alone and rust-repeat; the runner kills a test at it (scripts/rust-tests.mjs).
TEST_TIMEOUT ?= 120
# The limit in seconds of one benchmark in benchmark-rust and benchmark-go; the runner kills a benchmark at it (scripts/benchmarks.mjs).
BENCH_TIMEOUT ?= 300
ifneq ($(origin TEST_TARGET),undefined)
export TEST_TARGET
endif
rust-tests-alone:
	@case "$(PACKAGE)" in '') echo "rust-tests-alone requires PACKAGE=<cargo package> [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@$(CARGO_ENV) cargo test --locked -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --no-run
	@$(CARGO_ENV) node scripts/rust-tests.mjs --manifest $(MANIFEST) --package $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --count 1 --timeout $(TEST_TIMEOUT)

# Runs the tests of a Rust package COUNT times in sequence. With TEST, runs only the test of that name.
# This target reproduces and accepts an intermittent failure. At the first failure it reports the run number, the system load, and the output of that run.
# Measures the cost of the recorder. It is not a test: it prints numbers and asserts nothing. The Rust writer is measured with cargo bench and the native ring with the benchmark of native/darwin.
benchmark-rust:
	@$(CARGO_ENV) node scripts/benchmarks.mjs cargo event_log_benchmark --timeout $(BENCH_TIMEOUT) -- cargo bench --manifest-path $(MANIFEST) -p soksak-host-tauriv2 --bench event_log_benchmark
	@$(CARGO_ENV) node scripts/benchmarks.mjs cargo event_native_benchmark --timeout $(BENCH_TIMEOUT) -- cargo bench --manifest-path $(MANIFEST) -p soksak-host-tauriv2 --bench event_native_benchmark

benchmark-go:
	@$(GO_ENV) node scripts/benchmarks.mjs go ./packages/host/go/tests 'EventLogEmit|NativePull' --timeout $(BENCH_TIMEOUT) --ldflags='$(GO_LINK)'

rust-repeat:
	@case "$(PACKAGE)" in '') echo "rust-repeat requires PACKAGE=<cargo package> COUNT=<n> [TEST_TARGET=lib|test:<target>] [TEST=<name>] [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "rust-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@$(CARGO_ENV) node scripts/rust-tests.mjs --manifest $(MANIFEST) --package $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) $(if $(filter undefined,$(origin TEST_TARGET)),,--test-target "$$TEST_TARGET") $(if $(TEST),--test '$(TEST)') --count $(COUNT) --timeout $(TEST_TIMEOUT)

# Runs the tests of the Go packages of PACKAGE COUNT times in sequence. TEST is the go test -run regular expression and TAGS is the go test -tags value.
# Each test of each package is its own process with the limit TEST_TIMEOUT, named when it starts and reported with its result and elapsed time (scripts/go-tests.mjs).
# A pattern whose packages have no test files fails when none has test files; a run in which no test matches fails.
# This target reproduces and accepts an intermittent failure. The runner reports the run number and the system load at the first failure.
go-repeat:
	@case "$(PACKAGE)" in '') echo "go-repeat requires PACKAGE=<go package path> COUNT=<n> [TEST=<regexp>] [TAGS=<tags>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "go-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@cgo=$$(node scripts/go-repeat-inputs.mjs '$(PACKAGE)' '$(TAGS)') || exit 1; \
	  CGO_CFLAGS="$(GO_CFLAGS) $$cgo" node scripts/go-tests.mjs --package '$(PACKAGE)' $(if $(TAGS),--tags '$(TAGS)') $(if $(TEST),--test '$(TEST)') --count $(COUNT) --timeout $(TEST_TIMEOUT) --ldflags='$(GO_LINK)'

# Runs the tests whose name matches the pattern in a Node test file COUNT times in sequence from the repository root.
# Each repeat is one process of node --test with the limit TEST_TIMEOUT: the runner kills it at the limit and names it when it starts
# (scripts/node-repeat.mjs). Each test of a repeat gets the same limit through --test-timeout.
# This target reproduces and accepts an intermittent failure. The runner reports the run number and the system load at the first failure.
# A repeat fails when no passed test matches the pattern.
node-repeat:
	@case "$(FILE)" in '') echo "node-repeat requires FILE=<test file> NAME=<test name pattern> COUNT=<n>" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "node-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@node scripts/node-repeat.mjs --file '$(FILE)' --name='$(NAME)' --count $(COUNT) --timeout $(TEST_TIMEOUT)

# Runs COMMAND with a temporary folder of its own and fails when it leaves a soksak- entry there, except the window-check
# configuration folders soksak-check-* (docs/operations/examples.md#temporary-folders): make temp-audit COMMAND="pnpm test"
temp-audit:
	@test -n '$(COMMAND)' || { echo 'temp-audit requires COMMAND=<command>' >&2; exit 2; }
	@node scripts/temp-audit.mjs /bin/sh -c '$(COMMAND)'

# Checks that operating-system-specific code exists only under platform/<os>/.
platforms:
	@node scripts/check-platforms.mjs

# Compiles the sources of the two native hosts for the Windows target in the default build and the diagnostic build. The file layout checks of platforms and hosts-check
# do not check the Windows implementation (platform/windows/) or the operating system API use of shared code, so this check
# verifies them by compilation. Host tests run only on macOS (docs/spec/host-contract.md), so they are not compiled.
WINDOWS_GOARCH      = arm64
windows-build-check:
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

# Compiles the sources and the tests of the two native hosts and the two native apps for macOS in the configuration of the debug apps.
# A source behind a diagnostic feature or tag fails here and not in the build of an app. The core frontend is staged because the apps
# include it at compile time.
host-debug-check: native-darwin frontend-wailsv3-core frontend-tauriv2-core frontend-mygo-core
	@echo "START: Rust hosts cargo check --tests --features $(TAURI_DEBUG_FEATURES)"
	@$(CARGO_ENV) cargo check --locked --tests -p soksak-sok -p soksak-host -p soksak-host-tauriv2 -p soksak-tauriv2 --features $(TAURI_DEBUG_FEATURES)
	@echo "PASS: Rust hosts in the debug configuration"
	@echo "START: Go hosts go vet -tags \"$(WAILS_DEBUG_TAGS)\""
	@$(GO_ENV) go vet -C apps/wailsv3 -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@$(GO_ENV) go vet -C apps/mygo -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@$(GO_ENV) go vet -C packages/host/go -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@$(GO_ENV) go vet -C packages/host/wailsv3 -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@$(GO_ENV) go vet -C packages/host/mygo -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@$(GO_ENV) go vet -C packages/sok/go -tags "$(WAILS_DEBUG_TAGS)" ./src/...
	@echo "PASS: Go hosts in the debug configuration"

# Checks that the file structures of the two native hosts and the two native apps differ only in the allowed ways.
hosts-check: windows-build-check host-debug-check
	@node scripts/check-hosts.mjs

preflight:
	@scripts/check-build-environment.sh

prepare: preflight
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile

build: prepare
	@pnpm build

verify: prepare docs-check exposure-check parity-check host-parity-check
	@pnpm test
	@$(MAKE) language-test
	@pnpm breaks
	@pnpm build
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
# The build configuration of the debug apps. host-debug-check compiles the same configuration.
TAURI_DEBUG_FEATURES = diagnostics,dev
WAILS_DEBUG_TAGS     = diagnostics dev
# The declared core release candidate is the RELEASE constant of scripts/check-versions.mjs.
DIAGNOSTIC_RELEASE := $(filter 0.0.%,$(shell sed -n 's/^export const RELEASE = "\(.*\)";$$/\1/p' scripts/check-versions.mjs))
.PHONY: native-darwin native-darwin-fetch registry registry-install install-plugins browser-frontend browser-example frontend-wailsv3 frontend-tauriv2 frontend-mygo frontend-wailsv3-core frontend-tauriv2-core frontend-mygo-core host-test-wailsv3 host-test-tauriv2 host-test-mygo host-contract-check release-check-wailsv3 release-check-tauriv2 release-check-mygo rust-format-check rust-clippy-check go-format-check  \
        tauriv2 tauriv2-release tauriv2-build tauriv2-build-release \
        wailsv3 wailsv3-release wailsv3-build wailsv3-build-release \
        mygo mygo-release mygo-build mygo-build-release \
        e2e e2e-host-go e2e-activation e2e-real e2e-person e2e-section-design e2e-input-latency examples-size

# rustup installs cargo here and adds the path to the shell profile. The shell of make
# does not read the profile.
export PATH := $(HOME)/.cargo/bin:$(PATH)

# The minimum macOS version of the native apps. The capture code uses the macOS 14.4 API
# getCurrentProcessShareableContentWithCompletionHandler.
# Go passes it to every cgo package through CGO_CFLAGS and to the linker through -extldflags.
# Rust and cc read MACOSX_DEPLOYMENT_TARGET.
MACOS_MINIMUM = 14.4
export PKG_CONFIG_PATH := $(CURDIR)/native/darwin/build
# go build puts CGO_CFLAGS into the cache key but not the contents of the static libraries that cgo links.
# Putting the library hash into CGO_CFLAGS recompiles and relinks the cgo packages when a library changes.
GO_CFLAGS    = -O2 -g -mmacosx-version-min=$(MACOS_MINIMUM)
GO_ENV       = CGO_CFLAGS="$(GO_CFLAGS) -DSOKSAK_DARWIN_LIBRARY=$$(shasum -a 256 native/darwin/build/libsoksak-darwin.a | cut -c1-16)"
GO_LINK      = -extldflags=-mmacosx-version-min=$(MACOS_MINIMUM)
CARGO_ENV    = MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM)

# The notification center of macOS delivers only to processes started from a bundle, so applications run from the bundle
# (docs/spec/hosts.md). Sidecars are also placed in Contents/MacOS of the bundle.
TAURI_DEBUG_BUNDLE   = target/debug/soksak-tauriv2.app
TAURI_RELEASE_BUNDLE = target/release/tauriv2/soksak.app
WAILS_DEBUG_BUNDLE   = target/debug/soksak-wailsv3.app
WAILS_RELEASE_BUNDLE = target/release/wailsv3/soksak.app
MYGO_DEBUG_BUNDLE    = target/debug/soksak-mygo.app
MYGO_RELEASE_BUNDLE  = target/release/mygo/soksak.app
TAURI_DEBUG   = $(TAURI_DEBUG_BUNDLE)/Contents/MacOS/soksak-tauriv2
TAURI_RELEASE = $(TAURI_RELEASE_BUNDLE)/Contents/MacOS/soksak-tauriv2
WAILS_DEBUG   = $(WAILS_DEBUG_BUNDLE)/Contents/MacOS/soksak-wailsv3
WAILS_RELEASE = $(WAILS_RELEASE_BUNDLE)/Contents/MacOS/soksak-wailsv3
MYGO_DEBUG    = $(MYGO_DEBUG_BUNDLE)/Contents/MacOS/soksak-mygo
MYGO_RELEASE  = $(MYGO_RELEASE_BUNDLE)/Contents/MacOS/soksak-mygo

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
	&& plutil -replace CFBundleName -string soksak-$(2) $(1)/Contents/Info.plist
# Seals the executables and the Info.plist in the bundle with an ad hoc signature and registers the bundle with LaunchServices again. The Dock
# shows the icon from the registered bundle information, and LaunchServices does not reread the registration when only files inside the bundle change.
LSREGISTER = /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
bundle-sign = codesign --sign - --force --deep $(1) && $(LSREGISTER) -f $(1)

# Builds the command line sok (docs/spec/cli.md) and places it beside the executables of the bundle. The first argument is the bundle and the second is the profile.
sok-wailsv3 = go build -C packages/sok/go $(if $(filter release,$(2)),-trimpath -ldflags "-s -w") $(if $(filter debug,$(2)),-tags "$(WAILS_DEBUG_TAGS)",$(if $(DIAGNOSTIC_RELEASE),-tags diagnostics)) -o ../../../$(1)/Contents/MacOS/sok ./src/cmd/sok
sok-mygo = go build -C packages/sok/go $(if $(filter release,$(2)),-trimpath -ldflags "-s -w") $(if $(filter debug,$(2)),-tags "diagnostics dev mygo",-tags "$(if $(DIAGNOSTIC_RELEASE),diagnostics )mygo") -o ../../../$(1)/Contents/MacOS/sok ./src/cmd/sok
sok-tauriv2 = $(CARGO_ENV) cargo build --locked -p soksak-sok $(if $(filter release,$(2)),--release) $(if $(filter debug,$(2)),--features $(TAURI_DEBUG_FEATURES),$(if $(DIAGNOSTIC_RELEASE),--features diagnostics)) && cp target/$(2)/sok $(1)/Contents/MacOS/sok

native-darwin:
	@$(MAKE) -C native/darwin

# Fetches and checksum-validates the pinned native dependency without compiling it.
native-darwin-fetch:
	@$(MAKE) -C native/darwin fetch

# The workspace registry. Packs the sibling plugin repositories that scripts/workspace-registry.json declares with their make pack,
# builds every declared sidecar from its repository and releases them for the current platform, and then
# creates index.json in target/registry (docs/spec/plugins.md#repositories).
# Diagnostic builds and window checks install from here.
# SIDECARS=diagnostic runs `make release PROFILE=release FEATURES=diagnostics` of each sidecar repository, so a Rust sidecar builds the
# release profile with its feature diagnostics and a sidecar whose make release takes neither variable builds as it always does, and
# writes beside index.json sidecar-revisions.json, the revision of each sidecar repository that it built and whether its working tree
# held changes outside that revision.
# SIDECARS=diagnostic PLUGINS=public packs no plugin and builds no sidecar: it writes into target/registry-public an index of the plugins
# of the index of the public registry beside the sidecar releases that make registry SIDECARS=diagnostic wrote into target/registry,
# and fails when they are missing.
# PLUGINS also names the surface plugin ids of make object-counts and make trace-share (PLUGINS='ID...'), which do not depend on
# registry; a recipe that sets PLUGINS for those targets and also runs registry passes PLUGINS explicitly to each sub-make.
WORKSPACE_REGISTRY = target/registry
# The index of the public registry (docs/spec/registry.md).
PUBLIC_REGISTRY_INDEX = https://soksak-app.github.io/registry/index.json
REGISTRY = $(if $(filter public,$(PLUGINS)),target/registry-public,$(WORKSPACE_REGISTRY))

registry:
	@$(CARGO_ENV) cargo build --locked -p soksak-sok
	@node scripts/workspace-registry.mjs --sok target/debug/sok --out $(REGISTRY) $(if $(SIDECARS),--sidecars $(SIDECARS)) \
		$(if $(PLUGINS),--plugins $(PLUGINS) --sidecar-registry $(WORKSPACE_REGISTRY) --public-index $(PUBLIC_REGISTRY_INDEX))

# The installation stage of the workspace: `make install` of every plugin and sidecar repository that scripts/workspace-registry.json
# declares. A fresh checkout runs it once before make registry builds and packs those repositories.
registry-install:
	@node scripts/workspace-registry.mjs --install

# Installs every plugin of the workspace registry into the CONFIG configuration folder. Applications do not hold plugins in the bundle, so
# window checks and development runs install with this target before they start the application. Workspace plugins are changed without changing
# the version, so when the same version is already installed the installation changes nothing. Therefore the installed plugins are
# removed first and installed again.
install-plugins: registry
	@test -n "$(CONFIG)" || { echo "make install-plugins CONFIG=<configuration directory>" >&2; exit 2; }
	@target/debug/sok registry use $(REGISTRY)/index.json --config-dir "$(CONFIG)"
	@for id in $$(node -e 'const f = "$(CONFIG)/plugins/installed.json"; const fs = require("fs"); console.log(fs.existsSync(f) ? Object.keys(JSON.parse(fs.readFileSync(f, "utf8")).plugins).join(" ") : "")'); do \
		target/debug/sok plugin remove $$id --config-dir "$(CONFIG)" || exit 1; done
	@for id in $$(node -e 'console.log(JSON.parse(require("fs").readFileSync("$(REGISTRY)/index.json", "utf8")).plugins.map((p) => p.id).join(" "))'); do \
		target/debug/sok plugin install $$id --config-dir "$(CONFIG)" || exit 1; done

# Stages the frontend. The argument is an extra flag. debug includes the page diagnostic module (--diagnostics) and release does not
# include it. Plugins and sidecars are not put in the bundle; they are installed into the configuration folder (make install-plugins).
stage-wailsv3 = pnpm -F @soksak/wailsv3 exec soksak-stage src/frontend $(1)
stage-tauriv2 = pnpm -F @soksak/tauriv2 exec soksak-stage src/frontend $(1)
# No page runs the workbench on the mygo host, so its staging is the view root.
stage-mygo = pnpm -F @soksak/mygo exec soksak-stage src/frontend --no-main-page $(1)

# Staging does not touch the bundle. The bundle is rebuilt only by the build targets. This keeps the executable of the debug app that checks use
# from being removed by the staging of a check target such as native-test.
frontend-wailsv3: build registry
	@$(call stage-wailsv3,--diagnostics --registry-index "$(abspath $(REGISTRY)/index.json)")

frontend-tauriv2: build registry
	@$(call stage-tauriv2,--diagnostics --registry-index "$(abspath $(REGISTRY)/index.json)")

frontend-mygo: build registry
	@$(call stage-mygo,--diagnostics --registry-index "$(abspath $(REGISTRY)/index.json)")

# Stages only the core frontend for independent host language checks. Registry builds belong to full host and release checks.
frontend-wailsv3-core: build
	@$(call stage-wailsv3,--diagnostics)

frontend-tauriv2-core: build
	@$(call stage-tauriv2,--diagnostics)

frontend-mygo-core: build
	@$(call stage-mygo,--diagnostics)

# generate_context! includes the frontend, so this rebuilds the crate.
tauriv2-build: native-darwin frontend-tauriv2
	@$(call bundle-info,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@$(call bundle-dev,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build --locked -p soksak-tauriv2 --features $(TAURI_DEBUG_FEATURES)
	@cp target/debug/soksak-tauriv2 $(TAURI_DEBUG)
	@$(call sok-tauriv2,$(TAURI_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(TAURI_DEBUG_BUNDLE))

tauriv2-build-release: native-darwin build
	@$(call bundle-info,$(TAURI_RELEASE_BUNDLE),tauriv2)
	@$(call stage-tauriv2,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build --locked --release -p soksak-tauriv2 $(if $(DIAGNOSTIC_RELEASE),--features diagnostics)
	@cp target/release/soksak-tauriv2 $(TAURI_RELEASE)
	@$(call sok-tauriv2,$(TAURI_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(TAURI_RELEASE_BUNDLE))

wailsv3-build: native-darwin frontend-wailsv3
	@$(call bundle-info,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(call bundle-dev,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(GO_ENV) go build -C apps/wailsv3 -tags "$(WAILS_DEBUG_TAGS)" -ldflags "$(GO_LINK)" -o ../../$(WAILS_DEBUG) ./src
	@$(call sok-wailsv3,$(WAILS_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(WAILS_DEBUG_BUNDLE))

wailsv3-build-release: native-darwin build
	@$(call bundle-info,$(WAILS_RELEASE_BUNDLE),wailsv3)
	@$(call stage-wailsv3,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@$(GO_ENV) go build -C apps/wailsv3 -trimpath $(if $(DIAGNOSTIC_RELEASE),-tags diagnostics) -ldflags "-s -w $(GO_LINK)" -o ../../$(WAILS_RELEASE) ./src
	@$(call sok-wailsv3,$(WAILS_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(WAILS_RELEASE_BUNDLE))

mygo-build: native-darwin frontend-mygo
	@$(call bundle-info,$(MYGO_DEBUG_BUNDLE),mygo)
	@$(call bundle-dev,$(MYGO_DEBUG_BUNDLE),mygo)
	@$(GO_ENV) go build -C apps/mygo -tags "diagnostics dev" -ldflags "$(GO_LINK)" -o ../../$(MYGO_DEBUG) ./src
	@$(call sok-mygo,$(MYGO_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(MYGO_DEBUG_BUNDLE))

mygo-build-release: native-darwin build
	@$(call bundle-info,$(MYGO_RELEASE_BUNDLE),mygo)
	@$(call stage-mygo,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@$(GO_ENV) go build -C apps/mygo -trimpath $(if $(DIAGNOSTIC_RELEASE),-tags diagnostics) -ldflags "-s -w $(GO_LINK)" -o ../../$(MYGO_RELEASE) ./src
	@$(call sok-mygo,$(MYGO_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(MYGO_RELEASE_BUNDLE))

tauriv2: tauriv2-build
	@./$(TAURI_DEBUG)

tauriv2-release: tauriv2-build-release
	@./$(TAURI_RELEASE)

wailsv3: wailsv3-build
	@./$(WAILS_DEBUG)

wailsv3-release: wailsv3-build-release
	@./$(WAILS_RELEASE)

mygo: mygo-build
	@./$(MYGO_DEBUG)

mygo-release: mygo-build-release
	@./$(MYGO_RELEASE)

# Unit checks of native code. Runs the shared input check and the host contract check, which runs the tests of the two hosts.
# The checks of a sidecar run in each sidecar repository.
native-test: native-darwin frontend-wailsv3-core frontend-tauriv2-core
	@$(MAKE) rust-format-check
	@$(MAKE) rust-clippy-check
	@$(MAKE) go-format-check
	@$(MAKE) -C native/darwin test
	@$(GO_ENV) $(CARGO_ENV) node scripts/check-host-contract.mjs --go-ldflags="$(GO_LINK)"

# Checks that every Go file the repository tracks is in gofmt form. Reports every file of a different form and fails.
go-format-check:
	@files=$$(git ls-files '*.go'); \
	  unformatted=$$(gofmt -l $$files) || exit 1; \
	  if [ -n "$$unformatted" ]; then echo "Go files not in gofmt format:" >&2; echo "$$unformatted" >&2; exit 1; fi; \
	  echo "Go format check passed: $$(echo $$files | wc -w | tr -d ' ') files"

# Checks every package and test of the Rust workspace in the diagnostic build and the default build without clippy warnings.
# generate_context! of soksak-tauriv2 reads the staged frontend (frontendDist), so the check stages it first, as native-test does.
rust-clippy-check: native-darwin frontend-tauriv2-core
	@$(CARGO_ENV) cargo clippy --locked --workspace --tests --features soksak-host-tauriv2/diagnostics -- -D warnings
	@$(CARGO_ENV) cargo clippy --locked --workspace --tests -- -D warnings
	@echo "Rust clippy check passed: 1 workspace, diagnostics and default builds"

# Checks that every package of the Rust workspace is in rustfmt form.
rust-format-check:
	@cargo fmt --all --check
	@echo "Rust format check passed: 1 workspace"

# Runs the tests of the hosts in the default configuration and the diagnostic configuration and checks from the results that the host contract cases
# (docs/spec/host-contract.md) run at the same level.
# Host contract tests build their fixture plugins and sidecars under test-owned temporary directories.
host-contract-check: native-darwin frontend-wailsv3-core frontend-tauriv2-core frontend-mygo-core
	@$(GO_ENV) $(CARGO_ENV) node scripts/check-host-contract.mjs --go-ldflags="$(GO_LINK)"

# Per-language CI checks use the same selected host contract without discovering or building the other host.
host-test-wailsv3: native-darwin frontend-wailsv3-core
	@$(GO_ENV) node scripts/check-host-contract.mjs --host wailsv3 --go-ldflags="$(GO_LINK)"

host-test-tauriv2: native-darwin frontend-tauriv2-core
	@$(CARGO_ENV) node scripts/check-host-contract.mjs --host tauriv2

# The contract run of the mygo host, and the unit tests of its workbench and of its application.
host-test-mygo: native-darwin frontend-mygo-core
	@node scripts/go-tests.mjs --package './packages/workbench-mygo/...' --count 1 --timeout $(TEST_TIMEOUT)
	@$(GO_ENV) node scripts/check-host-contract.mjs --host mygo --go-ldflags="$(GO_LINK)"
	@pnpm -F @soksak/mygo test

# Release host checks build and audit only the selected application bundle; the release reads no registry (docs/spec/verification.md).
release-check-wailsv3: wailsv3-build-release
	@node scripts/check-release.mjs --host wailsv3 --macos-minimum $(MACOS_MINIMUM) --wailsv3-bundle "$(WAILS_RELEASE_BUNDLE)"

release-check-tauriv2: tauriv2-build-release
	@node scripts/check-release.mjs --host tauriv2 --macos-minimum $(MACOS_MINIMUM) --tauriv2-bundle "$(TAURI_RELEASE_BUNDLE)"

release-check-mygo: mygo-build-release
	@node scripts/check-release.mjs --host mygo --macos-minimum $(MACOS_MINIMUM) --mygo-bundle "$(MYGO_RELEASE_BUNDLE)"

# The window checks drive running applications in sequence through the local endpoint; the harness does not start them.
# The end-to-end checks (docs/operations/examples.md#test-kinds): the window checks of the running applications and the native
# end-to-end tests. They need a display, so they run only locally. e2e-activation runs the activation tier and e2e-real the
# real-input tier, which a person approves because they activate the applications and change the input source; e2e-person runs
# the checks that a person operates at the machine.
# Each e2e target builds the three debug applications and the workspace registry, and scripts/e2e-run.mjs runs the window-check script
# and the native end-to-end target of its tier in a new configuration root under target/e2e: it starts the applications, runs the
# checks and quits the applications.
E2E_BUILD = wailsv3-build tauriv2-build mygo-build registry
# The tests of the Go language host library and of the Go framework adapters that carry the build constraint e2e: they need a display
# or the activation of a process, and their names start with TestE2E.
E2E_GO_PACKAGES = packages/host/go packages/host/wailsv3 packages/host/mygo
e2e-host-go: native-darwin
	@for package in $(E2E_GO_PACKAGES); do $(GO_ENV) go -C $$package test -tags e2e,diagnostics -run '^TestE2E' -ldflags "$(GO_LINK)" ./tests/... || exit 1; done

e2e: docs-check e2e-check exposure-check $(E2E_BUILD)
	@node scripts/e2e-run.mjs --script verify --native e2e $(if $(WHEN_IDLE),--when-idle $(WHEN_IDLE))

e2e-activation: $(E2E_BUILD)
	@node scripts/e2e-run.mjs --script verify:activation --native e2e-activation

e2e-real: $(E2E_BUILD)
	@node scripts/e2e-run.mjs --script verify:real

e2e-person: $(E2E_BUILD)
	@node scripts/e2e-run.mjs --script verify:person

# These targets run one observation, benchmark or repeat against applications that already run; they build and start nothing.
# Leaves stills of the sections in target/section-design for inspection at original resolution.
e2e-section-design: $(E2E_BUILD)
	@node scripts/e2e-run.mjs --script verify:section-design

e2e-terminal-sidebar-current:
	@pnpm -F @soksak/e2e run verify:terminal-sidebar-current

e2e-terminal-focus-current:
	@pnpm -F @soksak/e2e run verify:terminal-focus-current

e2e-shutdown:
	@pnpm -F @soksak/e2e run verify:shutdown

# B3_OUT=FILE writes the B3 output of the benchmark to FILE (e2e/benchmark/cases/b3-run.mjs). The view drag and the resize catch-up
# measure in two states and take with B3_OUT the state TRACE, one of the state names of the benchmark in B3_MEASUREMENTS of
# e2e/benchmark/measurements.mjs: TRACE=0|frame-records for the view drag and TRACE=captured|frame-records for the resize catch-up; the
# view drag takes ACCESSIBILITY=1, FLOOR=1 and GC_LOOP=1 (e2e/benchmark/cases/view-drag.mjs). The benchmark refuses a value that it does
# not take.
B3_BENCHMARK_ENV = $(if $(B3_OUT),SOKSAK_B3_OUT="$(abspath $(B3_OUT))") $(if $(TRACE),SOKSAK_B3_TRACE="$(TRACE)")
e2e-benchmark-view-drag:
	@$(B3_BENCHMARK_ENV) $(if $(ACCESSIBILITY),SOKSAK_ACCESSIBILITY="$(ACCESSIBILITY)") $(if $(FLOOR),SOKSAK_FLOOR="$(FLOOR)") \
	  $(if $(GC_LOOP),SOKSAK_GC_LOOP="$(GC_LOOP)") pnpm -F @soksak/e2e run benchmark:view-drag

e2e-benchmark-resize-catch-up:
	@$(B3_BENCHMARK_ENV) pnpm -F @soksak/e2e run benchmark:resize-catch-up

# The benchmark of an empty mygo window (docs/operations/examples.md#empty-window-benchmark): it opens a window of the framework without
# the mygo framework adapter. SECONDS is the time over which it reads the CPU.
e2e-benchmark-empty-window:
	@go -C packages/host/mygo run ./benchmark/cmd $(if $(SECONDS),--seconds $(SECONDS))

e2e-benchmark-idle-tab:
	@$(B3_BENCHMARK_ENV) pnpm -F @soksak/e2e run benchmark:idle-tab

e2e-benchmark-split-load:
	@$(B3_BENCHMARK_ENV) pnpm -F @soksak/e2e run benchmark:split-load

e2e-benchmark-plain-view:
	@pnpm -F @soksak/e2e run benchmark:plain-view

# The time from a key to the prompt in an open application (docs/operations/examples.md#input-latency): APP names the application, by
# default mygo, and SOKSAK_CONFIG_DIR the configuration folder that the application runs with.
e2e-input-latency:
	@$(B3_BENCHMARK_ENV) SOKSAK_APP=$(or $(APP),mygo) node scripts/node-tests.mjs --script benchmark:input-latency --concurrency 1 --timeout 600

e2e-repeat:
	@case "$(FILE)" in '') echo "e2e-repeat requires FILE=<test file> NAME=<test name pattern> COUNT=<n>" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "e2e-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@pnpm -F @soksak/e2e run repeat --file '$(FILE)' --name '$(NAME)' --count $(COUNT)

# The three-host benchmark B3 (scripts/e2e-b3.mjs, docs/operations/examples.md#three-host-benchmark): it checks the BASELINE checkout
# against target/b3/baseline.json, builds the release bundles of this checkout and of BASELINE and the two registry indexes, starts and
# quits each application for each run of each scenario and writes one session folder under target/b3 for make b3-judge. It runs
# STEP=pointer, which brings a window to the front, so it runs with the Accessibility permission and the approval of the real-input tier.
e2e-b3:
	@case "$(PHASE)" in 1|final) ;; *) echo "e2e-b3 requires PHASE=1|final RUNS=<n> BASELINE=<checkout>" >&2; exit 2;; esac
	@case "$(RUNS)" in ''|*[!0-9]*|0*) echo "e2e-b3 requires PHASE=1|final RUNS=<n> BASELINE=<checkout>" >&2; exit 2;; esac
	@case "$(BASELINE)" in '') echo "e2e-b3 requires PHASE=1|final RUNS=<n> BASELINE=<checkout>" >&2; exit 2;; esac
	@node scripts/e2e-b3.mjs --phase $(PHASE) --runs $(RUNS) --baseline "$(BASELINE)"

# Judges a session folder of make e2e-b3 against docs/spec/performance-goals.json without starting an application and prints each
# value with its runs, its spread and its result (scripts/b3-judge.mjs, docs/operations/examples.md#three-host-benchmark).
b3-judge:
	@case "$(SESSION)" in '') echo "b3-judge requires SESSION=<session folder of make e2e-b3>" >&2; exit 2;; esac
	@node scripts/b3-judge.mjs --session "$(SESSION)"

# The two-profile builds of the three apps and their sizes.
examples-size: tauriv2-build tauriv2-build-release wailsv3-build-release wailsv3-build mygo-build mygo-build-release
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
