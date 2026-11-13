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
# The installed pnpm is linked from a folder of its own, so the check runs the real executable from a location outside the npm package.
standalone=$(mktemp -d)
trap 'rm -rf "$standalone"' EXIT
declared=$(node -p 'require("./package.json").packageManager.slice("pnpm@".length)')
ln -s "$(command -v pnpm)" "$standalone/pnpm"
if ready=$(PATH="$standalone:$PATH" sh scripts/check-tools.sh 2>&1); then
  printf 'PASS: a standalone pnpm executable of the declared version is accepted\n'
else
  status=$?
  printf 'FAIL: a standalone pnpm executable of the declared version exited %s: %s\n' "$status" "$ready"
  exit 1
fi
# A build needs the major version of a tool, so another minor or patch version is a matching toolchain. The installed pnpm reports only its own
# version, so the check takes the pnpm version from its declared fault injection point.
if ready=$(SOKSAK_FAULT_PNPM_VERSION="${declared%%.*}.999.0" sh scripts/check-tools.sh 2>&1); then
  printf 'PASS: a pnpm executable of the declared major version is accepted\n'
else
  status=$?
  printf 'FAIL: a pnpm executable of the declared major version exited %s: %s\n' "$status" "$ready"
  exit 1
fi
# The node check also compares the major version only. The installed node reports only its own version, so the check takes the node version
# from its declared fault injection point.
if ready=$(SOKSAK_FAULT_NODE_VERSION="v$(cut -d. -f1 .node-version).999.0" sh scripts/check-tools.sh 2>&1); then
  printf 'PASS: a node executable of the declared major version is accepted\n'
else
  status=$?
  printf 'FAIL: a node executable of the declared major version exited %s: %s\n' "$status" "$ready"
  exit 1
fi
if other=$(SOKSAK_FAULT_PNPM_VERSION=0.0.1 sh scripts/check-tools.sh 2>&1); then
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
