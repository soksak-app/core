#!/bin/sh
set -eu

if ready=$(sh scripts/check-build-environment.sh 2>&1); then
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

if invalid=$(sh scripts/check-build-environment.sh unexpected 2>&1); then
  printf 'FAIL: an unexpected argument was accepted\n'
  exit 1
else
  status=$?
  if [ "$status" -eq 78 ] && [ "$invalid" = 'BUILD_DECLARATION_INVALID: usage: check-build-environment.sh' ]; then
    printf 'PASS: unexpected arguments return the declared usage error\n'
  else
    printf 'FAIL: unexpected arguments returned status %s and output: %s\n' "$status" "$invalid"
    exit 1
  fi
fi
