SHELL := /bin/sh

.PHONY: check-commands check-push check-events benchmark-rust benchmark-go check-tools install build test-all check-browser-example check-docs check-commits install-hooks check-boundaries check-platform-files check-windows-build check-host-files check-app-tests create-test-certificates test-app-terminal-sidebar-current test-app-terminal-focus-current test-app-shutdown benchmark-view-drag benchmark-resize-catch-up benchmark-idle-tab benchmark-split-load repeat-app-test check-exposure check-tests check-hosts-same test-language check-release test-rust-alone repeat-rust repeat-go repeat-node check-temp-files measure-page-memory measure-object-counts measure-host-calls measure-app-usage measure-terminal-redraw measure-trace-share measure-host-allocations check-app-update

check-docs:
	@node scripts/check-docs.mjs
	@node scripts/check-failure-table.mjs
	@pnpm exec sok-check docs

# Checks the names of the executables and make targets of this repository (AGENTS.md Implementation).
check-commands:
	@pnpm exec sok-check commands

# Checks the commit message form of RANGE, which holds one or more revision ranges separated by spaces. Example: make check-commits RANGE=origin/main..HEAD
check-commits:
	@test -n "$(RANGE)" || { echo "make check-commits RANGE=<revision range>" >&2; exit 2; }
	@pnpm exec sok-check commits $(RANGE)

# Sets the git hook folder of this checkout to .githooks. The commit-msg hook checks the commit message form.
install-hooks:
	@git config core.hooksPath .githooks

# Runs before a push (the pre-push hook of `make install-hooks`): the commit messages of RANGE, because a published commit message is kept.
# CI runs every other check on the pushed commits, a later commit corrects a failure, and the release gate releases only a green run.
# The pre-push hook sets RANGE to the commits of each pushed ref (scripts/push-range.mjs). Without RANGE, the commits are origin/main..HEAD:
# the commits that the remote main branch does not have. This range exists on every branch, while @{upstream}..HEAD fails with git exit 128
# on a branch without an upstream, which a new branch has until its first push.
check-push:
	@$(MAKE) --no-print-directory check-commits RANGE="$(or $(RANGE),origin/main..HEAD)"

# Builds release and checks that the staged frontend and the release executables hold no diagnostic code.
check-release: build-wailsv3-release build-tauriv2-release
	@node scripts/check-release.mjs --macos-minimum $(MACOS_MINIMUM) --wailsv3-bundle "$(WAILS_RELEASE_BUNDLE)" --tauriv2-bundle "$(TAURI_RELEASE_BUNDLE)"

# Measures the memory of the main page process of a running application at start, idle, and after reload (docs/operations/examples.md).
# APP is wailsv3 or tauriv2, CONFIG is the configuration folder of that application, BUILD is release (default) or debug.
# HOST is wailsv3 or tauriv2. Checks with a copy of the built debug bundle that an application update replaces the bundle.
check-app-update:
	@case "$(HOST)" in wailsv3|tauriv2) ;; *) echo "check-app-update requires HOST=wailsv3|tauriv2" >&2; exit 2;; esac
	@node scripts/check-app-update.mjs --host $(HOST) --bundle target/debug/sok-$(HOST).app --registry target/registry/index.json

measure-page-memory:
	@case "$(APP)" in wailsv3|tauriv2) ;; *) echo "measure-page-memory requires APP=wailsv3|tauriv2 CONFIG=DIR [BUILD=release|debug] [MINUTES=60] [RELOADS=20]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "measure-page-memory requires CONFIG=DIR" >&2; exit 2;; esac
	@case "$(BUILD)" in ''|release|debug) ;; *) echo "measure-page-memory requires BUILD=release|debug" >&2; exit 2;; esac
	@node scripts/measure-page-memory.mjs --sok $(if $(filter debug,$(BUILD)),target/debug/sok-$(APP).app,target/release/$(APP)/soksak.app)/Contents/MacOS/sok --config-dir "$(CONFIG)" --idle-minutes $(or $(MINUTES),60) --reloads $(or $(RELOADS),20)

