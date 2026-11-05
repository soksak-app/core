#!/bin/sh
set -eu

if ready=$(sh scripts/check-tools.sh 2>&1); then
  if printf '%s\n' "$ready" | grep -Eq '^BUILD_ENVIRONMENT_READY node=v[^ ]+ pnpm=[^ ]+ runtime=[^ ]+/[^ ]+ lockSHA256=[[:xdigit:]]{64}$'; then
    printf 'PASS: valid workspace toolchain reports its measured build environment\n'
  else
    printf 'FAIL: valid workspace toolchain returned an unrecognized result: %s\n' "$ready"
    exit 1
  fi
else
  status=$?
  printf 'FAIL: valid workspace toolchain exited %s: %s\n' "$status" "$ready"
  exit 1
fi

# A pnpm installed as a standalone executable outside an npm package, such as pnpm/action-setup on a GitHub runner, is also a matching toolchain when it reports that version.
standalone=$(mktemp -d)
trap 'rm -rf "$standalone"' EXIT
declared=$(node -p 'require("./package.json").packageManager.slice("pnpm@".length)')
printf '#!/bin/sh\nprintf "%%s\\n" %s\n' "$declared" > "$standalone/pnpm"
chmod +x "$standalone/pnpm"
if ready=$(PATH="$standalone:$PATH" sh scripts/check-tools.sh 2>&1); then
  printf 'PASS: a standalone pnpm executable of the declared version is accepted\n'
else
  status=$?
  printf 'FAIL: a standalone pnpm executable of the declared version exited %s: %s\n' "$status" "$ready"
  exit 1
fi
# A build needs the major version of a tool, so another minor or patch version is a matching toolchain.
printf '#!/bin/sh\nprintf "%%s\\n" %s.999.0\n' "${declared%%.*}" > "$standalone/pnpm"
if ready=$(PATH="$standalone:$PATH" sh scripts/check-tools.sh 2>&1); then
  printf 'PASS: a pnpm executable of the declared major version is accepted\n'
else
  status=$?
  printf 'FAIL: a pnpm executable of the declared major version exited %s: %s\n' "$status" "$ready"
  exit 1
fi
printf '#!/bin/sh\ncase "$1" in --version) printf "v%s.999.0\\n" ;; *) exec "%s" "$@" ;; esac\n' "$(cut -d. -f1 .node-version)" "$(command -v node)" > "$standalone/node"
chmod +x "$standalone/node"
if ready=$(PATH="$standalone:$PATH" sh scripts/check-tools.sh 2>&1); then
  printf 'PASS: a node executable of the declared major version is accepted\n'
else
  status=$?
  printf 'FAIL: a node executable of the declared major version exited %s: %s\n' "$status" "$ready"
  exit 1
fi
rm "$standalone/node"
printf '#!/bin/sh\nprintf "0.0.1\\n"\n' > "$standalone/pnpm"
if other=$(PATH="$standalone:$PATH" sh scripts/check-tools.sh 2>&1); then
  printf 'FAIL: a pnpm executable of another version was accepted\n'
  exit 1
else
  status=$?
  if [ "$status" -eq 78 ] && printf '%s\n' "$other" | grep -q ' actual node=v[^ ]* pnpm=0.0.1 '; then
    printf 'PASS: a pnpm executable of another version is a toolchain mismatch\n'
  else
    printf 'FAIL: a pnpm executable of another version returned status %s and output: %s\n' "$status" "$other"
    exit 1
  fi
fi

if invalid=$(sh scripts/check-tools.sh unexpected 2>&1); then
  printf 'FAIL: an unexpected argument was accepted\n'
  exit 1
else
  status=$?
  if [ "$status" -eq 78 ] && [ "$invalid" = 'BUILD_DECLARATION_INVALID: usage: check-tools.sh' ]; then
    printf 'PASS: unexpected arguments return the declared usage error\n'
  else
    printf 'FAIL: unexpected arguments returned status %s and output: %s\n' "$status" "$invalid"
    exit 1
  fi
fi
