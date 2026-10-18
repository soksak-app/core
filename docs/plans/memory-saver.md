# Memory saver

[한국어](memory-saver.ko.md)

Pending proposal for F198. Its approved content moves into `docs/spec/plugins.md`, `docs/spec/settings.md`, `docs/spec/exposure.md`, `docs/spec/hosts.md` and `docs/spec/logging.md`, and this file is removed.

## Problem

A tab that is not shown is never released. `dormant()` in `packages/workbench/index.html` commits every tab that is not shown as an invisible surface: the other tabs of each card and every tab of every space and project. `disposeSurfacesExcept` releases only tabs that no longer exist, and a surface is released only when its tab closes (`closeTab` → `disposeSurface`). A hidden document tab keeps its WebContent process and page; a hidden DOM tab keeps its DOM and objects in the main page process; a hidden image tab keeps its image region. F196.29 clears the back-forward cache of a hidden document region, but its shown page and process stay.

## Decision

The core unloads a hidden tab and restores it from its stored state when it is shown again. One setting turns this on or off. The core alone decides when; a plugin declares whether its tabs can be unloaded and keeps its state current.

Terms: **unload** (release the surface of a tab that stays in the layout) and **restore** (mount an unloaded tab again from its state). No other word names these two operations.

### Rules

1. **The core decides.** Only the core decides when a tab is unloaded and restored. A plugin has no timer and no unload decision.
2. **Every plugin declares.** `surface.unload` is a required field of a surface in `plugin.json`: `false`, or `{format, maxBytes}` for a plugin whose tabs can be unloaded. `validateManifest` rejects a manifest without it. `surface.unload` and `background` exclude each other in one manifest: a plugin with a background session keeps its session through the background path (F192). A tab whose plugin declares `false` is never unloaded and appears in the status with the reason `undeclared`.
3. **State is written on each change, kept in memory at once, stored with the tab.** A declaring plugin writes the state it needs, as JSON, through `context.tab.state.write(value)` whenever it changes. The write is synchronous into memory, so an unload in the same task sees the latest value. The core stores it with the tab as `{format, value}` and writes the layout store with the existing persistence, coalescing writes of one tab and never dropping the last value; each coalesced write is an event. A value that is not JSON or exceeds `maxBytes` is refused with an error that names the tab and the size. After the surface is disposed, `state.write` from the old context throws, so an old instance cannot overwrite the state of a restored one. A restored surface reads `context.tab.state.read()`; a stored format other than the declared one is refused with a restore error that names the tab and the format found. Only state written through this API survives an unload, a crash or a restart; each plugin states in its own specification what it gives up.
4. **Protections.** A tab is not unloaded while any of these holds; each is a named reason, and a tab can have several:
   - `shown`: the shown tab of its card in a shown space.
   - `recent`: shown less than the delay ago.
   - `restored`: restored less than 60 seconds ago.
   - `keep`: the surface holds a keep reason through `context.tab.keep(reason, on)` with `reason` `modified` (unsaved changes) or `busy` (work in progress). A keep reason ends when the surface is disposed. A surface that reported `modified` stays kept until it reports it clean.
   - `media`: the document region plays audio or video, shows picture in picture, or captures camera, microphone or screen; the region reports changes as events through the public WebKit properties.
   - `form`: the document region has a form field that the person edited since the last load; the region script reports it.
   - `download`: the document region has a download in progress.
   - `kept`: the person marked the tab to stay loaded (`core.tab.keep`); stored with the tab.
   - `off`: the setting is off, or the platform does not report media (then the status says `not implemented on <os>` and nothing is unloaded).
5. **Two triggers.**
   - `delay`: a tab hidden for the delay (default 5 minutes) without a protection is unloaded. One core scheduler holds the earliest deadline, computed from the monotonic time each tab was hidden, and re-arms on the existing events that change it (a tab shown or hidden, a protection change, a setting change). It uses a timer because elapsed time has no event source; the code and the specification state that reason.
   - `pressure`: the host reports `memory-pressure {level, seq}` (warn or critical) from the one native source that F196.29 already registers; the document regions and the page receive it from that source. On each report the core unloads one hidden tab without a protection, the least recently shown first. `recent` does not protect under pressure; `restored` and every other protection do.
6. **Restart.** At startup, a hidden tab whose plugin declares `surface.unload` starts unloaded and is restored on its first show.
7. **Visible and observable.**
   - The tab button carries `data-tab-state` `unloaded` or `kept`, with a dom name, and a restoring tab shows the surface status `restoring`.
   - Events in the core catalog, class `lifecycle`: `page.tab.unloaded {tab, plugin, trigger}` (info), `page.tab.restored {tab, plugin}` (info), `page.tab.restore.failed {tab, plugin, reason}` (error, through the single error display), `page.tab.kept {tab, reasons}` (debug, emitted only when the protections of a tab change).
   - Status `core.tab.memory`: `{enabled, delay, pressure: {level, seq}, tabs: [{tab, plugin, state: loaded|unloaded|restoring, reasons, hiddenAt, unloadAt}]}`, notified on each change; `core.surfaces` reports the state of each tab, and a request to an unloaded surface fails with `tab <id> is unloaded`.
