# External window sidebars

[한국어](external-sidebars.ko.md)

The fixed-edge override contract replaces the defective per-plugin columns and persistent owners from V5-117-1-3-3. Correction and related rebuilt-host checks are complete under V5-117-1-3-4-7 in [features](../features.md). Broader recorded acceptance remains pending under V5-117-1-3-4, and existing user-release validation/application remains V5-117-1-3-4-7-1.

## Declaration and choices

A plugin may declare `sidebars.window` as an object mapping `left` and `right` to known local set IDs. Reject unknown sides, non-object mappings and missing sets. Card-side declarations remain independent. Normalize plugin choices to `{place: "window-left" or "window-right", plugin, set}`. General choices are `{place: "left" or "right", plugin: null, set}`. Validate every declaration, including overridden declarations. Explicit environment lists replace defaults; stored lists replace the effective list.

A window has at most one external sidebar on each side. Its card ID is `left` or `right`. Plugin settings override the content of this same fixed sidebar; they never allocate another column. For the focused content card's active plugin, use its declared override when present; otherwise use the general side choice. This is normal choice precedence, not error recovery. Reject invalid or missing referenced sets instead of selecting another set. When a side has choices but neither a matching override nor a general set, retain its fixed column with empty content. No inactive plugin output is displayed as an additional sidebar. Section tabs belong inside the selected set.

`core.settings.link` accepts a known set or `off`. Removing a plugin link removes its override and exposes the general choice; removing a general link removes that general content choice. `inherit` is rejected for these links. Keep the existing four independent internal card-side selectors. Reject old plugin `left`/`right` links, null sets, rail links and the retired `cardSidebar` positioning setting. Do not add aliases or migration.

## Fixed placement and persistence

A configured edge occupies one fixed full-height column. General and plugin choices use its same position and saved width. Focus and active-tab changes only select content and association; they do not insert, move, resize or duplicate that column. The left/right visibility switch hides the corresponding column and preserves choices and width. Fullscreen hides other cards temporarily; restoration returns their layout under the [fullscreen contract](example-model.md#card-fullscreen).

Save widths in `windowSidebars`, keyed only by `left` and `right`, with records `{width}`. Width is finite and positive. Do not store a plugin owner: the override context comes from the currently focused card and active tab. Reject persistent owner fields, plugin-specific sidebar IDs, old rail cards, rail widths and positioning data explicitly. Removing and recreating a hidden column retains its edge width. Do not convert old saved layouts into valid-looking new layouts.

## Override context and rail border

Only a currently applied plugin override associates the fixed sidebar with its focused content card and active surface. Supply that card and tab as `context.card` and `context.surface`. General content has null association and no rail border. Selecting a different plugin updates the selected set, context and rail in the same presentation; old sections are disposed. A section state module retains its declared priority. Missing required surface state or commands produce explicit unavailable state/errors instead of selecting another surface.

Rail means only the border joining a content card and its overridden external sidebar or sidebars. Compute it from presented rectangles. Adjacent rectangles across the declared gap produce one outer outline; disconnected rectangles produce separate outlines. General sidebars and internal card sections do not create rail groups. Focus indication remains independent.

`core.rail` exposes aggregate path and groups identifying the associated content card and fixed sidebar IDs. `core.sidebars` exposes placement, applied plugin or null, card and active tab or null, selected set, orientation, section tabs and presented rectangle. Window sidebar sections use vertical implementations; internal sections follow their card-side orientation.

## Acceptance

- Retain owning pre-correction Red for duplicate left/right columns, selected override precedence, retired identities/owners and unnecessary rail groups. Run the same assertions after correction.
- Verify fixed identity, position and width through focus/tab changes; general content, plugin overrides, valid empty content, off selection, saved widths and invalid data are separate cases.
- Both rebuilt hosts must present one sidebar per configured edge. Observe actual section tabs/output and rail borders, measure fullscreen/restoration, setting changes and reload persistence, and record complete gestures with machine-checkable coordinates and pixels.
- Current old-column tests and earlier recordings do not validate this corrected contract. Update affected fixtures without weakening timing, geometry, input completeness or cleanup criteria. Shared gates and release application remain separate incomplete work.
