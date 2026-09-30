# External window sidebars

[한국어](external-sidebars.ko.md)

Window validation, independent settings choices, stable workbench cards, saved owner/width state and presented border groups are implemented under V5-117-1-3-2 and V5-117-1-3-3. Old plugin left/right, null-inheritance, positioning and saved rail inputs are explicitly rejected. The three application environments use window links. Full recorded application acceptance remains pending under V5-117-1-3-4 in [features](../features.md); implementation tests do not close that scope.

## Declaration and choices

A plugin may declare `sidebars.window` as an object mapping `left` and `right` to local set IDs from its `sidebars.sets`. Either side may be omitted. Reject unknown sides, non-object mappings, and missing local sets. A surface is not required for a window sidebar; a section-only plugin can contribute one. The existing `sidebars.card` mapping continues to describe the four internal card sides and requires a surface. A window side and a card side are independent and may coexist.

Normalize window defaults to `{place: "window-left" or "window-right", plugin: "<plugin id>", set: "<plugin>.<local set>"}`. Explicit environment sidebar lists replace normalized defaults; stored lists replace the corresponding effective list. Validate declarations even when an override replaces their output.

General window links remain `{place: "left" or "right", plugin: null, set}`. Plugin window links use only `window-left` or `window-right`, a registered plugin ID, and a known set ID. A missing link means that sidebar is absent. `core.settings.link` accepts a set ID or `off` to remove either kind of window link; `inherit` is invalid for window links. There is no focus-dependent general inheritance or plugin `set: null`. Reject the old plugin `left`/`right` form and all rail links explicitly. Card-side links retain their independent contract.

The general settings page exposes the left/right visibility switches and general window set choices. Each plugin page exposes two window-side choices; plugins with surfaces also expose four card-side choices, each offering the known sets and 사용 안 함. Remove the `cardSidebar` positioning setting and its flow/pin/inset/off control. Card sidebars are always inside their cards; disabling a card side uses its set choice.

## Identity and placement

Each configured window sidebar is a card containing sections, not a rail entity. General sidebar card IDs are `left` and `right`; plugin sidebar card IDs are `window:<plugin>:<side>`. These IDs cannot identify content cards. Window sidebar cards have no surface tabs and use vertical section implementations.

Configured window sidebar cards exist independently of focused cards, active tabs, and the presence of tabs of their declaring plugin. The `left`/`right` visibility switch hides all window sidebars on that side while retaining their saved widths, section choices, and associations. Only an explicit link or visibility change alters which window sidebar columns exist. Fullscreen temporarily hides other cards under the existing [fullscreen contract](example-model.md#card-fullscreen), and restoration returns their saved layout.

Window sidebar cards occupy fixed full-height columns at their declared edge. On each edge the general sidebar is outermost, followed from outside to inside by plugin sidebars in environment plugin order. Sidebar extent comes from its saved width, or the declared initial width for a new sidebar. Content cards share the residual area. Do not derive placement, width, visibility, or set selection from focus. Multiple plugins may declare the same side; none replaces or silently discards another.

## Association and rail border

Each plugin window sidebar retains one owner tab ID in the space's `windowSidebars` record keyed by sidebar card ID as `{width, owner}`. `width` is a finite positive point value and `owner` is a tab ID or null; general sidebar records use null. On first creation, associate it with the first tab of its declaring plugin in saved card order and tab order, or null when none exists. A valid saved owner remains the owner even when inactive. The associated card is the card containing that tab. Focus and active-tab changes cannot change this association. General sidebars have no association.

Moving the owner tab to another card changes the association to that card. Closing the owner tab selects the first remaining tab of the declaring plugin in saved order, or null. Adding the first such tab to an unassociated sidebar establishes the association. These are structural tab operations; they do not remove or resize the external sidebar. Save association changes with the space. Reject malformed records, unknown sidebar IDs, invalid widths, a missing owner tab, or an owner tab of another plugin. Do not repair invalid saved data by choosing a plausible owner. Reject obsolete rail cards, rail widths, and positioning settings without migration or aliases.

Window section context uses the associated card ID and owner tab ID as `context.card` and `context.surface`; both are null for an unassociated or general sidebar. Selecting another active tab does not retarget the section. A declared state module retains its existing priority. Without state registration, an unavailable owner surface produces a null status and an explicit command error instead of selecting another surface by focus. Expose `unavailable` when the owner tab is absent or inactive in its associated card. Transport registration is checked separately by the exposure registry.

Rail means only the border joining an associated content card and its external sidebar cards. Calculate the outline from their presented rectangles, not a pending grid or focused card. Group all external sidebars associated with the same card. When the rectangles are adjacent across the declared layout gap, draw one outer outline; when separated by other cards, draw separate outlines around the disconnected participants. Unassociated sidebars retain their ordinary card borders and have no rail outline. Focus indication remains independent.

`core.rail` exposes the aggregate path and a `groups` array with each associated card ID, sidebar card IDs, path, and outline loops. `core.sidebars` exposes window/card placement, declaring plugin or null, associated card and owner tab or null, set, orientation, and presented rectangle. This declared state is required for geometry and pixel verification.

## Acceptance

- Owning plugin-api tests establish pre-implementation Red for window declarations, normalization, rejected old links, and independent card/window choices; unchanged tests pass after implementation.
- Owning workbench tests establish Red for focus/tab-driven column changes. Verify multiple plugins per side, stable saved association, structural tab moves/removal, width restoration, invalid stored data, and adjacent/detached outline loops through declared consumer boundaries.
- Both rebuilt hosts retain identical external sidebar and content-card geometry through focus changes and different-plugin tab selection. Verify actual section output, association, and one outer outline versus separate outlines in full native recordings with measured pixels and coordinates.
- Measure fullscreen and restoration, settings persistence after reload, complete pointer input and frame coverage, and strict recording cleanup. Reconcile the obsolete outside fixture without weakening its existing 34ms delay or alignment criteria. Owner passes alone do not close application acceptance or release application.
