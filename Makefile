SHELL := /bin/sh

.PHONY: push-check events-check census-check failures-check benchmark-rust benchmark-go preflight prepare build verify browser-example-check registry-manifest-check docs-check records-check commits-check hooks boundaries platforms windows-build-check hosts-check e2e-check e2e-registry-tls exposure-check parity-check host-parity-check language-test release-check rust-tests-alone rust-repeat go-repeat node-repeat page-memory host-allocations app-update-check

docs-check:
	@node scripts/check-docs.mjs
	@node scripts/check-failure-table.mjs
	@node packages/plugin-api/records-check.js

# Checks that the documents and configuration comments state only facts about the repository (AGENTS.md Documentation).
records-check:
	@node packages/plugin-api/records-check.js

# Checks the commit message form of RANGE. Example: make commits-check RANGE=origin/main..HEAD
commits-check:
	@test -n "$(RANGE)" || { echo "make commits-check RANGE=<revision range>" >&2; exit 2; }
	@node packages/plugin-api/commits-check.js "$(RANGE)"

# Sets the git hook folder of this checkout to .githooks. The commit-msg hook checks the commit message form.
hooks:
	@git config core.hooksPath .githooks

# Runs before a push (the pre-push hook of `make hooks`): the commit messages that are not on the upstream branch, the checks of
# the structure step of ci.yml, its format and clippy checks, and the census and fallback tests of the sources. The host tests, the package tests and the window checks are left
# to CI.
push-check:
	@$(MAKE) --no-print-directory commits-check RANGE=@{upstream}..HEAD
	@$(MAKE) --no-print-directory docs-check boundaries platforms hosts-check exposure-check parity-check host-parity-check migrations-check
	@$(MAKE) --no-print-directory rust-format-check go-format-check rust-clippy-check
	@node --test scripts/test/census.test.mjs scripts/test/fallbacks.test.mjs

# Builds release and checks that the staged frontend and the release executables hold no diagnostic code.
release-check: wailsv3-build-release tauriv2-build-release registry-manifest-check
	@node scripts/check-release.mjs --macos-minimum $(MACOS_MINIMUM) --wailsv3-bundle "$(WAILS_RELEASE_BUNDLE)" --tauriv2-bundle "$(TAURI_RELEASE_BUNDLE)"

# Checks that the core of this checkout accepts the manifest of every plugin version of the public registry that it
# installs (docs/operations/examples.md).
registry-manifest-check:
	@node scripts/check-registry-manifests.mjs

# Measures the memory of the main page process of a running application at start, idle, and after reload (docs/operations/examples.md).
# APP is wailsv3 or tauriv2, CONFIG is the configuration folder of that application, BUILD is release (default) or debug.
# HOST is wailsv3 or tauriv2. Checks with a copy of the built debug bundle that an application update replaces the bundle.
app-update-check:
	@case "$(HOST)" in wailsv3|tauriv2) ;; *) echo "app-update-check requires HOST=wailsv3|tauriv2" >&2; exit 2;; esac
	@node scripts/check-app-update.mjs --host $(HOST) --bundle target/debug/soksak-$(HOST).app --registry target/registry/index.json

page-memory:
	@case "$(APP)" in wailsv3|tauriv2) ;; *) echo "page-memory requires APP=wailsv3|tauriv2 CONFIG=DIR [BUILD=release|debug] [MINUTES=60] [RELOADS=20]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "page-memory requires CONFIG=DIR" >&2; exit 2;; esac
	@case "$(BUILD)" in ''|release|debug) ;; *) echo "page-memory requires BUILD=release|debug" >&2; exit 2;; esac
	@node scripts/measure-page-memory.mjs --sok $(if $(filter debug,$(BUILD)),target/debug/soksak-$(APP).app,target/release/$(APP)/soksak.app)/Contents/MacOS/sok --config-dir "$(CONFIG)" --idle-minutes $(or $(MINUTES),60) --reloads $(or $(RELOADS),20)

# Prints the live malloc nodes and bytes of a running host process at start and after each minute (docs/operations/examples.md).
host-allocations:
	@case "$(PID)" in ''|*[!0-9]*) echo "host-allocations requires PID=<host process> [MINUTES=10]" >&2; exit 2;; esac
	@node scripts/measure-host-allocations.mjs --pid $(PID) --minutes $(or $(MINUTES),10)