8. **Commands.** `core.tab.keep {tab, keep}` (idempotent; an unknown tab or a non-boolean is -32602) with a tab context menu item bound through the binder; `core.tab.unload {tab}` unloads a hidden tab now, the same operation as a trigger, and fails with the protections when the tab is protected.

### Setting

- `memorySaver` (boolean, common scope, default on), section 일반, label "메모리 절약", switch.
- `memorySaverDelay` (integer minutes 1 to 60, common scope, default 5), label "숨긴 뒤 내리기까지", slider. Another value is refused with `Invalid setting memorySaverDelay: <value>`. A change re-arms the scheduler.

One setting covers every plugin. A plugin adds no setting of its own; a site exception list, if a plugin needs one, is that plugin's setting and reaches the core as a keep reason.

### Scope and order

- The core contract covers every surface kind. Adoption starts with document tabs, whose unload ends a WebContent process.
- A DOM tab (editor, flowmark, shell) shares the main page process; its gain is measured first with a tracked benchmark (hidden DOM tabs of each plugin, main page footprint before and after unloading N of them). A DOM plugin adopts the declaration only when that benchmark shows a gain, and the plan records the numbers.
- The terminal keeps its background session (F192) and is not part of this item; releasing the image region of a hidden terminal is measured separately.
- What each plugin stores is specified in its own repository; the core lists its release as a checklist item.

### Browser history

The document region keeps the session history of an unloaded tab as the public `interactionState` of its web view, in memory of the process, and restores it on restore; it is not stored, so after a restart only the address that the plugin wrote is restored. The address moves from the browser's own `localStorage` key into `context.tab.state` in the same change.

### Stored format

Tab state, `kept` and the unloaded flag change the layout store, so its format number is raised and a migration definition ships with the release (existing tabs get no state and are loaded). The format number is chosen with the release that ships it; this plan does not set it.

## Adopted and not adopted

- Adopted: unloading hidden tabs after a delay and under memory pressure; a required declaration per plugin; state written on each change with a format and a size limit; the protections above, read from the web view where it owns the fact; one tab per pressure report, least recently shown first; a single scheduler; restore at first show after a restart; the reasons and protections as events and status; session history kept in memory with the public `interactionState`.
- Not adopted: unloading on hide at once; a save hook at unload; unloading undeclared tabs; persisting the full session history; per-plugin settings; unloading DOM tabs before a measured gain.

## Steps

Each step is one checklist item with Red first at the owning module.

1. F198.1 Terms and specification (`unload`, `restore`, protections, `surface.unload`, `context.tab.state`, `context.tab.keep`, events, status, commands, setting); `validateManifest` requires `surface.unload` and rejects it beside `background`.
2. F198.2 Layout format and tab state store with the migration definition (the format number is chosen with its release).
3. F198.3 `context.tab.state` and `context.tab.keep` in `surface-modules.js`; a dispose that ends before the next mount (mount awaits a pending dispose); writes after dispose throw.
4. F198.4 The scheduler, the protections and the unload and restore operations in the workbench; `mock.timers` drives the delay in tests.
5. F198.5 Document region reports: media, form edits and downloads as events; `interactionState` keep and restore.
6. F198.6 Host relay of `memory-pressure` in Go and Rust from the one native source, with a contract case and a declared fault injection for tests.
7. F198.7 Setting and its validation; the commands `core.tab.keep` and `core.tab.unload` with their controls.
8. F198.8 Tab button state and the restore failure through the error display.
9. F198.9 DOM tab benchmark.
10. F198.10 Window check on both hosts: `core.tab.unload` and a pressure fault injection unload a hidden browser tab, `core.tab.memory` and the region process show it, and showing the tab restores the address.
11. Plugin adoption in each plugin repository, and their releases as core checklist items.

## Review

Round 1 (three reviewers: correctness, architecture, rules). Each objection and its answer:

- Opt-in lets a plugin keep memory unnoticed → the declaration is required and `false` is listed as `undeclared` (rule 2).
- A timer per tab breaks the event rule → one scheduler with the stated reason (rule 5).
- Pressure only (unload no tab without pressure) → rejected: a hidden tab costs tens to hundreds of megabytes while the system is under no pressure, which F196 measured; the delay stays, on by default, and the person can turn it off.
- A self-reported busy flag can stick → keep reasons end at dispose and are listed with their reasons in the status.
- `modified` depends on the plugin and can be missed before a file is read → a reported `modified` stays until clean, and each plugin's tests cover edits before the first read.
- Form input, downloads and media are lost → named protections read from the web view.
- Back history is lost → kept in memory with `interactionState`.
- Dispose and mount race → mount awaits a pending dispose.
- State writes race unload and restart → synchronous memory write, coalesced store write that keeps the last value, writes after dispose throw.
- Tab state without format or size → `{format, maxBytes}` declared, refused beyond it, format mismatch is a restore error.
- Pressure thrashing → `restored` protection and one tab per report.
- Two pressure observers → one native source feeds both consumers.
- Undeclared tabs are not helped → stated in scope and listed in the status.
- Restore failures and restart → a restore failure event through the error display; hidden tabs start unloaded.
- Events, terms, status schema, command schemas, setting names and scope, layout format, platform without media detection, test per step, window check without lowering the setting range → answered in rules 5 to 8, the setting, the stored format and the steps.
- DOM tabs may not gain enough → adoption follows a measured benchmark.
- Terminal could release its image region → measured separately; its background session stays.
