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

## Complete OSC and CSI requirement

The terminal must maintain two separate inventories against the pinned XTerm reference:

- OSC: every standard selector in the reference, plus every selected vendor extension (including title, colors, hyperlinks, clipboard, notifications, shell metadata, and graphics). Each selector has an implementation test for its effect, response test when it is queryable, and explicit rejection test when policy or platform support prohibits it.
- CSI: every standard final byte, parameter form, private mode, and device-response sequence in the reference. This includes cursor movement and visibility, erase and insert/delete operations, scrolling, scroll regions, tabulation, modes, reports, and alternate-screen control. Each sequence has an effect, response, or explicit rejection test; parser acceptance alone is not evidence.

Scrolling is CSI, not OSC. The minimum scroll contract includes `CSI Ps S` (scroll up), `CSI Ps T` (scroll down), `CSI Ps ; Ps r` (set/reset scrolling region), `CSI Ps J` and `CSI Ps K` (erase operations that interact with the visible grid), and the corresponding cursor and alternate-screen semantics. The scrollback result, visible grid, cursor position, and selection behavior are tested separately.

The checklist is complete only when every inventory entry has a named test, a bounded timeout, an observable pass/fail result, and implementation evidence for both Tauri and Wails where the host participates. A sequence that is parsed and then ignored is not supported.

## Input and authorization

Explicit user paste may read the clipboard. A terminal program's OSC clipboard request is not user consent; it requires the configured policy and an observable denial when prohibited. File and image paste inserts quoted paths without executing them. Bracketed paste follows terminal mode and sends the original text exactly once. Invalid encoding rejects the complete request rather than accepting a prefix.

Marked-text selected ranges use UTF-16 location and length. Replacement ranges address the input client's existing text, not the new marked string. Grapheme segmentation and cell width use Unicode-aware libraries; handwritten code-point ranges are not the width contract.
