# External window sidebars

[한국어](external-sidebars.ko.md)

## Declaration and choices

The sides of a window are `left`, `right`, `top` and `bottom`. A plugin may declare `sidebars.window` as an object mapping any of the four sides to known local set IDs. Reject unknown sides, non-object mappings and missing sets. Card-side declarations remain independent. Normalize plugin choices to `{place: "window-<side>", plugin, set}`. General choices are `{place: "<side>", plugin: null, set}`. Validate every declaration, including overridden declarations. Explicit environment lists replace defaults; stored lists replace the effective list.

A window has at most one external sidebar on each side. Its card ID is the name of its side. Plugin settings override the content of this same fixed sidebar; they never allocate another sidebar. For the focused content card's active plugin, use its declared override when present; otherwise use the general side choice. This is normal choice precedence, not error recovery. Reject invalid or missing referenced sets instead of selecting another set. When a side has choices but neither a matching override nor a general set, retain its fixed sidebar with empty content. No inactive plugin output is displayed as an additional sidebar. Section tabs belong inside the selected set.

The four side names are reserved card IDs. A card of `environment.json` `workspace.grid` named by a side declares no `tabs`, and a stored card named by a side has no data; either is refused with an error that names the card.

`core.settings.link` accepts a known set or `off`. Removing a plugin link removes its override and exposes the general choice; removing a general link removes that general content choice. `inherit` is rejected for these links. Keep the existing four independent internal card-side selectors. Reject old plugin side links (a side place that names a plugin), null sets, rail links and the retired `cardSidebar` positioning setting. Do not add aliases or migration.

## Fixed placement and persistence

A side holds its window sidebar while its visibility switch (the setting of the side name: `left`, `right`, `top` or `bottom`) is on and it has a choice, a general link or a plugin window link of that side. A window sidebar is a fixed card of the plane. Its axis is `x` for `left` and `right` and `y` for `top` and `bottom`; it stands at the border of the plane on its side, one slot thick on its axis, and reaches along the other axis as far as the order lets it.

The setting `sidebarOrder` lists the four sides in the order in which their sidebars take the room of the plane. The sidebar of the first side that holds one reaches across the whole plane along its side. Each later sidebar reaches along the other axis only between the sidebars of earlier sides of that axis. With `top` first, the top sidebar spans the whole width and the left and right sidebars stand below it; with `left` first and `top` second, the top sidebar starts at the right side of the left sidebar. Two sides of one axis never meet, so their relative order changes nothing that is drawn unless a side of the other axis stands between them in the order.

