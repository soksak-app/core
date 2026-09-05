#!/bin/sh
# Builds the frontend directory of each example app from the repository root.
#
# Wails roots its asset FS at the directory that holds index.html, so index.html
# must sit at the frontend root. The repository example lives in example/ and
# imports ../dist/index.js, so the copy is placed at the root and its import is
# rewritten to ./dist/index.js.
#
# Each app also gets its own host.js, injected as a classic script. The example's
# own script is a module and therefore deferred, so host.js always runs first and
# window.hostSurfaces is set before the first commit.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

build() {
  app=$1
  out="$root/examples/$app/frontend"
  rm -rf "$out"
  mkdir -p "$out/dist"
  cp "$root"/dist/*.js "$out/dist/"
  # An app that drives native surfaces of its own ships a host.js; one that
  # does not simply runs the example as it is.
  [ -f "$root/examples/$app/host.js" ] && cp "$root/examples/$app/host.js" "$out/host.js"
  # Pages loaded into views of their own: the modal, and the terminal surface.
  for page in overlay.html terminal.html; do
    [ -f "$root/examples/$app/$page" ] && cp "$root/examples/$app/$page" "$out/$page"
  done

  APP=$app OUT=$out ROOT=$root python3 - <<'PY'
import io, os, sys
root, out, app = os.environ["ROOT"], os.environ["OUT"], os.environ["APP"]
s = io.open(f"{root}/example/index.html", encoding="utf-8").read()

old = 'from "../dist/index.js"'
if s.count(old) != 1:
    sys.exit(f"import to rewrite not found once: {s.count(old)}")
s = s.replace(old, 'from "./dist/index.js"')

# Wails serves its bridge at /wails/runtime.js; without it the page cannot call
# into Go. It is an ES module, so a plain script tag fails to parse it and the
# bridge never appears. Tauri injects its own bridge before any page script runs.
head = '<script type="module" src="/wails/runtime.js"></script>\n' if app == "wailsv3" else ""
if os.path.exists(f"{out}/host.js"):
    head += '<script src="./host.js"></script>\n'
marker = '<script type="module">'
if s.count(marker) != 1:
    sys.exit(f"module script not found once: {s.count(marker)}")
s = s.replace(marker, head + marker)

io.open(f"{out}/index.html", "w", encoding="utf-8").write(s)
print(f"built {out}")
PY
}

build wailsv3
build tauriv2
