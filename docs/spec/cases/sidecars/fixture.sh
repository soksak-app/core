#!/bin/sh
# Fixture sidecar program for the shared sidecar contract cases.
#
# A test links this file under the executable name of a declared sidecar and
# writes a control file in the folder of the link. The program reads the
# control file beside its link, runs the startup operations in file order,
# then reads standard input line by line and applies the on-lines.
#
# Startup operations (before the first on-line; not allowed after it):
#   record-pid PATH          write the process id
#   append-pid PATH          append the process id
#   record-argv PATH         write each argument of the program on its own line, all at once
#   record-env NAME PATH     write the value of the environment variable NAME, no newline
#   touch PATH               create PATH when absent
#   append PATH TEXT         append TEXT and a newline to PATH
#   ignore-term              ignore the TERM signal
#   holder HOLD PIDPATH      run cat HOLD in the background; write its process id
#   detached HOLD PIDPATH    start a session leader that reads HOLD; write its id
#   wait PATH                read one line from PATH (a FIFO or a file)
#   stderr TEXT              write TEXT and a newline to standard error
#   stderr-raw TEXT          write TEXT without a newline to standard error
#   write TEXT               write TEXT and a newline to standard output
#   if-absent PATH LABEL     continue at "label LABEL" when PATH is absent
#   if-present PATH LABEL    continue at "label LABEL" when PATH exists
#   label NAME               target of if-absent and if-present
#   read-byte PATH           append one byte of standard input to PATH
#   keep-line PATH           append one line of standard input to PATH, with its line break
#   skip-line                read and discard one line of standard input
#   echo-line                read one line of standard input and write it to standard output
#   drain PATH               replace the program with cat, which appends standard input to PATH;
#                            cat keeps the standard output of the program open on descriptor 4
#                            until it ends, so the reader of the output sees no close before it
#   sleep SECONDS            replace the program with sleep (never reads input)
#   exit CODE                exit with CODE
#   signal NAME              send the signal NAME to the program
#   hold PATH                replace the program with cat PATH (never reads input)
#   endpoint SOCKET TOKEN    write the endpoint JSON of protocol 1 with the process id,
#                            SOCKET and TOKEN; SOCKET and TOKEN take no quote or backslash
#   hold-memory BYTES SECONDS  replace the program with perl, which holds BYTES of memory and
#                            sleeps SECONDS (never reads input)
#
# A control file without an exit, sleep, hold, drain or on-line reads standard input
# until its end, and that reading blocks while the input stays open. A program that a
# test expects to end at once after its startup list ends with an exit operation.
#
# On-lines: "on SEL ACTION ARGS". SEL is N (the N-th input line, 1-based),
# "match GLOB" (the input line matches GLOB) or "any".
# ACTION: echo | tee PATH | keep PATH | keep-reply PATH TEXT | drop | reply TEXT
#         | reply-body SURFACE | pad SURFACE BYTES | flood COUNT TEXT | exit CODE
#         | signal NAME | wrap SURFACE KEY | reply-raw SURFACE | reply-fields TEXT | then OP (one operation of the
#           startup list that does not read standard input: not record-argv, label, if-absent,
#           if-present, read-byte, keep-line, skip-line, echo-line or drain)
# keep-reply appends the input line to PATH, then writes TEXT.
# wrap writes {"surface":"SURFACE","body":{"KEY":<the input line>}} and does not end the
# rule match: the next on-line that matches the same input line also applies. The other
# actions end the match, so one input line gets one terminal action and any wrap rules
# before it. SURFACE and KEY take no quote or backslash.
# reply-raw writes {"surface":"SURFACE","body":<the input line>}: the input line is the body
# as a JSON value. SURFACE takes no quote or backslash.
# reply-fields writes TEXT with each {{NAME}} replaced by the value of the member NAME of the
# input line: the text of a string member without its quotes, or the digits of a number
# member; NAME takes letters, digits and _, and the last member of that name in the line is
# read. An input line without the member is an error. Like wrap, it does not end the rule
# match, so several reply-fields lines answer one input line in file order.
# pad writes {"surface":"SURFACE","body":"..."} whose body holds BYTES characters x.
# The operations that read standard input are startup-only because a line
# rule runs while standard input is the rule table.
# At-eof lines: "at-eof OP", OP is flood, write, append, exit, sleep, signal or wait.
# At-eof lines run in file order when standard input ends; the default is exit 0.
#
# Errors: a malformed or unknown line is reported on standard error as
# "fixture: <control path>:<line number>: <what it found>" and the program
# exits with status 2. An input line that no on-line matches is an error too.
# Text operands take the rest of the line verbatim.
#
# record-env reads the variable through /usr/bin/printenv. Command substitution
# removes trailing newlines of the value.
# detached uses perl because macOS has no setsid command. The fixed perl program
# in the detached case forks; the parent waits on a pipe until the child has
# called POSIX::setsid, then exits. The child writes its process id to PIDPATH
# and opens HOLD. The paths are passed as arguments in @ARGV, never in the source.

