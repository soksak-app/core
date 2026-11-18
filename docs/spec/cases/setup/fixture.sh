#!/bin/sh
# Fixture program of the external commands that the setup operations of sok run (docs/spec/cli.md#mcp-registration).
#
# A test copies this file into a folder of PATH under the name of the command, `claude` or `sudo`. Each run appends one
# line, the command name and its arguments separated by spaces, to the file that SETUP_FIXTURE_LOG names.
#
# As `claude` it holds the user scope registration of the configuration file `$CLAUDE_CONFIG_DIR/.claude.json`, or
# `$HOME/.claude.json` when CLAUDE_CONFIG_DIR is not set or empty:
#   claude mcp add --scope user <name> -- <command> <argument>   writes {"mcpServers": {<name>: {"type": "stdio",
#                                                                 "command": <command>, "args": [<argument>], "env": {}}}}
#   claude mcp remove --scope user <name>                         writes {"mcpServers": {}}
# The file holds only that member afterwards. Declared fault points:
#   SETUP_FIXTURE_FAIL=add|remove   that subcommand writes nothing, writes two lines to standard error and exits with 7
#   SETUP_FIXTURE_SKIP_WRITE=1      add exits with 0 and writes nothing
#
# As `codex` it holds the registration of the server soksak in $CODEX_HOME/fixture-mcp.json, or $HOME/.codex/fixture-mcp.json when
# CODEX_HOME is not set or empty, in the form that `codex mcp get --json` prints:
#   codex mcp add soksak -- <command> <argument>   writes the stdio transport of <command> with <argument>, enabled
#   codex mcp remove soksak                         removes the file and prints "Removed global MCP server 'soksak'."
#   codex mcp get soksak --json                     prints the file, or exits with status 1 and "No MCP server named
#                                                   'soksak' found." on standard error when the file does not exist
#
# As `sudo` it only records its arguments and exits with 0.
set -eu
# A test gives the program a PATH of its own folders, so the program names the folders of the system tools that it runs.
PATH=/usr/bin:/bin
name=${0##*/}
if [ -n "${SETUP_FIXTURE_LOG:-}" ]; then
  printf '%s %s\n' "$name" "$*" >> "$SETUP_FIXTURE_LOG"
fi
[ "$name" = sudo ] && exit 0
if [ "$name" = codex ]; then
  if [ -n "${CODEX_HOME:-}" ]; then
    codex_file="$CODEX_HOME/fixture-mcp.json"
  else
    codex_file="$HOME/.codex/fixture-mcp.json"
  fi
  case "$*" in
    "mcp get soksak --json")
      if [ -f "$codex_file" ]; then
        cat "$codex_file"
      else
        echo "Error: No MCP server named 'soksak' found." >&2
        exit 1
      fi
      ;;
    "mcp remove soksak")
      rm -f "$codex_file"
      echo "Removed global MCP server 'soksak'."
      ;;
    "mcp add soksak -- "*)
      command=$5
      argument=$6
      mkdir -p "${codex_file%/*}"
      printf '{"name": "soksak", "enabled": true, "transport": {"type": "stdio", "command": "%s", "args": ["%s"]}}\n' \
        "$command" "$argument" > "$codex_file"
      echo "Added global MCP server 'soksak'."
      ;;
    *)
      echo "fixture.sh: unknown arguments $*" >&2
      exit 2
      ;;
  esac
  exit 0
fi
if [ "$name" != claude ]; then
  echo "fixture.sh: unknown command name $name" >&2
  exit 2
fi
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  file="$CLAUDE_CONFIG_DIR/.claude.json"
else
  file="$HOME/.claude.json"
fi
quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}
case "$*" in
  "mcp add --scope user "*" -- "*)
    if [ "${SETUP_FIXTURE_FAIL:-}" = add ]; then
      printf 'fixture add refused\nsecond line\n' >&2
      exit 7
    fi
    [ "${SETUP_FIXTURE_SKIP_WRITE:-}" = 1 ] && exit 0
    server=$5
    command=$7
    argument=$8
    printf '{"mcpServers": {%s: {"type": "stdio", "command": %s, "args": [%s], "env": {}}}}\n' \
      "$(quote "$server")" "$(quote "$command")" "$(quote "$argument")" > "$file"
    ;;
  "mcp remove --scope user "*)
    if [ "${SETUP_FIXTURE_FAIL:-}" = remove ]; then
      printf 'fixture remove refused\nsecond line\n' >&2
      exit 7
    fi
    printf '{"mcpServers": {}}\n' > "$file"
    ;;
  *)
    echo "fixture.sh: unknown arguments $*" >&2
    exit 2
    ;;
esac
