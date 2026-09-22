# Terminal protocol coverage

[한국어](terminal-protocols.ko.md)

This inventory belongs to the [terminal runtime](terminal-runtime.md). A parsed control sequence is not an implemented feature. Completion requires the requested effect or response, an observable rejection when policy prohibits it, and regression evidence. Until those conditions are recorded, coverage is incomplete.

## References

The baseline reference is [XTerm control sequences, patch 411, 2026-08-23](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html). OSC is a control-string family; vendor features are not one universal, closed OSC feature set. Inventory every selector in the pinned reference and record vendor extensions separately. Do not describe a subset as all OSC support.

Cursor settings cover these concepts: block, underline, beam, blink policy, interval, idle timeout, and unfocused hollow. Application cursor controls are CSI operations, not OSC.

OSC 1337 image transfer uses an OSC extension. The APC graphics protocol uses APC. Clipboard image paste, these protocols, and file drag-and-drop have separate requirements; implementing one does not implement the others.

## Required evidence

| Area | Required behavior | Current evidence |
| --- | --- | --- |
| Title and icon metadata | Preserve payload and order; update the owning terminal only | Engine events added; complete UI validation pending |
| Indexed and dynamic colors | Palette set/query/reset, foreground/background/cursor effects and exact replies | Indexed-color cell export tested; complete OSC validation pending |
| Hyperlinks | Preserve link identity across wrapped cells and selection; open only through a user command | Pending |
| Clipboard selection | Preserve complete text; associate query replies; distinguish user paste from program requests | Engine events added; native and permission integration pending |
| Directory and shell metadata | Validate syntax without executing payload; update the owning session | Pending |
| Notifications | Attribute the message to its session; do not execute payload | Pending |
| Font, logging, window and resource operations | Implement documented semantics or explicitly report unsupported/policy-denied operations; no successful no-op | Pending |
| In-band graphics | Validate size, encoding, limits and lifetime; preserve grid placement and deletion semantics | Pending |
| Unknown or malformed sequences | Report bounded diagnostic metadata without copying secret payloads into logs; never claim support | Pending |
| Cursor control | Respect terminal visibility/shape/blink controls plus user policy; verify actual pixels and positions | Engine and renderer integration in progress |
| Primary-screen reflow | Preserve soft-wrap logical lines through narrow/wide cycles and preserve hard newlines | Engine test exists; current rebuilt-host check pending |

This table is a requirements inventory, not a completed per-selector conformance report. It cannot justify an OSC-complete claim. The implementation must expand each applicable row to selector-level tests before marking the feature complete.

## OSC selector inventory

The following is the current selector-level audit against the pinned XTerm reference. `implemented` means that the engine produces the specified observable effect or reply. `unsupported` means that this runtime deliberately provides no effect or reply and must not describe the selector as supported. `vendor` is tracked by a separate contract and is not included in the standard OSC claim.