# Copies the migration definitions from their single source into both command line packages (the Go embed reads inside
# its package); the copies are tracked, and migrations-check refuses a difference.
migrations-sync:
	@cp packages/sok/migrations/installed.json packages/sok/wailsv3/src/migrations/installed.json
	@cp packages/sok/migrations/installed.json packages/sok/tauriv2/src/migrations/installed.json

migrations-check:
	@for p in packages/sok/wailsv3 packages/sok/tauriv2; do cmp -s packages/sok/migrations/installed.json $$p/src/migrations/installed.json || { echo "$$p/src/migrations/installed.json differs from packages/sok/migrations/installed.json; run make migrations-sync" >&2; exit 1; }; done
	@echo "Migration definition checks passed"

# Checks that core, plugin, and sidecar sources do not name each other.
boundaries:
	@node scripts/check-boundaries.mjs

# Checks that the sources name every event declared in docs/spec/events.json. The audit of the logs that window checks leave is
# `node scripts/check-events.mjs --logs <configuration folder>...` (docs/operations/examples.md).
events-check:
	@node scripts/check-events.mjs

# Applies the census rules of packages/plugin-api/census-rules.json to the sources (docs/spec/logging.md#census): a source of occurrences has an event
# in its function or a reason marker, and a rule that waits for an entrance item is printed with its count. `--list` also prints each pending finding.
census-check:
	@node packages/plugin-api/events-check.js --census scripts/census.json

# Checks that every error record whose place is written in the sources of the hosts and the native library has a row in the failure table of docs/spec/diagnostics.md.
failures-check:
	@node scripts/check-failure-table.mjs

# The TLS certificates of the registry window check (docs/operations/examples.md). Creates a certificate authority owned by the check and a server certificate for 127.0.0.1.
# The check application of a diagnostic build starts with --registry-ca <folder>/ca.pem. An existing certificate is not replaced.
E2E_REGISTRY_TLS = $(or $(SOKSAK_CONFIG_ROOT),$(TMPDIR))/soksak-check-registry-tls
e2e-registry-tls:
	@test -n "$(or $(SOKSAK_CONFIG_ROOT),$(TMPDIR))" || { echo "e2e-registry-tls needs TMPDIR or SOKSAK_CONFIG_ROOT" >&2; exit 2; }
	@if [ -f "$(E2E_REGISTRY_TLS)/ca.pem" ]; then echo "$(E2E_REGISTRY_TLS)"; exit 0; fi; \
	  set -e; mkdir -p "$(E2E_REGISTRY_TLS)"; cd "$(E2E_REGISTRY_TLS)"; \
	  printf 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext; \
	  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=soksak check registry authority" \
	    -keyout ca-key.pem -out ca.pem -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign 2>/dev/null; \
	  openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout server-key.pem -out server.csr 2>/dev/null; \
	  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3650 -extfile server.ext -out server.pem 2>/dev/null; \
	  rm -f server.csr ca.srl server.ext; echo "$(E2E_REGISTRY_TLS)"

# Checks that window checks use only the declared entries of the endpoint and native input.
# Opens a project in the staged browser example and checks with headless Chrome that no page error occurs.
browser-example-check: browser-frontend
	@pnpm -F @soksak/browser check

# The browser example has no host, so BROWSER_PLUGINS are installed into BROWSER_CONFIG and the staging provides that installation as a host does
# (the staging layout of docs/spec/plugins.md).
BROWSER_CONFIG = target/browser-config
BROWSER_PLUGINS = terminal browser

