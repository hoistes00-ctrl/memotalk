#!/usr/bin/env bash
set -euo pipefail
# Only folders created by the instrumentation test on the disposable emulator.
mapfile -t roots < <(adb shell 'find /sdcard/Documents -type d -path "*/memotalk-peer-v1/operations"' | tr -d '\r' | sed '/^$/d')
selected=()
for candidate in "${roots[@]}"; do
  if [[ ! "$candidate" =~ ^/sdcard/Documents/MemoTalkNativeTest-[0-9a-f-]+/memotalk-peer-v1/operations$ ]]; then
    echo 'Refusing to read a non-test directory' >&2
    exit 1
  fi
  # Other tests may create their own groups. Export exactly the real reply fixture.
  if adb shell "grep -l -F 'Android real WebView reply' '$candidate/'*.json" | grep -q '.json'; then
    selected+=("$candidate")
  fi
done
if [[ ${#selected[@]} -ne 1 ]]; then
  echo 'Expected exactly one actual Android reply fixture' >&2
  exit 1
fi
if [[ -e peer-returned/peer-return ]]; then
  echo 'Refusing to merge into a prior test output directory' >&2
  exit 1
fi
mkdir -p peer-returned
adb pull "${selected[0]}" peer-returned/peer-return
