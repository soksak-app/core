#!/bin/sh
set -eu

package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_root=$(mktemp -d "${TMPDIR:-/tmp}/soksak-process-identity-install.XXXXXX")
trap 'rm -rf "$install_root"' EXIT HUP INT TERM
install_root=$(CDPATH= cd -- "$install_root" && pwd)
npm pack --pack-destination "$install_root" > "$install_root/pack.log" 2>&1
tarball="$install_root/soksak-native-process-identity-darwin-0.0.20.tgz"
mkdir "$install_root/consumer"
npm install --prefix "$install_root/consumer" --no-audit --no-fund --no-save "$tarball" > "$install_root/install.log" 2>&1 || {
  cat "$install_root/install.log" >&2
  exit 1
}
package_dir=$(node -e 'const path = require("node:path"); const { createRequire } = require("node:module"); const localRequire = createRequire(path.join(process.argv[1], "package.json")); process.stdout.write(path.dirname(localRequire.resolve("@soksak/native-process-identity-darwin/package.json")));' "$install_root/consumer")
config_path="$package_dir/lib/pkgconfig"
flags=$(PKG_CONFIG_PATH="$config_path" pkg-config --cflags --libs soksak-process-identity)
printf '%s\n' "$flags" | grep -F -- "$package_dir/lib/pkgconfig/../../include" >/dev/null
printf '%s\n' "$flags" | grep -F -- "$package_dir/lib/pkgconfig/../../lib" >/dev/null
clang -Wall -Werror -O2 -mmacosx-version-min=14.4 \
  $(PKG_CONFIG_PATH="$config_path" pkg-config --cflags soksak-process-identity) \
  "$package_root/tests/package_consumer_test.m" \
  $(PKG_CONFIG_PATH="$config_path" pkg-config --libs soksak-process-identity) \
  -o "$install_root/consumer_test"
"$install_root/consumer_test"
if nm -gU "$package_dir/lib/libsoksak-process-identity.a" | grep -F sp_process_set_display_name_with_services >/dev/null; then
  printf 'FAIL: the package exports the native test injection seam\n' >&2
  exit 1
fi
if otool -L "$install_root/consumer_test" | grep -F "$package_dir" >/dev/null; then
  printf 'FAIL: linked executable retains a runtime dependency on the installed package path\n' >&2
  exit 1
fi
printf 'PASS: packed package installs, relocates pkg-config paths, and statically links a consumer\n'