browser-frontend: registry
	@rm -rf $(BROWSER_CONFIG)
	@target/debug/sok registry use $(REGISTRY)/index.json --config-dir $(BROWSER_CONFIG)
	@for id in $(BROWSER_PLUGINS); do target/debug/sok plugin install $$id --config-dir $(BROWSER_CONFIG) || exit 1; done
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
rust-tests-alone:
	@case "$(PACKAGE)" in '') echo "rust-tests-alone requires PACKAGE=<cargo package> [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --no-run
	@names=$$(cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) -- --list 2>/dev/null | sed -n 's/: test$$//p'); \
	  count=0; for name in $$names; do \
	    count=$$((count + 1)); \
	    cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) -- --exact "$$name" > /dev/null 2>&1 \
	      || { echo "FAIL: $(PACKAGE) $$name fails when it runs alone (test $$count)" >&2; exit 1; }; \
	  done; \
	  [ $$count -gt 0 ] || { echo "rust-tests-alone found no tests in $(PACKAGE)" >&2; exit 1; }; \
	  echo "$(PACKAGE): $$count tests pass alone"

# Runs the tests of a Rust package COUNT times in sequence. With TEST, runs only the test of that name.
# This target reproduces and accepts an intermittent failure. At the first failure it reports the run number, the system load, and the output of that run.
# Measures the cost of the recorder. It is not a test: it prints numbers and asserts nothing. The Rust writer is measured with cargo bench and the native ring with the benchmark of native/darwin.
benchmark-rust:
	@$(CARGO_ENV) cargo bench --manifest-path $(MANIFEST) -p soksak-host-tauriv2 --bench event_log_benchmark --bench event_native_benchmark

benchmark-go:
	@$(GO_ENV) go test -count=1 -ldflags "$(GO_LINK)" -run '^$$' -bench 'EventLogEmit|NativePull' -benchtime 1x -v ./packages/host/wailsv3/tests

rust-repeat:
	@case "$(PACKAGE)" in '') echo "rust-repeat requires PACKAGE=<cargo package> COUNT=<n> [TEST=<name>] [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "rust-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --no-run
	@output=$$(mktemp); trap 'rm -f "$$output"' EXIT; \
	  run=1; while [ $$run -le $(COUNT) ]; do \
	    if [ -n "$(TEST)" ]; then cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) -- --exact "$(TEST)" > "$$output" 2>&1; \
	    else cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) > "$$output" 2>&1; fi \
	      || { cat "$$output"; echo "FAIL: $(PACKAGE) $(TEST) run $$run of $(COUNT); load $$(sysctl -n vm.loadavg)" >&2; exit 1; }; \
	    if [ -n "$(TEST)" ] && ! grep -q "1 passed" "$$output"; then cat "$$output"; echo "FAIL: $(PACKAGE) has no test named $(TEST)" >&2; exit 1; fi; \
	    run=$$((run + 1)); \
	  done; \
	  echo "$(PACKAGE) $(TEST): $(COUNT) of $(COUNT) runs pass"

# Runs the tests of a Go package COUNT times in sequence. TEST is the go test -run regular expression and TAGS is the go test -tags value.
# A run with no built test file (build tag) or no test of a matching name fails.
# This target reproduces and accepts an intermittent failure. At the first failure it reports the run number, the system load, and the output of that run.
go-repeat:
	@case "$(PACKAGE)" in '') echo "go-repeat requires PACKAGE=<go package path> COUNT=<n> [TEST=<regexp>] [TAGS=<tags>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "go-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@output=$$(mktemp); trap 'rm -f "$$output"' EXIT; \
	  run=1; while [ $$run -le $(COUNT) ]; do \
	    $(GO_ENV) go test -count=1 $(if $(TAGS),-tags '$(TAGS)') -ldflags "$(GO_LINK)" $(if $(TEST),-run '$(TEST)') $(PACKAGE) > "$$output" 2>&1 \
	      || { cat "$$output"; echo "FAIL: $(PACKAGE) $(TEST) run $$run of $(COUNT); load $$(sysctl -n vm.loadavg)" >&2; exit 1; }; \
	    if grep -q "no tests to run" "$$output"; then cat "$$output"; echo "FAIL: $(PACKAGE) has no test matching $(TEST)" >&2; exit 1; fi; \
	    if grep -q "no test files" "$$output"; then cat "$$output"; echo "FAIL: $(PACKAGE) has no test files built with tags '$(TAGS)'" >&2; exit 1; fi; \
	    run=$$((run + 1)); \
	  done; \
	  echo "$(PACKAGE) $(TEST): $(COUNT) of $(COUNT) runs pass"

