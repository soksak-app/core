#!/bin/bash
# The release step "Migrate the stored data of the earlier release" (F191, docs/spec/installation.md#stored-data-migration):
# runs one release-built host binary (the first argument) once on the stored format-2 form of plugins/installed.json and
# requires the migrated file and the log.migrated record. release.yml runs this script; the same script verifies the
# step on a development machine against a debug build. The wait loop bounds the run (100 tries of 0.3 s) and the kill
# ends it, so no timeout command is needed (the macOS runner has none).
set -euo pipefail
host="$1"
config="$(mktemp -d)"
mkdir -p "$config/plugins"
printf '%s' '{"format":2,"plugins":{"probe":{"package":"@scope/plugin-probe","version":"1.0.0","path":"plugins/probe/1.0.0","enabled":true,"sidecars":{}}},"sidecars":{}}' > "$config/plugins/installed.json"
"$host" --config-dir "$config" &
pid=$!
for _ in $(seq 1 100); do
  grep -q '"event":"log.open"' "$config"/logs/host-*.jsonl 2>/dev/null && break
  sleep 0.3
done
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
grep -q '"format": *3\|"format":3' "$config/plugins/installed.json"
grep -q '"event":"log.migrated"' "$config"/logs/host-*.jsonl
rm -rf "$config"
echo "release-step-ok"
