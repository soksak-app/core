SHELL := /bin/sh

.PHONY: preflight prepare build verify

preflight:
	@scripts/check-build-environment.sh

prepare: preflight
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile

build: prepare
	@pnpm build

verify: prepare
	@pnpm test
	@pnpm build
	@git diff --exit-code -- dist

# Example apps. The frontend of each is generated from example/ and dist/, and
# Tauri embeds it at compile time, so the frontend is regenerated and the crate
# is forced to rebuild on every run.
.PHONY: example-frontend tauri wails

example-frontend:
	@examples/sync-frontend.sh

tauri: example-frontend
	@touch examples/tauriv2/src-tauri/src/main.rs
	@cd examples/tauriv2/src-tauri && cargo run

wails: example-frontend
	@cd examples/wailsv3 && go run .