# Runs the tests whose name matches the pattern in a Node test file COUNT times in sequence from the repository root.
# This target reproduces and accepts an intermittent failure. At the first failure it reports the run number, the system load, and the output of that run.
# The executed tests are counted in the TAP result, which is machine-readable. The human-readable output carries color codes depending on the environment, and when no test matches the name
# the file itself is reported as one passing result, so only results whose title matches the name pattern and that are not skipped are counted.
node-repeat: SHELL := /bin/bash -o pipefail
node-repeat:
	@case "$(FILE)" in '') echo "node-repeat requires FILE=<test file> NAME=<test name pattern> COUNT=<n>" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "node-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@output=$$(mktemp); trap 'rm -f "$$output"' EXIT; \
	  run=1; while [ $$run -le $(COUNT) ]; do \
	    echo "START: $(FILE) $(NAME) run $$run of $(COUNT)"; \
	    node --test --experimental-test-module-mocks --test-reporter=tap --test-name-pattern='$(NAME)' $(FILE) 2>&1 | tee "$$output" \
	      || { echo "FAIL: $(FILE) $(NAME) run $$run of $(COUNT); load $$(sysctl -n vm.loadavg)" >&2; exit 1; }; \
	    sed -nE 's/^[[:space:]]*ok [0-9]+ - //p' "$$output" | grep -v '# SKIP' | grep -qE -- '$(NAME)' \
	      || { echo "FAIL: no test in $(FILE) matched $(NAME)" >&2; exit 1; }; \
	    run=$$((run + 1)); \
	  done; \
	  echo "$(FILE) $(NAME): $(COUNT) of $(COUNT) runs pass"

# Checks that operating-system-specific code exists only under platform/<os>/.
platforms:
	@node scripts/check-platforms.mjs

# Compiles the sources of the two native hosts for the Windows target in the default build and the diagnostic build. The file layout checks of platforms and hosts-check
# do not check the Windows implementation (platform/windows/) or the operating system API use of shared code, so this check
# verifies them by compilation. Host tests run only on macOS (docs/spec/host-contract.md), so they are not compiled.
WINDOWS_GOARCH      = arm64
windows-build-check:
	@echo "START: wailsv3 host go vet GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/wailsv3 && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet ./src/...
	@echo "PASS: wailsv3 host for windows/$(WINDOWS_GOARCH)"
	@echo "START: wailsv3 host go vet -tags diagnostics GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/wailsv3 && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet -tags diagnostics ./src/...
	@echo "PASS: wailsv3 diagnostics host for windows/$(WINDOWS_GOARCH)"

# Checks that the file structures of the two native hosts and the two native apps differ only in the allowed ways.
hosts-check: windows-build-check
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
# The declared release version is the RELEASE constant of scripts/check-versions.mjs.
DIAGNOSTIC_RELEASE := $(filter 0.0.%,$(shell sed -n 's/^export const RELEASE = "\(.*\)";$$/\1/p' scripts/check-versions.mjs))
.PHONY: native-darwin registry install-plugins browser-frontend browser-example frontend-wailsv3 frontend-tauriv2 native-test host-contract-check rust-format-check rust-clippy-check go-format-check \
        tauriv2 tauriv2-release tauriv2-build tauriv2-build-release \
        wailsv3 wailsv3-release wailsv3-build wailsv3-build-release \
        examples-verify examples-size

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
GO_ENV       = CGO_CFLAGS="-O2 -g -mmacosx-version-min=$(MACOS_MINIMUM) -DSOKSAK_DARWIN_LIBRARY=$$(shasum -a 256 native/darwin/build/libsoksak-darwin.a | cut -c1-16)"
GO_LINK      = -extldflags=-mmacosx-version-min=$(MACOS_MINIMUM)
CARGO_ENV    = MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM)