set -u

NL='
'
# Control characters 0x01 to 0x1f, used by json_string.
CONTROL=$(printf '\001\002\003\004\005\006\007\010\011\012\013\014\015\016\017\020\021\022\023\024\025\026\027\030\031\032\033\034\035\036\037')

# dirname is not used: the folder of the link comes from the expansion of $0.
case $0 in
  */*) dir=${0%/*} ;;
  *) dir=. ;;
esac
control=$dir/control

fail() {
  printf 'fixture: %s:%s: %s\n' "$control" "$lineno" "$1" >&2
  exit 2
}

# Move the first word of rest into w. rest keeps the text after that word.
take() {
  w=${rest%% *}
  if [ "$w" = "$rest" ]; then rest=; else rest=${rest#* }; fi
}

need() {
  take
  [ -n "$w" ] || fail "$op needs a $1"
}

need_num() {
  need "$1"
  case $w in ''|*[!0-9]*) fail "$op needs a whole number for $1: $w" ;; esac
}

need_surface() {
  need surface
  case $w in ''|*'"'*|*'\'*) fail "$op needs a surface name without quotes or backslashes: $w" ;; esac
}

end() {
  [ -z "$rest" ] || fail "$op has extra text: $rest"
}

# Print the text $1 as a JSON string literal. Backslash, quote and the control
# characters are escaped.
json_string() {
  s=$1
  out=
  while [ -n "$s" ]; do
    c=${s%"${s#?}"}
    s=${s#?}
    case $c in
      \\) out=$out'\\' ;;
      '"') out=$out'\"' ;;
      *)
        case $CONTROL in
          *"$c"*) out=$out$(printf '\\u%04x' "'$c") ;;
          *) out=$out$c ;;
        esac ;;
    esac
  done
  printf '"%s"' "$out"
}

# Check the selector and the action word of the on-line $1.
check_on() {
  rest=${1#on }
  take
  case $w in
    any) ;;
    match) take ;;
    ''|*[!0-9]*) fail "unknown selector: $w" ;;
  esac
  take
  case $w in
    echo|tee|keep|keep-reply|drop|reply|reply-body|reply-raw|reply-fields|pad|flood|exit|signal|wrap|then) ;;
    *) fail "unknown action: $w" ;;
  esac
}

# Run one operation shared by startup, then-lines and at-eof lines.
# $1 is one control line without its line number.
run_op() {
  op=${1%% *}
  rest=${1#"$op"}
  rest=${rest# }
  case $op in
    record-pid) need path; end; printf '%s\n' "$$" > "$w" || fail "cannot write $w" ;;
    append-pid) need path; end; printf '%s\n' "$$" >> "$w" || fail "cannot append to $w" ;;
    record-env) need name; name=$w; need path; end
      case $name in *[!A-Za-z0-9_]*) fail "not an environment variable name: $name" ;; esac
      value=$(/usr/bin/printenv "$name"); status=$?
      case $status in 0|1) ;; *) fail "printenv failed with status $status" ;; esac
      printf '%s' "$value" > "$w" || fail "cannot write $w" ;;
    touch) need path; end; : >> "$w" || fail "cannot create $w" ;;
    append) need path; printf '%s\n' "$rest" >> "$w" || fail "cannot append to $w" ;;
    ignore-term) end; trap '' TERM ;;
    holder) need hold; hold=$w; need path; pidp=$w; end
      cat "$hold" & printf '%s\n' "$!" > "$pidp" || fail "cannot write $pidp" ;;
    detached) need hold; hold=$w; need path; pidp=$w; end
      /usr/bin/perl -MPOSIX -e 'pipe(my $r, my $w) or die; if (fork) { close $w; my $left = <$r>; exit } close $r; POSIX::setsid() or die; close $w; open(my $f, ">", $ARGV[1]) or die; print $f $$; close $f; open(my $h, "<", $ARGV[0]) or die; my $line = <$h>' "$hold" "$pidp" || fail "detached could not start the session leader" ;;
    wait) need path; end; IFS= read -r _line < "$w" || fail "cannot read a line from $w" ;;
    stderr) printf '%s\n' "$rest" >&2 ;;
    stderr-raw) printf '%s' "$rest" >&2 ;;
    write|reply) printf '%s\n' "$rest" ;;
    hold) need path; end; exec cat "$w" ;;
    endpoint) need socket; socket=$w; need token; token=$w; end
      case $socket$token in *'"'*|*'\'*) fail "endpoint takes no quote or backslash" ;; esac
      printf '{"protocol":1,"pid":%s,"socket":"%s","token":"%s"}\n' "$$" "$socket" "$token" ;;
    hold-memory) need_num bytes; bytes=$w; need_num seconds; seconds=$w; end
      exec /usr/bin/perl -e '$x = "a" x $ARGV[0]; sleep $ARGV[1]' "$bytes" "$seconds" ;;
    sleep) need_num seconds; end; exec sleep "$w" ;;
    exit) need_num code; end; [ "$w" -le 255 ] || fail "exit code above 255: $w"; exit "$w" ;;
    signal) need name; end; kill -"$w" $$ || fail "cannot send signal $w" ;;
    flood) need_num count; count=$w; i=0
      while [ "$i" -lt "$count" ]; do printf '%s\n' "$rest"; i=$((i + 1)); done ;;
    pad) need_surface; surface=$w; need_num bytes; end; count=$w
      printf '{"surface":"%s","body":"' "$surface"
      if [ "$count" -gt 0 ]; then printf '%0*d' "$count" 0 | tr 0 x; fi
      printf '"}\n' ;;
    *) fail "unknown operation: $op" ;;
  esac
}

# Apply the first on-line that matches input line $2, which is input line $1.
apply_rules() {
  n=$1
  line=$2
  matched=0
  while IFS= read -r rule; do
    [ -n "$rule" ] || continue
    lineno=${rule%% *}
    rest=${rule#* }
    rest=${rest#on }
    take
    hit=0
    case $w in
      any) hit=1 ;;
      match) take; case $line in $w) hit=1 ;; esac ;;
      *) [ "$w" -eq "$n" ] && hit=1 ;;
    esac
    [ "$hit" = 1 ] || continue
    take
    op=$w
    case $op in
      echo) end; printf '%s\n' "$line" ;;
      drop) end ;;
      tee) need path; printf '%s\n' "$line" | tee -a "$w" || fail "cannot append to $w" ;;
      keep) need path; end; printf '%s\n' "$line" >> "$w" || fail "cannot append to $w" ;;
      keep-reply) need path
        [ -n "$rest" ] || fail "keep-reply needs a reply text"
        printf '%s\n' "$line" >> "$w" || fail "cannot append to $w"
        printf '%s\n' "$rest" ;;
      reply-body) need_surface; end
        printf '{"surface":"%s","body":' "$w"
        json_string "$line"
        printf '}\n' ;;
      reply-raw) need_surface; end
        printf '{"surface":"%s","body":%s}\n' "$w" "$line" ;;
      wrap) need_surface; surface=$w; need key; key=$w; end
        case $key in ''|*'"'*|*'\'*) fail "wrap needs a key without quotes or backslashes: $key" ;; esac
        printf '{"surface":"%s","body":{"%s":%s}}\n' "$surface" "$key" "$line"
        matched=1
        continue ;;
      reply-fields) [ -n "$rest" ] || fail "reply-fields needs a reply text"
        out=$rest
        while :; do
          case $out in *'{{'*'}}'*) ;; *) break ;; esac
          key=${out#*'{{'}
          key=${key%%'}}'*}
          case $key in ''|*[!A-Za-z0-9_]*) fail "reply-fields takes member names of letters, digits and _: $key" ;; esac
          value=$(printf '%s' "$line" | sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p")
          [ -n "$value" ] || value=$(printf '%s' "$line" | sed -n "s/.*\"$key\":\([0-9][0-9]*\).*/\1/p")
          [ -n "$value" ] || fail "input line $n has no member $key"
          out=${out%%"{{$key}}"*}$value${out#*"{{$key}}"}
        done
        printf '%s\n' "$out"
        matched=1
        continue ;;
      then) run_op "$rest"; return 0 ;;
      *) run_op "$op $rest"; return 0 ;;
    esac
    return 0
  done <<EOF
