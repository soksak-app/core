# Replay

[한국어](replay.ko.md)

A screen-producing sidecar stores the inputs of a session completely and a hash of each screen it produces, and the page stores a hash of each screen it draws. A replay rebuilds the screen of a session from the stored inputs and compares every stored hash with the replayed one. The frame content is not stored ([logging](logging.md#catalog), decision in [observability audit](../plans/observability-audit.md)); until a replay reproduces the screen, the stored hashes verify nothing. This document defines the records, the screen hash, the replay executable and the command. The events themselves are declared by the catalog of the sidecar and of the plugin ([logging](logging.md#catalog)); this repository names neither.

## Records

A *replay input* is an event of the layer `sidecar` that carries `session` (the identifier of the session, the member of the line), `fields.sequence` and the complete input of one occurrence:

| Input | Required fields |
| --- | --- |
| output of the program of the session (bytes read from the pseudo terminal) | `sequence`, `hex` |
| input to the program (bytes written to the pseudo terminal) | `sequence`, `hex` |
| resize | `sequence`, `rows`, `cols` |

`hex` is the lowercase hexadecimal text of the complete bytes of the occurrence. An input event has no derived copy of its bytes, such as a text. `sequence` is an integer counted per session from 1, with one step for each replay input of any kind, so the sequences of a session have no gap and the replay applies the inputs in the order of `sequence`. A key input that causes a write also carries `cids` ([logging](logging.md#event)).

A *frame record* is an event of the class `frame` that carries `session`, `fields.sequence`, `fields.rows`, `fields.cols` and `fields.hash`. `sequence` is the sequence of the last replay input that the screen includes; `hash` is the [screen hash](#screen-hash) of the screen after that input. The sidecar writes one frame record, layer `sidecar`, for each screen it produces. The page writes one frame record, layer `page`, for each screen it draws, with the `sequence` and `rows` and `cols` of the screen that it received from the sidecar and the hash of the grid it drew: the hash is computed from what the page drew, not copied from the message that carried the screen. The page draws only screens that the sidecar produced, so each page frame record has a sidecar frame record with the same `session` and `sequence`.

## Screen hash

The screen hash is the SHA-256, as 64 lowercase hexadecimal characters, of the canonical bytes of the screen. All integers are unsigned and big endian.

| Part | Bytes |
| --- | --- |
| magic | the 6 ASCII bytes `SKSCR1` |
| `rows` | 4 |
| `cols` | 4 |
| cursor visible | 1 (`1` visible, `0` hidden) |
| cursor row | 4, from 0, less than `rows` |
| cursor column | 4, from 0, less than `cols` |
| cells | `rows` × `cols` cells in row-major order |

Each cell is: the byte length of the grapheme in 4 bytes, the UTF-8 bytes of the grapheme, the width in 1 byte, the foreground in 4 bytes, the background in 4 bytes and the attributes in 1 byte.

- The *grapheme* is the text of the cell: the empty string for a blank cell and for the continuation cell of a wide character, and otherwise one grapheme cluster. It is well-formed Unicode.
- The *width* is `1` for a cell, `2` for the first cell of a wide character, and `0` for its continuation cell.
- A *color* is 4 bytes: the default color is `00 00 00 00`, an indexed color is `01 00 00 <index>` (index 0 to 255), and a true color is `02 <red> <green> <blue>`.
- The *attributes* are one byte of flags: bold `01`, dim `02`, italic `04`, underline `08`, blink `10`, inverse `20`, hidden `40`, strikethrough `80`.

In the JSON form of a screen (`@soksak/plugin-api/screen-hash`, the golden vectors) a screen is `{rows, cols, cursor: {row, col, visible}, cells}`, a cell is `{grapheme, width, fg, bg, attributes}`, a color is `null` (default), an integer from 0 to 255 (indexed) or `"#rrggbb"` in lowercase (true color), and `attributes` is an integer from 0 to 255. The hash function rejects a value outside these forms with an error that names the member. The golden vectors are `packages/log-contract/fixtures/replay/screen-hash.json`: for each screen the canonical bytes in hexadecimal and the hash, and the screens that the function refuses with their error text. Every implementation of the hash, in any language, reproduces them.

## Replay executable

A sidecar that produces screens declares `replay` in its `sidecar.json` ([sidecars](sidecars.md#declaration-and-startup)): `{"role": <role>, "executable": <path inside the sidecar>}`. `role` is the role of the event files of the sidecar (`logs/<role>-<boot>.jsonl`), which `log.open` of its files states. The executable is the replay engine of the sidecar: it holds the terminal engine, so the command line tool names none.

The tool starts the executable in the folder of the sidecar without arguments and writes to its standard input the lines of the layer `sidecar` events of the session from the files of the role, in the order of the [query](logging.md#query) (time, process, `seq`), unchanged, each ending with a newline, up to the `sequence` that `--until` gives. The executable applies the replay inputs in the order of `sequence` to an empty screen and, for each frame record it reads, writes to its standard output one line `{"sequence": <n>, "hash": <hash>}` with the hash of its screen at that sequence. It ends with exit status 0 when its input ends; any other exit status, a line that is not that object, a hash that is not 64 lowercase hexadecimal characters, or a frame record that gets no line is a failure of the replay, reported with the error text of the executable.

## Command

`sok debug replay <session> [--until <sequence>] [--config-dir <directory>]` ([command line](cli.md#commands)) reads the events of the session from the event files of the configuration directory through the [query](logging.md#query), finds the installed sidecar whose `replay.role` is the role of the sidecar events of the session, runs its replay executable, and compares in the order of `sequence`, the sidecar record before the page record of the same sequence:

1. each sidecar frame record with the replayed hash of its sequence: a difference is a divergence of the layer `sidecar`;
2. each page frame record with the replayed hash of its sequence: a difference, or a page frame record without a sidecar frame record at its sequence, is a divergence of the layer `page`.

The first divergence ends the comparison. The tool stores the event `sok.replay.divergence` (level `error`) with `session`, `sequence`, `layer`, `expected` (the replayed hash, or `none` for a page frame without a sidecar frame record) and `found` (the stored hash), writes `sok: replay divergence: session <session> sequence <n> layer <layer> expected <expected> found <found>` to its standard error and ends with exit status 1. When every hash is equal, it writes `replay session <session>: <n> sidecar frames and <m> page frames equal` to its standard output and ends with status 0. A session without events of the layer `sidecar`, without a frame record, with sidecar events of more than one role, or with no installed sidecar that declares the role is an error that names the session and the role. A frame record without an integer `fields.sequence` from 1 and a string `fields.hash`, a stored hash that is not 64 lowercase hexadecimal characters, an executable that fails or prints a line that is not `{"sequence", "hash"}`, and a frame record of the sidecar for which the executable prints no hash are errors, not divergences. The tool holds the events of the session in memory. Both tools give the same output and the same error text.