# Repeats the operations of scripts/measure-object-counts.mjs for the surface plugins PLUGINS REPETITIONS times against a running diagnostic build and prints
# the object counts and footprints per repetition (docs/plans/document-streams-and-memory.md). The diagnostic methods exist only in diagnostic builds, so BUILD defaults to debug.
measure-object-counts:
	@case "$(APP)" in wailsv3|tauriv2) ;; *) echo "measure-object-counts requires APP=wailsv3|tauriv2 CONFIG=DIR PLUGINS='ID...' [BUILD=release|debug] [REPETITIONS=20]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "measure-object-counts requires CONFIG=DIR" >&2; exit 2;; esac
	@case "$(strip $(PLUGINS))" in '') echo "measure-object-counts requires PLUGINS='ID...', the surface plugins whose tabs it opens" >&2; exit 2;; esac
	@case "$(BUILD)" in ''|debug|release) ;; *) echo "measure-object-counts requires BUILD=release|debug" >&2; exit 2;; esac
	@node scripts/measure-object-counts.mjs --sok $(if $(filter release,$(BUILD)),target/release/$(APP)/soksak.app,target/debug/sok-$(APP).app)/Contents/MacOS/sok --config-dir "$(CONFIG)" $(foreach plugin,$(PLUGINS),--plugin $(plugin)) --repetitions $(or $(REPETITIONS),20)

# Has the main page of a running diagnostic build send CALLS host calls ROUNDS times and prints the footprint of its page process before the calls, after
# them and after a collection (scripts/measure-host-calls.mjs); MINUTES=M waits M minutes without input instead of the calls;
# EVENTS=N has the host send N host events that the page does not listen to instead of the calls. The diagnostic methods exist only in diagnostic builds.
measure-host-calls:
	@case "$(APP)" in wailsv3|tauriv2) ;; *) echo "measure-host-calls requires APP=wailsv3|tauriv2 CONFIG=DIR [CALLS=1000 | MINUTES=M | EVENTS=N] [ROUNDS=5]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "measure-host-calls requires CONFIG=DIR" >&2; exit 2;; esac
	@node scripts/measure-host-calls.mjs --sok target/debug/sok-$(APP).app/Contents/MacOS/sok --config-dir "$(CONFIG)" --calls $(or $(CALLS),1000) --idle-minutes $(or $(MINUTES),0) --events $(or $(EVENTS),0) --rounds $(or $(ROUNDS),5)

# Reports the CPU and memory of the running application of CONFIG_DIR by process: host, sidecars, pages, documents and WebKit processes
# (scripts/measure-app-usage.mjs, docs/operations/examples.md). SOK defaults to the sok binary of target/debug.
measure-app-usage:
	@case "$(CONFIG_DIR)" in '') echo "measure-app-usage requires CONFIG_DIR=DIR [INTERVAL=10] [SOK=PATH]" >&2; exit 2;; esac
	@node scripts/measure-app-usage.mjs --sok $(or $(SOK),target/debug/sok) --config-dir "$(CONFIG_DIR)" --interval $(or $(INTERVAL),10)

# Reports the CPU of each process of the running application of CONFIG_DIR while the terminal SURFACE redraws a status block at RATE frames
# per second (scripts/measure-terminal-redraw.mjs, docs/operations/examples.md). SOK defaults to the sok binary of target/debug.
measure-terminal-redraw:
	@case "$(CONFIG_DIR)" in '') echo "measure-terminal-redraw requires CONFIG_DIR=DIR SURFACE=TAB [RATE=20] [INTERVAL=10] [SOK=PATH]" >&2; exit 2;; esac
	@case "$(SURFACE)" in '') echo "measure-terminal-redraw requires SURFACE=TAB" >&2; exit 2;; esac
	@node scripts/measure-terminal-redraw.mjs --sok $(or $(SOK),target/debug/sok) --config-dir "$(CONFIG_DIR)" --surface "$(SURFACE)" --rate $(or $(RATE),20) --interval $(or $(INTERVAL),10)