$rules
EOF
  [ "$matched" = 1 ] || { printf 'fixture: %s: input line %s matches no on-line\n' "$control" "$n" >&2; exit 2; }
}

# Continue the startup section at "label $1". The control file is read again
# from its first line; the label must come before the first on-line.
goto() {
  at=$lineno
  exec 3< "$control"
  lineno=0
  found=0
  while IFS= read -r l <&3 || [ -n "$l" ]; do
    lineno=$((lineno + 1))
    case $l in
      "label $1") found=1; break ;;
      on|on\ *|at-eof|at-eof\ *) break ;;
    esac
  done
  [ "$found" = 1 ] || { lineno=$at; fail "label $1 is not in the startup section"; }
}

[ -r "$control" ] || { printf 'fixture: %s: control file cannot be read\n' "$control" >&2; exit 2; }
exec 3< "$control"
lineno=0
phase=startup
rules=
eof_ops=

while IFS= read -r line <&3 || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  op=${line%% *}
  rest=${line#"$op"}
  rest=${rest# }
  case $op in
    on)
      check_on "$line"
      phase=rules
      rules="$rules$lineno $line$NL" ;;
    at-eof)
      case ${rest%% *} in
        flood|write|append|exit|sleep|signal|wait) ;;
        *) fail "not an at-eof operation: ${rest%% *}" ;;
      esac
      eof_ops="$eof_ops$lineno $rest$NL" ;;
    *)
      [ "$phase" = startup ] || fail "startup operation after the first on-line"
      case $op in
        record-argv)
          need path; end
          # The arguments go to a part file that replaces PATH at once, so a reader sees all of them or none.
          for a in "$@"; do printf '%s\n' "$a"; done > "$w.part" && mv "$w.part" "$w" || fail "cannot write $w" ;;
        label) need name; end ;;
        if-absent|if-present)
          need path; p=$w; need label; l=$w; end
          case $op in
            if-absent) [ -e "$p" ] || goto "$l" ;;
            if-present) [ -e "$p" ] && goto "$l" ;;
          esac ;;
        read-byte) need path; end; dd bs=1 count=1 2>/dev/null >> "$w" || fail "cannot append to $w" ;;
        keep-line) need path; end
          IFS= read -r stdin_line || fail "standard input ends before a line"
          printf '%s\n' "$stdin_line" >> "$w" || fail "cannot append to $w" ;;
        echo-line) end
          IFS= read -r stdin_line || fail "standard input ends before a line"
          printf '%s\n' "$stdin_line" ;;
        skip-line) end
          IFS= read -r stdin_line || fail "standard input ends before a line" ;;
        drain) need path; end; : >> "$w" || fail "cannot append to $w"
          exec 4>&1
          exec cat >> "$w" ;;
        *) run_op "$line" ;;
      esac ;;
  esac
done
exec 3<&-

n=0
while IFS= read -r input || [ -n "$input" ]; do
  n=$((n + 1))
  apply_rules "$n" "$input"
done

while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  lineno=${entry%% *}
  run_op "${entry#* }"
done <<EOF
$eof_ops
EOF

exit 0
