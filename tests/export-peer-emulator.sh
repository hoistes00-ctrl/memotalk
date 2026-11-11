#!/usr/bin/env bash
set -euo pipefail
# Only folders created by the instrumentation test on the disposable emulator.
mapfile -t roots < <(adb shell 'find /sdcard/Documents -type d -path "*/memotalk-peer-v1/operations"' | tr -d '\r' | sed '/^$/d')
if [[ ${#roots[@]} -ne 1 ]]; then
  printf 'Expected one synthetic shared-folder operation directory; found %s\n' "${#roots[@]}" >&2
  exit 1
fi
case "${roots[0]}" in
  /sdcard/Documents/MemoTalkNativeTest-*/memotalk-peer-v1/operations) ;;
  *) echo 'Refusing to read a non-test directory' >&2; exit 1 ;;
esac
if [[ -e peer-returned/peer-return ]]; then
  echo 'Refusing to merge into a prior test output directory' >&2
  exit 1
fi
mkdir -p peer-returned
adb pull "${roots[0]}" peer-returned/peer-return