# Measures the share of the diagnostics in the memory of a running host: with the debug switch on and then off, it runs five repetitions of
# object-counts and prints the footprint of the host process (docs/operations/examples.md).
measure-trace-share:
	@case "$(APP)" in wailsv3|tauriv2) ;; *) echo "measure-trace-share requires APP=wailsv3|tauriv2 CONFIG=DIR PLUGINS='ID...'" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "measure-trace-share requires CONFIG=DIR" >&2; exit 2;; esac
	@sok=target/debug/sok-$(APP).app/Contents/MacOS/sok; \
	  pid=$$(pgrep -f "sok-$(APP).app/Contents/MacOS/sok-$(APP) --config-dir $(CONFIG)" | head -1); \
	  test -n "$$pid" || { echo "trace-share: no running $(APP) with --config-dir $(CONFIG)" >&2; exit 1; }; \
	  for on in true false; do \
	    echo "start debug=$$on"; \
	    $$sok core.settings.debug --config-dir "$(CONFIG)" --params "{\"on\":$$on}" > /dev/null || exit 1; \
	    $(MAKE) --no-print-directory measure-object-counts APP=$(APP) CONFIG="$(CONFIG)" PLUGINS="$(PLUGINS)" BUILD=debug REPETITIONS=5 > /dev/null 2>&1 || exit 1; \
	    echo "end debug=$$on host $$pid $$(footprint -p $$pid | grep -o 'Footprint: [0-9.]* [KMG]*B' | head -1)"; \
	  done

# Prints the live malloc nodes and bytes of a running host process at start and after each minute (docs/operations/examples.md).
measure-host-allocations:
	@case "$(PID)" in ''|*[!0-9]*) echo "measure-host-allocations requires PID=<host process> [MINUTES=10]" >&2; exit 2;; esac
	@node scripts/measure-host-allocations.mjs --pid $(PID) --minutes $(or $(MINUTES),10)

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

# JS/TS, Rust, Go, Objective-C, and shell test cases use the same observable case contract.
test-language: build-native
	@$(MAKE) -C native/darwin $(CURDIR)/native/darwin/build/appearance_test
	@node scripts/language-test-adapters.mjs scripts/language-test-cases.json

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
test-rust-alone:
	@case "$(PACKAGE)" in '') echo "test-rust-alone requires PACKAGE=<cargo package> [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@$(CARGO_ENV) cargo test --locked -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --no-run
	@$(CARGO_ENV) node scripts/rust-tests.mjs --manifest $(MANIFEST) --package $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --count 1 --timeout $(TEST_TIMEOUT)

# Runs the tests of a Rust package COUNT times in sequence. With TEST, runs only the test of that name.
# This target reproduces and accepts an intermittent failure. At the first failure it reports the run number, the system load, and the output of that run.
# Measures the cost of the recorder. It is not a test: it prints numbers and asserts nothing. The Rust writer is measured with cargo bench and the native ring with the benchmark of native/darwin.
benchmark-rust:
	@$(CARGO_ENV) node scripts/benchmarks.mjs cargo event_log_benchmark --timeout $(BENCH_TIMEOUT) -- cargo bench --manifest-path $(MANIFEST) -p soksak-host-tauriv2 --bench event_log_benchmark
	@$(CARGO_ENV) node scripts/benchmarks.mjs cargo event_native_benchmark --timeout $(BENCH_TIMEOUT) -- cargo bench --manifest-path $(MANIFEST) -p soksak-host-tauriv2 --bench event_native_benchmark

benchmark-go:
	@$(GO_ENV) node scripts/benchmarks.mjs go ./packages/host/wailsv3/tests 'EventLogEmit|NativePull' --timeout $(BENCH_TIMEOUT) --ldflags='$(GO_LINK)'

repeat-rust:
	@case "$(PACKAGE)" in '') echo "repeat-rust requires PACKAGE=<cargo package> COUNT=<n> [TEST_TARGET=lib|test:<target>] [TEST=<name>] [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-rust requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@$(CARGO_ENV) node scripts/rust-tests.mjs --manifest $(MANIFEST) --package $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) $(if $(filter undefined,$(origin TEST_TARGET)),,--test-target "$$TEST_TARGET") $(if $(TEST),--test '$(TEST)') --count $(COUNT) --timeout $(TEST_TIMEOUT)