# The notification center of macOS delivers only to processes started from a bundle, so applications run from the bundle
# (docs/spec/hosts.md). Sidecars are also placed in Contents/MacOS of the bundle.
TAURI_DEBUG_BUNDLE   = target/debug/soksak-tauriv2.app
TAURI_RELEASE_BUNDLE = target/release/tauriv2/soksak.app
WAILS_DEBUG_BUNDLE   = target/debug/soksak-wailsv3.app
WAILS_RELEASE_BUNDLE = target/release/wailsv3/soksak.app
TAURI_DEBUG   = $(TAURI_DEBUG_BUNDLE)/Contents/MacOS/soksak-tauriv2
TAURI_RELEASE = $(TAURI_RELEASE_BUNDLE)/Contents/MacOS/soksak-tauriv2
WAILS_DEBUG   = $(WAILS_DEBUG_BUNDLE)/Contents/MacOS/soksak-wailsv3
WAILS_RELEASE = $(WAILS_RELEASE_BUNDLE)/Contents/MacOS/soksak-wailsv3

# Writes the Info.plist and the Dock icon of the bundle. The first argument is the bundle and the second is the application. The app name
# is set by CFBundleDisplayName of Info.plist (the supported languages are declared in CFBundleLocalizations of the same plist).
# When the name differs by language, the .lproj/InfoPlist.strings of that language is added again at that time.
# The Contents of the bundle are created anew at each build. A file that an earlier build put there (such as a sidecar that the bundle no longer holds)
# would otherwise make the bundle differ from the current build.
bundle-info = rm -rf $(1)/Contents && mkdir -p $(1)/Contents/MacOS $(1)/Contents/Resources \
	&& cp apps/$(2)/platform/darwin/Info.plist $(1)/Contents/Info.plist \
	&& cp apps/$(2)/platform/darwin/AppIcon.icns $(1)/Contents/Resources/AppIcon.icns
# So that the debug bundle runs beside the release application, appends .dev to the release identifier in Info.plist and uses the bundle name
# as the executable name (docs/spec/hosts.md#frontend-and-executables). The first argument is the bundle and the second is the application.
bundle-dev = plutil -replace CFBundleIdentifier -string "$$(plutil -extract CFBundleIdentifier raw $(1)/Contents/Info.plist).dev" $(1)/Contents/Info.plist \
	&& plutil -replace CFBundleName -string soksak-$(2) $(1)/Contents/Info.plist
# Seals the executables and the Info.plist in the bundle with an ad hoc signature and registers the bundle with LaunchServices again. The Dock
# shows the icon from the registered bundle information, and LaunchServices does not reread the registration when only files inside the bundle change.
LSREGISTER = /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
bundle-sign = codesign --sign - --force --deep $(1) && $(LSREGISTER) -f $(1)

# Builds the command line sok (docs/spec/cli.md) and places it beside the executables of the bundle. The first argument is the bundle and the second is the profile.
sok-wailsv3 = go build -C packages/sok/wailsv3 $(if $(filter release,$(2)),-trimpath -ldflags "-s -w") $(if $(filter debug,$(2)),-tags "diagnostics dev",$(if $(DIAGNOSTIC_RELEASE),-tags diagnostics)) -o ../../../$(1)/Contents/MacOS/sok ./src/cmd/sok
sok-tauriv2 = cargo build -p soksak-sok-tauriv2 $(if $(filter release,$(2)),--release) $(if $(filter debug,$(2)),--features diagnostics$(COMMA)dev,$(if $(DIAGNOSTIC_RELEASE),--features diagnostics)) && cp target/$(2)/sok $(1)/Contents/MacOS/sok

native-darwin:
	@$(MAKE) -C native/darwin

# The workspace registry. Packs the sibling plugin repositories that scripts/workspace-registry.json declares as diagnostic builds,
# builds every declared sidecar from its repository and releases them for the current platform, and then
# creates index.json in target/registry (docs/spec/plugins.md#repositories).
# Diagnostic builds and window checks install from here.
REGISTRY = target/registry

registry:
	@cargo build -p soksak-sok-tauriv2
	@node scripts/workspace-registry.mjs --sok target/debug/sok --out $(REGISTRY) --diagnostics

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

# Staging does not touch the bundle. The bundle is rebuilt only by the build targets. This keeps the executable of the debug app that checks use
# from being removed by the staging of a check target such as native-test.
frontend-wailsv3: build
	@$(call stage-wailsv3,--diagnostics)