| Selector | XTerm operation | Current outcome | Named evidence |
| --- | --- | --- | --- |
| `0`, `2` | Set icon name and/or window title | `implemented`: title event; icon ownership is not exposed | `vt_events_are_retained_and_exposed_in_order`, `osc_title_supports_bel_st_and_fragmentation` |
| `1`, `3` | Icon-only title / X property | `unsupported`: no icon or X property host contract | `osc_selector_inventory_records_unsupported_operations` |
| `4` | Indexed color set/query | `implemented`: palette effect and exact RGB reply | `indexed_colors_and_combining_characters_survive_export`, `every_default_indexed_color_query_returns_the_default_palette` |
| `5`, `6` | Special color set / enable state | `unsupported`: no special-color or mode contract | `osc_selector_inventory_records_unsupported_operations` |
| `10`–`12` | VT foreground/background/cursor colors | `implemented`: effect and query reply | `dynamic_color_replies_and_screen_colors_use_the_same_palette`, `osc_default_color_queries_match_renderer_defaults` |
| `13`–`19`, `21` | Pointer, Tektronix, highlight colors, window title | `unsupported`: no corresponding exported state | `osc_selector_inventory_records_unsupported_operations` |
| `22` | Pointer shape | `unsupported`: native pointer shape is not a terminal protocol output | `osc_selector_inventory_records_unsupported_operations` |
| `46` | Log file | `unsupported`: terminal processes cannot select a host log file | `osc_selector_inventory_records_unsupported_operations` |
| `50` | Cursor font/shape operation | `implemented`: supported cursor-shape subform only; other font forms are rejected by the parser contract | `osc50_cursor_shape_changes_program_cursor` |
| `51` | Emacs shell reservation | `unsupported`: no effect | `osc_selector_inventory_records_unsupported_operations` |
| `52` | Clipboard selection store/query | `implemented`: policy-gated typed event and query reply | `clipboard_query_uses_a_token_and_resolves_to_pty_bytes`, `clipboard_rejection_clears_a_pending_query_token` |
| `60`–`62` | Permission feature queries | `unsupported`: capability status is owned by the sidecar contract, not an XTerm wire reply | `osc_selector_inventory_records_unsupported_operations` |
| `104` | Indexed color reset | `implemented`: palette reset | `osc104_resets_indexed_colors`, `osc104_without_parameters_resets_all_indexed_colors` |
| `105`, `106` | Special color reset/mode | `unsupported`: no special-color contract | `osc_selector_inventory_records_unsupported_operations` |
| `110`–`112` | Dynamic color reset | `implemented`: foreground/background/cursor reset | `osc_dynamic_color_resets_restore_defaults` |
| `I`, `l`, `L` | Sun/CDE icon and title forms | `unsupported`: no icon-label or nonnumeric selector contract | `osc_selector_inventory_records_unsupported_operations` |
| `7`, `8`, `9`, `133` | Directory, hyperlink, notification, shell metadata | `vendor`: separate contracts; not counted as standard OSC completion | `vendor_osc_contracts_are_separate` |
| `1337` | OSC 1337 inline image | `vendor`: bounded image contract | `osc1337_inline_image_is_typed_and_survives_input_chunk_boundaries` |

The unsupported rows are an explicit scope result, not successful no-ops. The engine emits an observable rejection event for each unsupported selector, including selectors split across input chunks and terminated by BEL or ST. The inventory test fails on duplicate or unclassified selectors and on a named test mismatch; it does not infer support from parser acceptance.

## Complete OSC and CSI requirement

## CSI selector evidence

The sidecar currently records only CSI selectors with executable behavior evidence: `3C`, `?12h/l`, `?25h/l`, `CSI 1–7 SP q` (DECSCUSR), `m`, `?1049h/l`, `S/T` with `r`, `J/K`, and `14t`. This partial inventory is not a complete CSI implementation claim; all unlisted movement, erase, mode, query, mouse, protected-cell, and attribute-stack categories remain open until named behavior or explicit rejection tests exist.

The terminal must maintain two separate inventories against the pinned XTerm reference:

- OSC: every standard selector in the reference, plus every selected vendor extension (including title, colors, hyperlinks, clipboard, notifications, shell metadata, and graphics). Each selector has an implementation test for its effect, response test when it is queryable, and explicit rejection test when policy or platform support prohibits it.
- CSI: every standard final byte, parameter form, private mode, and device-response sequence in the reference. This includes cursor movement and visibility, erase and insert/delete operations, scrolling, scroll regions, tabulation, modes, reports, and alternate-screen control. Each sequence has an effect, response, or explicit rejection test; parser acceptance alone is not evidence.

Scrolling is CSI, not OSC. The minimum scroll contract includes `CSI Ps S` (scroll up), `CSI Ps T` (scroll down), `CSI Ps ; Ps r` (set/reset scrolling region), `CSI Ps J` and `CSI Ps K` (erase operations that interact with the visible grid), and the corresponding cursor and alternate-screen semantics. The scrollback result, visible grid, cursor position, and selection behavior are tested separately.

The checklist is complete only when every inventory entry has a named test, a bounded timeout, an observable pass/fail result, and implementation evidence for both Tauri and Wails where the host participates. A sequence that is parsed and then ignored is not supported.

## Input and authorization

Explicit user paste may read the clipboard. A terminal program's OSC clipboard request is not user consent; it requires the configured policy and an observable denial when prohibited. File and image paste inserts quoted paths without executing them. Bracketed paste follows terminal mode and sends the original text exactly once. Invalid encoding rejects the complete request rather than accepting a prefix.

Marked-text selected ranges use UTF-16 location and length. Replacement ranges address the input client's existing text, not the new marked string. Grapheme segmentation and cell width use Unicode-aware libraries; handwritten code-point ranges are not the width contract.