# Runs the tests of the Go packages of PACKAGE COUNT times in sequence. TEST is the go test -run regular expression and TAGS is the go test -tags value.
# Each test of each package is its own process with the limit TEST_TIMEOUT, named when it starts and reported with its result and elapsed time (scripts/go-tests.mjs).
# A pattern whose packages have no test files fails when none has test files; a run in which no test matches fails.
# This target reproduces and accepts an intermittent failure. The runner reports the run number and the system load at the first failure.
repeat-go:
	@case "$(PACKAGE)" in '') echo "repeat-go requires PACKAGE=<go package path> COUNT=<n> [TEST=<regexp>] [TAGS=<tags>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-go requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@cgo=$$(node scripts/go-repeat-inputs.mjs '$(PACKAGE)' '$(TAGS)') || exit 1; \
	  CGO_CFLAGS="$(GO_CFLAGS) $$cgo" node scripts/go-tests.mjs --package '$(PACKAGE)' $(if $(TAGS),--tags '$(TAGS)') $(if $(TEST),--test '$(TEST)') --count $(COUNT) --timeout $(TEST_TIMEOUT) --ldflags='$(GO_LINK)'

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

# Compiles the sources of the two native hosts for the Windows target in the default build and the diagnostic build. The file layout checks of platforms and check-host-files
# do not check the Windows implementation (platform/windows/) or the operating system API use of shared code, so this check
# verifies them by compilation. Host tests run only on macOS (docs/spec/host-contract.md), so they are not compiled.
WINDOWS_GOARCH      = arm64
check-windows-build:
	@echo "START: wailsv3 host go vet GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/wailsv3 && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet ./src/...
	@echo "PASS: wailsv3 host for windows/$(WINDOWS_GOARCH)"
	@echo "START: wailsv3 host go vet -tags diagnostics GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/wailsv3 && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet -tags diagnostics ./src/...
	@echo "PASS: wailsv3 diagnostics host for windows/$(WINDOWS_GOARCH)"

# Checks that the file structures of the two native hosts and the two native apps differ only in the allowed ways.
check-host-files: check-windows-build
	@node scripts/check-host-files.mjs

check-tools:
	@scripts/check-tools.sh

install: check-tools
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile

build: install
	@pnpm build

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
# The declared core release candidate is the RELEASE constant of scripts/check-versions.mjs.
DIAGNOSTIC_RELEASE := $(filter 0.0.%,$(shell sed -n 's/^export const RELEASE = "\(.*\)";$$/\1/p' scripts/check-versions.mjs))
.PHONY: build-native fetch-native build-registry install-registry install-plugins copy-frontend-browser run-browser copy-frontend-wailsv3 copy-frontend-tauriv2 copy-core-frontend-wailsv3 copy-core-frontend-tauriv2 test-wailsv3 test-tauriv2 test-hosts check-release-wailsv3 check-release-tauriv2 check-rust-format check-rust-clippy check-go-format \
        tauriv2 tauriv2-release build-tauriv2 build-tauriv2-release \
        wailsv3 wailsv3-release build-wailsv3 build-wailsv3-release \
        e2e test-app-candidate test-app-activation test-app-real test-app-person test-app-section-design measure-examples-size

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
TAURI_DEBUG_BUNDLE   = target/debug/sok-tauriv2.app
TAURI_RELEASE_BUNDLE = target/release/tauriv2/soksak.app
WAILS_DEBUG_BUNDLE   = target/debug/sok-wailsv3.app
WAILS_RELEASE_BUNDLE = target/release/wailsv3/soksak.app
TAURI_DEBUG   = $(TAURI_DEBUG_BUNDLE)/Contents/MacOS/sok-tauriv2
TAURI_RELEASE = $(TAURI_RELEASE_BUNDLE)/Contents/MacOS/sok-tauriv2
WAILS_DEBUG   = $(WAILS_DEBUG_BUNDLE)/Contents/MacOS/sok-wailsv3
WAILS_RELEASE = $(WAILS_RELEASE_BUNDLE)/Contents/MacOS/sok-wailsv3

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
sok-wailsv3 = go build -C packages/sok/wailsv3 $(if $(filter release,$(2)),-trimpath -ldflags "-s -w") $(if $(filter debug,$(2)),-tags "diagnostics dev",$(if $(DIAGNOSTIC_RELEASE),-tags diagnostics)) -o ../../../$(1)/Contents/MacOS/sok ./src/cmd/sok
sok-tauriv2 = $(CARGO_ENV) cargo build --locked -p soksak-sok-tauriv2 $(if $(filter release,$(2)),--release) $(if $(filter debug,$(2)),--features diagnostics$(COMMA)dev,$(if $(DIAGNOSTIC_RELEASE),--features diagnostics)) && cp target/$(2)/sok $(1)/Contents/MacOS/sok