frontend-tauriv2: build
	@$(call stage-tauriv2,--diagnostics)

# generate_context! includes the frontend, so this rebuilds the crate.
tauriv2-build: native-darwin frontend-tauriv2
	@$(call bundle-info,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@$(call bundle-dev,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build -p soksak-tauriv2 --features diagnostics,dev
	@cp target/debug/soksak-tauriv2 $(TAURI_DEBUG)
	@$(call sok-tauriv2,$(TAURI_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(TAURI_DEBUG_BUNDLE))

tauriv2-build-release: native-darwin build
	@$(call bundle-info,$(TAURI_RELEASE_BUNDLE),tauriv2)
	@$(call stage-tauriv2,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build --release -p soksak-tauriv2 $(if $(DIAGNOSTIC_RELEASE),--features diagnostics)
	@cp target/release/soksak-tauriv2 $(TAURI_RELEASE)
	@$(call sok-tauriv2,$(TAURI_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(TAURI_RELEASE_BUNDLE))

wailsv3-build: native-darwin frontend-wailsv3
	@$(call bundle-info,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(call bundle-dev,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(GO_ENV) go build -C apps/wailsv3 -tags "diagnostics dev" -ldflags "$(GO_LINK)" -o ../../$(WAILS_DEBUG) ./src
	@$(call sok-wailsv3,$(WAILS_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(WAILS_DEBUG_BUNDLE))

wailsv3-build-release: native-darwin build
	@$(call bundle-info,$(WAILS_RELEASE_BUNDLE),wailsv3)
	@$(call stage-wailsv3,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@$(GO_ENV) go build -C apps/wailsv3 -trimpath $(if $(DIAGNOSTIC_RELEASE),-tags diagnostics) -ldflags "-s -w $(GO_LINK)" -o ../../$(WAILS_RELEASE) ./src
	@$(call sok-wailsv3,$(WAILS_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(WAILS_RELEASE_BUNDLE))

tauriv2: tauriv2-build
	@./$(TAURI_DEBUG)

tauriv2-release: tauriv2-build-release
	@./$(TAURI_RELEASE)

wailsv3: wailsv3-build
	@./$(WAILS_DEBUG)

wailsv3-release: wailsv3-build-release
	@./$(WAILS_RELEASE)

# Unit checks of native code. Runs the shared input check and the host contract check, which runs the tests of the two hosts.
# The checks of a sidecar run in each sidecar repository.
native-test: native-darwin frontend-wailsv3 frontend-tauriv2
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
rust-clippy-check: native-darwin
	@$(CARGO_ENV) cargo clippy --workspace --tests --features soksak-host-tauriv2/diagnostics -- -D warnings
	@$(CARGO_ENV) cargo clippy --workspace --tests -- -D warnings
	@echo "Rust clippy check passed: 1 workspace, diagnostics and default builds"

# Checks that every package of the Rust workspace is in rustfmt form.
rust-format-check:
	@cargo fmt --all --check
	@echo "Rust format check passed: 1 workspace"

# Runs the tests of the two hosts in the default configuration and the diagnostic configuration and checks from the results that the host contract cases
# (docs/spec/host-contract.md) run at the same level.
host-contract-check: native-darwin frontend-wailsv3 frontend-tauriv2
	@$(GO_ENV) $(CARGO_ENV) node scripts/check-host-contract.mjs --go-ldflags="$(GO_LINK)"

# Checks the windows of already running apps in sequence through the local endpoint. The harness does not start the apps.
examples-verify: docs-check e2e-check exposure-check
	@pnpm -F @soksak/e2e run verify

# The two-profile builds of the two apps and their sizes.
examples-size: tauriv2-build tauriv2-build-release wailsv3-build-release wailsv3-build
	@printf "%-10s %10s %10s\n" "" debug release
	@printf "%-10s %9.1fM %9.1fM\n" tauriv2 \
	  $$(echo "$$(stat -f%z $(TAURI_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(TAURI_RELEASE))/1048576" | bc -l)
	@printf "%-10s %9.1fM %9.1fM\n" wailsv3 \
	  $$(echo "$$(stat -f%z $(WAILS_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(WAILS_RELEASE))/1048576" | bc -l)
