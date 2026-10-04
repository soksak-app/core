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

# GitHub runner 의 pnpm/action-setup 처럼 npm package 밖의 단독 실행 파일로 설치한 pnpm 도 그 version 을 보고하면 맞는 toolchain 이다.
standalone=$(mktemp -d)
trap 'rm -rf "$standalone"' EXIT
declared=$(node -p 'require("./package.json").packageManager.slice("pnpm@".length)')
printf '#!/bin/sh\nprintf "%%s\\n" %s\n' "$declared" > "$standalone/pnpm"
chmod +x "$standalone/pnpm"
if ready=$(PATH="$standalone:$PATH" sh scripts/check-build-environment.sh 2>&1); then
  printf 'PASS: a standalone pnpm executable of the declared version is accepted\n'
else
  status=$?
  printf 'FAIL: a standalone pnpm executable of the declared version exited %s: %s\n' "$status" "$ready"
  exit 1
fi
printf '#!/bin/sh\nprintf "0.0.1\\n"\n' > "$standalone/pnpm"
if other=$(PATH="$standalone:$PATH" sh scripts/check-build-environment.sh 2>&1); then
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