build-native:
	@$(MAKE) -C native/darwin

# Fetches and checksum-validates the pinned native dependency without compiling it.
fetch-native:
	@$(MAKE) -C native/darwin fetch

# The workspace registry. Packs the sibling plugin repositories that scripts/workspace-registry.json declares with their make pack,
# builds every declared sidecar from its repository and releases them for the current platform, and then
# creates index.json in target/registry (docs/spec/plugins.md#repositories).
# Diagnostic builds and window checks install from here.
REGISTRY = target/registry

build-registry:
	@$(CARGO_ENV) cargo build --locked -p soksak-sok-tauriv2
	@node scripts/workspace-registry.mjs --sok target/debug/sok --out $(REGISTRY)

# The installation stage of the workspace: `make install` of every plugin and sidecar repository that scripts/workspace-registry.json
# declares. A fresh checkout runs it once before make build-registry builds and packs those repositories.
install-registry:
	@node scripts/workspace-registry.mjs --install

# Installs every plugin of the workspace registry into the CONFIG configuration folder. Applications do not hold plugins in the bundle, so
# window checks and development runs install with this target before they start the application. Workspace plugins are changed without changing
# the version, so when the same version is already installed the installation changes nothing. Therefore the installed plugins are
# removed first and installed again.
install-plugins: build-registry
	@test -n "$(CONFIG)" || { echo "make install-plugins CONFIG=<configuration directory>" >&2; exit 2; }
	@target/debug/sok registry use $(REGISTRY)/index.json --config-dir "$(CONFIG)"
	@for id in $$(node -e 'const f = "$(CONFIG)/plugins/installed.json"; const fs = require("fs"); console.log(fs.existsSync(f) ? Object.keys(JSON.parse(fs.readFileSync(f, "utf8")).plugins).join(" ") : "")'); do \
		target/debug/sok plugin remove $$id --config-dir "$(CONFIG)" || exit 1; done
	@for id in $$(node -e 'console.log(JSON.parse(require("fs").readFileSync("$(REGISTRY)/index.json", "utf8")).plugins.map((p) => p.id).join(" "))'); do \
		target/debug/sok plugin install $$id --config-dir "$(CONFIG)" || exit 1; done

# Stages the frontend. The argument is an extra flag. debug includes the page diagnostic module (--diagnostics) and release does not
# include it. Plugins and sidecars are not put in the bundle; they are installed into the configuration folder (make install-plugins).
copy-wailsv3 = pnpm -F @soksak/wailsv3 exec sok-copy-frontend src/frontend $(1)
copy-tauriv2 = pnpm -F @soksak/tauriv2 exec sok-copy-frontend src/frontend $(1)

# Staging does not touch the bundle. The bundle is rebuilt only by the build targets. This keeps the executable of the debug app that checks use
# from being removed by the staging of a check target such as test-native.
copy-frontend-wailsv3: build build-registry
	@$(call copy-wailsv3,--diagnostics --registry-index "$(abspath $(REGISTRY)/index.json)")

copy-frontend-tauriv2: build build-registry
	@$(call copy-tauriv2,--diagnostics --registry-index "$(abspath $(REGISTRY)/index.json)")

# Stages only the core frontend for independent host language checks. Registry builds belong to full host and release checks.
copy-core-frontend-wailsv3: build
	@$(call copy-wailsv3,--diagnostics)