The workbench arranges the sidebars in the reverse of the order: each sidebar is inserted at the border line of its side (`insertAt` on its axis at line 0 for `left` and `top`, at the last line for `right` and `bottom`) with its saved size, and set fixed, so the last insertion, the first side, reaches across the plane. When the sides that hold a sidebar or their arrangement differ from what the order gives, the workbench closes every window sidebar, removes the lines that no card references (`tidy`) and arranges them again. Arranging again from a plane without window sidebars gives an order the same arrangement whatever arrangement stood before. A sidebar that cannot leave yet, because its only filler is a fixed card while its slots hold another card (R7 of [soksak](../../packages/soksak/docs/layout.md)), leaves after the other window sidebars; when none can leave, the arrangement is refused with an error that names them. Focus and active-tab changes only select content and association; they do not insert, move, resize or duplicate a sidebar. A visibility switch hides its sidebar and preserves its choices and size. Fullscreen hides other cards temporarily; restoration returns their layout under the [fullscreen contract](example-model.md#card-fullscreen).

Save sizes in `windowSidebars`, keyed by side: `left` and `right` hold `{width}`, `top` and `bottom` hold `{height}`. A size is finite and positive. A record of a side with the member of the other axis or with another member, and a record of an unknown side, is refused with an error that names the side; the reader of the stored layout names its file. Do not store a plugin owner: the override context comes from the currently focused card and active tab. Reject persistent owner fields, plugin-specific sidebar IDs, old rail cards, rail widths and positioning data explicitly. Removing and arranging a sidebar again retains its side size. Do not convert old saved layouts into valid-looking new layouts.

A sidebar without a saved size starts at the size of the setting `sidebarWidth` on its axis. The sidebars of a new space take the `width` (left and right) or `height` (top and bottom) of their cards in `environment.json` `workspace.grid`.

## Window controls

The window chrome has one switch for each side, in the fixed order `left`, `right`, `top`, `bottom`, with the elements `core.chrome.left`, `core.chrome.right`, `core.chrome.top` and `core.chrome.bottom`, the icons `panel-left`, `panel-right`, `panel-top` and `panel-bottom`, and the tooltips 왼쪽 사이드바 보이기, 오른쪽 사이드바 보이기, 위 사이드바 보이기 and 아래 사이드바 보이기. A switch runs `core.settings.set {patch: {<side>: <the negated current value>}}` without `scope`, so the change goes to the project scope while a project is selected and otherwise to the common scope, and it is pressed while its setting is true. A window sidebar ends in a status line that names its side and ends in a fold control, `core.sidebar.fold`, which runs `core.settings.set {patch: {<side>: false}}` in the same scope.

## Override context and rail border

Only a currently applied plugin override associates the fixed sidebar with its focused content card and active surface. Supply that card and tab as `context.card` and `context.surface`. General content has null association and no rail border. Selecting a different plugin updates the selected set, context and rail in the same presentation; old sections are disposed. A section state module retains its declared priority. Missing required surface state or commands produce explicit unavailable state/errors instead of selecting another surface.

Rail means only the border joining a content card and its overridden external sidebar or sidebars. Compute it from presented rectangles. Adjacent rectangles across the declared gap produce one outer outline; disconnected rectangles produce separate outlines. General sidebars and internal card sections do not create rail groups. Focus indication remains independent.

`core.rail` exposes aggregate path and groups identifying the associated content card and fixed sidebar IDs of any side. `core.sidebars` exposes placement, applied plugin or null, card and active tab or null, selected set, orientation, section tabs and presented rectangle of the sidebar of every side. The sections of a `left` or `right` window sidebar use the vertical implementations, and the sections of a `top` or `bottom` window sidebar use the horizontal implementations of the top and bottom card sides; internal sections follow their card-side orientation.

A window-sidebar section is a section surface whose view runs the commands of its plugin with the surface that `core.sidebars` reports for it, the active tab of the focused card, which may differ from the surface that the person last clicked ([sections](plugins.md#sections)). A missing surface or command registration fails; the command does not fall back to another surface or owner.

## Verification

The plane check `P 자리는 카드다` computes the expected place of each window sidebar from the order and the sides that hold one: the sidebar is fixed, stands at the border line of its side, reaches along the other axis from the border or from the inner line of the sidebar of an earlier side of that axis, to the opposite border or the inner line of such a sidebar, and is drawn no larger on its axis than its saved size.

## Acceptance

- Retain owning pre-correction Red for duplicate sidebars of one side, selected override precedence, retired identities/owners and unnecessary rail groups. Run the same assertions after correction.
- Verify fixed identity, position and size through focus/tab changes; general content, plugin overrides, valid empty content, off selection, saved sizes and invalid data are separate cases.
- Verify the arrangement of order and visibility changes, including hiding the first side of an order whose later sidebar stands inside it, with the shared layout cases of `docs/spec/cases/layout/window-sidebars.json` in both workbenches.
- Every rebuilt host must present one sidebar per configured side in the order. Observe actual section tabs/output and rail borders, measure fullscreen/restoration, setting changes and reload persistence, and record complete gestures with machine-checkable coordinates and pixels.
- Current old-column tests and earlier recordings do not validate this corrected contract. Update affected fixtures without weakening timing, geometry, input completeness or cleanup criteria. Shared gates and release application remain separate incomplete work.
