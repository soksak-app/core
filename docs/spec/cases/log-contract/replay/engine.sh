#!/bin/sh
# Replay executable of the probe sidecar (docs/spec/replay.md#replay-executable) for the tests of the two command line tools.
# It reads the sidecar events that the tool writes to its standard input. It counts the bytes of the output inputs it reads and
# prints, for each frame record, the count as the hash of that record: 64 decimal digits. The bytes of an input direct it, as the
# bytes of a program direct a real engine:
#   0bad  it writes "engine broke" to its standard error and ends with status 3.
#   0bee  it prints the line "nope", which is not a hash line.
#   0ba0  it prints no hash for this and every later frame record.
total=0
silent=0
while IFS= read -r line; do
  case "$line" in
    *'"event":"sidecar.probe.input"'*)
      hex=${line#*'"hex":"'}; hex=${hex%%'"'*}
      case "$hex" in
        0bad) echo "engine broke" >&2; exit 3 ;;
        0bee) echo nope ;;
        0ba0) silent=1 ;;
      esac
      total=$((total + ${#hex} / 2)) ;;
    *'"class":"frame"'*)
      if [ "$silent" = 0 ]; then
        sequence=${line#*'"sequence":'}; sequence=${sequence%%[,\}]*}
        printf '{"sequence":%s,"hash":"%064d"}\n' "$sequence" "$total"
      fi ;;
  esac
done