copy-core-frontend-tauriv2: build
	@$(call copy-tauriv2,--diagnostics)

# generate_context! includes the frontend, so this rebuilds the crate.
build-tauriv2: build-native copy-frontend-tauriv2
	@$(call bundle-info,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@$(call bundle-dev,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build --locked -p sok-tauriv2 --features diagnostics,dev
	@cp target/debug/sok-tauriv2 $(TAURI_DEBUG)
	@$(call sok-tauriv2,$(TAURI_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(TAURI_DEBUG_BUNDLE))

build-tauriv2-release: build-native build
	@$(call bundle-info,$(TAURI_RELEASE_BUNDLE),tauriv2)
	@$(call copy-tauriv2,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build --locked --release -p sok-tauriv2 $(if $(DIAGNOSTIC_RELEASE),--features diagnostics)
	@cp target/release/sok-tauriv2 $(TAURI_RELEASE)
	@$(call sok-tauriv2,$(TAURI_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(TAURI_RELEASE_BUNDLE))

build-wailsv3: build-native copy-frontend-wailsv3
	@$(call bundle-info,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(call bundle-dev,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(GO_ENV) go build -C apps/wailsv3 -tags "diagnostics dev" -ldflags "$(GO_LINK)" -o ../../$(WAILS_DEBUG) ./src
	@$(call sok-wailsv3,$(WAILS_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(WAILS_DEBUG_BUNDLE))

build-wailsv3-release: build-native build
	@$(call bundle-info,$(WAILS_RELEASE_BUNDLE),wailsv3)
	@$(call copy-wailsv3,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@$(GO_ENV) go build -C apps/wailsv3 -trimpath $(if $(DIAGNOSTIC_RELEASE),-tags diagnostics) -ldflags "-s -w $(GO_LINK)" -o ../../$(WAILS_RELEASE) ./src
	@$(call sok-wailsv3,$(WAILS_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(WAILS_RELEASE_BUNDLE))

run-tauriv2: build-tauriv2
	@./$(TAURI_DEBUG)

run-tauriv2-release: build-tauriv2-release
	@./$(TAURI_RELEASE)

run-wailsv3: build-wailsv3
	@./$(WAILS_DEBUG)

run-wailsv3-release: build-wailsv3-release
	@./$(WAILS_RELEASE)

# Unit checks of native code. Runs the shared input check and the host contract check, which runs the tests of the two hosts.
# The checks of a sidecar run in each sidecar repository.
test-native: build-native copy-core-frontend-wailsv3 copy-core-frontend-tauriv2
	@$(MAKE) check-rust-format
	@$(MAKE) check-rust-clippy
	@$(MAKE) check-go-format
	@$(MAKE) -C native/darwin test
	@$(MAKE) test-hosts

# Checks that every Go file the repository tracks is in gofmt form. Reports every file of a different form and fails.
check-go-format:
	@files=$$(git ls-files '*.go'); \
	  unformatted=$$(gofmt -l $$files) || exit 1; \
	  if [ -n "$$unformatted" ]; then echo "Go files not in gofmt format:" >&2; echo "$$unformatted" >&2; exit 1; fi; \
	  echo "Go format check passed: $$(echo $$files | wc -w | tr -d ' ') files"

# Checks every package and test of the Rust workspace in the diagnostic build and the default build without clippy warnings.
# generate_context! of sok-tauriv2 reads the staged frontend (frontendDist), so the check stages it first, as test-native does.
check-rust-clippy: build-native copy-core-frontend-tauriv2
	@$(CARGO_ENV) cargo clippy --locked --workspace --tests --features soksak-host-tauriv2/diagnostics -- -D warnings
	@$(CARGO_ENV) cargo clippy --locked --workspace --tests -- -D warnings
	@echo "Rust clippy check passed: 1 workspace, diagnostics and default builds"

# Checks that every package of the Rust workspace is in rustfmt form.
check-rust-format:
	@cargo fmt --all --check
	@echo "Rust format check passed: 1 workspace"

# Runs the tests of the two hosts in the default configuration and the diagnostic configuration and checks from the results that the host contract cases
# (docs/spec/host-contract.md) run at the same level.
# Host contract tests build their fixture plugins and sidecars under test-owned temporary directories.
test-hosts: build-native copy-core-frontend-wailsv3 copy-core-frontend-tauriv2
	@$(GO_ENV) $(CARGO_ENV) node scripts/test-hosts.mjs --go-ldflags="$(GO_LINK)"

# Per-language CI checks use the same selected host contract without discovering or building the other host.
test-wailsv3: build-native copy-core-frontend-wailsv3
	@$(GO_ENV) node scripts/test-hosts.mjs --host wailsv3 --go-ldflags="$(GO_LINK)"

test-tauriv2: build-native copy-core-frontend-tauriv2
	@$(CARGO_ENV) node scripts/test-hosts.mjs --host tauriv2

# Release host checks build and audit only the selected application bundle. Registry verification is a separate target.
check-release-wailsv3: build-wailsv3-release
	@node scripts/check-release.mjs --host wailsv3 --macos-minimum $(MACOS_MINIMUM) --wailsv3-bundle "$(WAILS_RELEASE_BUNDLE)"

check-release-tauriv2: build-tauriv2-release
	@node scripts/check-release.mjs --host tauriv2 --macos-minimum $(MACOS_MINIMUM) --tauriv2-bundle "$(TAURI_RELEASE_BUNDLE)"

# The window checks drive running applications in sequence through the local endpoint; the harness does not start them.
# The end-to-end checks (docs/operations/examples.md#test-kinds): the window checks of the running applications and the native
# end-to-end tests. They need a display, so they run only locally. test-app-activation runs the activation tier and test-app-real the
# real-input tier, which a person approves because they activate the applications and change the input source; test-app-person runs
# the checks that a person operates at the machine.
# Each e2e target builds both debug applications and the workspace registry, and scripts/test-app.mjs runs the window-check script
# and the native end-to-end target of its tier in a new configuration root under target/e2e: it starts the applications, runs the
# checks and quits the applications.
E2E_BUILD = build-wailsv3 build-tauriv2 build-registry
test-app: check-docs check-app-tests check-exposure $(E2E_BUILD)
	@node scripts/test-app.mjs --script test-app --native test-app $(if $(WHEN_IDLE),--when-idle $(WHEN_IDLE))

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

test-app-terminal-sidebar-current:
	@pnpm -F @soksak/e2e run test-app:terminal-sidebar-current

test-app-terminal-focus-current:
	@pnpm -F @soksak/e2e run test-app:terminal-focus-current

test-app-shutdown:
	@pnpm -F @soksak/e2e run test-app:shutdown

benchmark-view-drag:
	@pnpm -F @soksak/e2e run benchmark:view-drag

benchmark-resize-catch-up:
	@pnpm -F @soksak/e2e run benchmark:resize-catch-up

benchmark-idle-tab:
	@pnpm -F @soksak/e2e run benchmark:idle-tab

benchmark-split-load:
	@pnpm -F @soksak/e2e run benchmark:split-load

benchmark-plain-view:
	@pnpm -F @soksak/e2e run benchmark:plain-view

repeat-app-test:
	@case "$(FILE)" in '') echo "repeat-app-test requires FILE=<test file> NAME=<test name pattern> COUNT=<n>" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "repeat-app-test requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@pnpm -F @soksak/e2e run repeat --file '$(FILE)' --name '$(NAME)' --count $(COUNT)

# The two-profile builds of the two apps and their sizes.
measure-examples-size: build-tauriv2 build-tauriv2-release build-wailsv3-release build-wailsv3
	@printf "%-10s %10s %10s\n" "" debug release
	@printf "%-10s %9.1fM %9.1fM\n" tauriv2 \
	  $$(echo "$$(stat -f%z $(TAURI_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(TAURI_RELEASE))/1048576" | bc -l)
	@printf "%-10s %9.1fM %9.1fM\n" wailsv3 \
	  $$(echo "$$(stat -f%z $(WAILS_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(WAILS_RELEASE))/1048576" | bc -l)
