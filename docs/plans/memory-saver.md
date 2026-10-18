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
2. **Every plugin declares.** A surface in `plugin.json` declares `surface.unload`: `false`, or `{format, maxBytes}` for a plugin whose tabs can be unloaded. It is required unless the plugin declares `background`, and forbidden when it does: a plugin with a background session keeps its session through the background path (F192). `validateManifest` rejects a manifest that breaks either rule. A tab whose plugin declares `false` is never unloaded and appears in the status with the reason `undeclared`; a tab of a plugin with `background` appears with the reason `background`.
3. **State is written on each change, kept in memory at once, stored per tab.** A declaring plugin writes the state it needs, as JSON, through `context.tab.state.write(value)` whenever it changes. The write is synchronous into memory, so an unload in the same task sees the latest value. The core stores it per tab as `{format, value}` in the tab state store (see Stored format), the value in memory is never dropped and the stored value follows it within one second (see Stored format); each store write of a tab is the event `page.tab.state.stored {tab, bytes}`. A value that is not JSON or exceeds `maxBytes` is refused with an error that names the tab and the size. After the surface is disposed, `state.write` from the old context is refused with an error that names the tab and `disposed`, logged once per context, so an old instance cannot overwrite the state of a restored one; a plugin stops its pending work with the existing `context.closing` signal, which aborts at dispose. A restored surface reads `context.tab.state.read()`, which is `null` when the store has no entry for the tab; a stored format other than the declared one is refused with a restore error that names the tab and the format found. Only state written through this API survives an unload, a crash or a restart; each plugin states in its own specification what it gives up.
4. **Protections.** A tab is not unloaded while any of these holds; each is a reason of the enumeration in rule 7, and a tab can have several:
   - `shown`: the shown tab of its card in a shown space.
   - `recent`: shown less than the delay ago.
   - `keep:modified` and `keep:busy`: the surface holds a keep reason through `context.tab.keep(reason, on)` with `reason` `modified` (unsaved changes) or `busy` (work in progress). A keep reason ends when the surface is disposed. A surface that reported `modified` stays kept until it reports it clean.
   - `media`: the document region plays media. At each decision (a delay deadline, a pressure report or `core.tab.unload`) the core asks the region and awaits the reply of the public `requestMediaPlaybackState` of its web view; `playing` protects the tab. A reply that fails, for example because the region is gone, protects the tab with the reason `media-unknown` and is logged. Active camera or microphone capture, from the public `cameraCaptureState` and `microphoneCaptureState` by key-value observation, is the separate reason `capture`, which changes as the observation reports. Paused media in picture in picture is not covered, because WebKit reports no public picture in picture state; screen capture is not covered, because a region does not grant `getDisplayMedia`.
   - `form`: a frame of the document region has an editable element (form field or `contenteditable`) that received a trusted `input` event since that frame's document loaded. WebKit offers no public engine state for this, so a region script in the region content world, injected into every frame (`forMainFrameOnly` off), reports it. The native region keeps the flags in a map keyed by the frame identifier of the script message; a frame's `pagehide` clears its flag, a form `submit` clears it, and a main-frame navigation commit or reload clears the map. A registered `beforeunload` handler is not a protection: the content world cannot see the listeners of the page. A `form` flag lasts until one of those events, so an edited field that the person leaves keeps the tab loaded; the person releases it by navigating or with `core.tab.unload`.
   - `kept`: the person marked the tab to stay loaded with `core.tab.keep`; the mark is stored in the tab state store.
   - `off`: the setting is off.

   A region does not download: a navigation that the view cannot show fails or is cancelled, so no download protection exists. Download support would be a separate item with its own protection.
5. **Two triggers.**
   - `delay`: a tab hidden for the delay (default 2 hours, the order of mainstream defaults) without a protection is unloaded. One core scheduler holds the earliest deadline, computed from the monotonic time each tab was hidden, and re-arms on the existing events that change it (a tab shown or hidden, a protection change, a setting change). It uses a timer because elapsed time has no event source; the code and the specification state that reason. A tab that `media` or `media-unknown` protects at its deadline gets its next deadline one delay later, shown in `unloadAt`.
   - `pressure`: one native memory pressure source starts with the host, reads the level (warn or critical) and numbers each report. It calls the document region consumer of F196.29, which subscribes instead of owning a source, and the host sends one event `memory-pressure {level, seq}` to the page. On each report the core unloads one hidden tab without a protection, the least recently shown first. `recent` does not protect under pressure; every other protection does. The least recently shown order keeps a tab that was just restored last in line. A report that finds no candidate is the event `page.tab.unload.skipped {trigger, seq, reasons}`.
6. **Restart.** While `memorySaver` is on, a hidden tab whose plugin declares `surface.unload` starts unloaded at startup and is restored on its first show. While it is off, hidden tabs mount as they do now.

   `dormant()` leaves an unloaded tab out of the invisible surfaces it declares, so the host releases that surface at the next commit; the tab stays in the layout, and its state stays because the store is keyed by the tab identifiers of the layout.
7. **Visible and observable.**
   - The tab button carries `data-tab-state` with the state of the status (`loaded`, `unloaded` or `restoring`) and a dom name; protections are shown only through the reasons of the status.
   - Events in the core catalog, class `lifecycle`: `page.tab.unloaded {tab, plugin, trigger}` (info), `page.tab.restored {tab, plugin, history}` (info; `history` is false when no session history was captured), `page.tab.restore.failed {tab, plugin, reason}` (error, through the single error display), `page.tab.unload.skipped {trigger, seq, reasons}` (info), `page.tab.state.stored {tab, bytes}` (debug).
   - Reasons, one enumeration used by the status and the events: `shown`, `recent`, `keep:modified`, `keep:busy`, `media`, `media-unknown`, `capture`, `form`, `kept`, `off`, `undeclared`, `background`. `media` and `media-unknown` are the result of the last decision, at the `checkedAt` of the tab; the other reasons change as their sources report.
   - Status `core.tab.memory`: `{enabled, delay, pressure: {level, seq}, tabs: [{tab, plugin, state: loaded|unloaded|restoring, reasons, hiddenAt, unloadAt, checkedAt}]}`, notified on each change; `core.surfaces` reports the state of each tab, and a request to an unloaded surface fails with `tab <id> is unloaded`.
8. **Command.** `core.tab.unload {tab}` unloads a hidden tab now. As the person's own decision it does not wait for `recent`, `media`, `media-unknown`, `capture` or `form`; it fails with the remaining protections (`shown`, `keep:modified`, `keep:busy`, `kept`, `off`, `undeclared`, `background`) and with -32602 for an unknown tab. `core.tab.keep {tab, keep}` sets or clears the person's mark (idempotent; -32602 for an unknown tab or a non-boolean), with a tab context menu item bound through the binder.

### Setting

- `memorySaver` (boolean, common scope, default on), section 일반, label "메모리 절약", switch.
- `memorySaverDelay` (integer minutes 5 to 720, common scope, default 120), label "숨긴 뒤 내리기까지", slider. Another value is refused with `Invalid setting memorySaverDelay: <value>`. A change re-arms the scheduler.

One setting covers every plugin. A plugin adds no setting of its own; a site exception list, if a plugin needs one, is that plugin's setting and reaches the core as a keep reason.

### Scope and order

- The core contract covers every surface kind. Adoption starts with document tabs, whose unload ends a WebContent process.
- A DOM tab (editor, flowmark, shell) shares the main page process; its gain is measured first with a tracked benchmark (hidden DOM tabs of each plugin, main page footprint before and after unloading N of them). A DOM plugin adopts the declaration only when that benchmark shows a gain, and the plan records the numbers.
- The terminal keeps its background session (F192) and is not part of this item; releasing the image region of a hidden terminal is measured separately.
- What each plugin stores is specified in its own repository; the core lists its release as a checklist item.

### Browser history

Before an unloaded region closes, the native region returns the public `interactionState` of its web view, serialized session history that holds no document or process, through the host to the page. The page keeps it with the tab in memory, not in the store, and passes it to the region it creates on restore; a value that the web view refuses is a `page.tab.restore.failed` reason. When the read yields nothing, because the process already ended, the region is created at the stored address and `page.tab.restored` carries `history: false`. After a restart only the address that the plugin wrote is restored. The address moves from the browser's own `localStorage` key into `context.tab.state` in the same change.

### Stored format

Tab state is not stored in `projects.json`. A new store `tab-state.json` in the configuration folder, format 1 from its first release, holds per tab identifier the `{format, value}` state and the `kept` mark. Whether a tab is unloaded is not stored: rule 6 derives it. Writes of one tab are coalesced to at most one per second and flushed at quit, so a crash loses at most the last second of state. A tab without an entry reads `null`. An entry is removed only after the layout write that drops its tab is confirmed. At load the store is reconciled with the tab identifiers of `projects.json`, and each orphan entry it removes is an event. A reader accepts only the current format. `projects.json` keeps its format, because its contents do not change. A separate store also keeps the frequent state writes away from the whole layout file; plugin `data` is keyed per project and declared key, not per tab, so it is not the owner.

## Adopted and not adopted

- Adopted: unloading hidden tabs after a delay and under memory pressure; a required declaration per plugin; state written on each change with a format and a size limit; the protections above, read from the web view where it owns the fact; one tab per pressure report, least recently shown first; a single scheduler; restore at first show after a restart; the reasons and protections as events and status; session history kept in memory with the public `interactionState`.
- Not adopted: a cap on the number of loaded hidden tabs in the first version (memory pressure answers the real memory limit; a cap is measured after the delay and pressure paths ship); unloading on hide at once; a save hook at unload; unloading undeclared tabs; persisting the full session history; per-plugin settings; unloading DOM tabs before a measured gain; a page script for media (the engine answers it); a short default delay chosen for a lower memory reading.

## Steps

Each step is one checklist item with Red first at the owning module.

1. F198.1 Terms and specification (`unload`, `restore`, protections, `surface.unload`, `context.tab.state`, `context.tab.keep`, events, status, commands, setting); `validateManifest` requires `surface.unload` and rejects it beside `background`.
2. F198.2 The tab state store `tab-state.json` (format 1): its reader that refuses another format, coalescing with the flush at quit, the write order with the layout, and the reconciliation at load.
3. F198.3 `context.tab.state` and `context.tab.keep` in `surface-modules.js`; a dispose that ends before the next mount (mount awaits a pending dispose); writes after dispose are refused and logged once per context (Red: a second write logs nothing more).
4. F198.4 The scheduler, the protections and the unload and restore operations in the workbench; `dormant()` leaves an unloaded tab out (Red: a commit after an unload neither mounts the tab again nor removes its store entry); `mock.timers` drives the delay in tests.
5. F198.5 Document region reports: the media playback query, camera and microphone by key-value observation; form edits from the region script in every frame with the per-frame map (Red: a removed subframe and a reload clear their flags); `interactionState` returned before close and passed on restore, with the empty case.
6. F198.6 The native memory pressure source moves to an owner that starts with the host, reads the level and numbers each report; the region consumer subscribes to it; Go and Rust relay `memory-pressure {level, seq}` with a contract case and a declared fault injection; `docs/spec/hosts.md` states the ownership.
7. F198.7 Setting and its validation; the commands `core.tab.unload` and `core.tab.keep` with the context menu item.
8. F198.8 Tab button state and the restore failure through the error display.
9. F198.9 DOM tab benchmark.
10. F198.10 Window check on both hosts: `core.tab.unload` and a pressure fault injection unload a hidden browser tab, `core.tab.memory` and the region process show it, and showing the tab restores the address.
11. Plugin adoption in each plugin repository, and their releases as core checklist items.
12. The release that turns `memorySaver` on by default ships only after F198.5 provides every protection.

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
- State writes race unload and restart → synchronous memory write, coalesced store write that keeps the last value, writes after dispose are refused and logged once per context (Red: a second write logs nothing more).
- Tab state without format or size → `{format, maxBytes}` declared, refused beyond it, format mismatch is a restore error.
- Pressure thrashing → one tab per report (the `restored` protection of this round was removed in round 3).
- Two pressure observers → one native source feeds both consumers.
- Undeclared tabs are not helped → stated in scope and listed in the status.
- Restore failures and restart → a restore failure event through the error display; hidden tabs start unloaded.
- Events, terms, status schema, command schemas, setting names and scope, layout format, platform without media detection, test per step, window check without lowering the setting range → answered in rules 5 to 8, the setting, the stored format and the steps.
- DOM tabs may not gain enough → adoption follows a measured benchmark.
- Terminal could release its image region → measured separately; its background session stays.

Round 2 (one reviewer). Each objection and its answer:

- Playback and picture in picture have no public observable property on macOS 14.4, so `media` would force polling, a private API or a disabled feature → playback and picture in picture come from media element events in a region script in every frame; camera and microphone stay on key-value observation; screen capture is not covered because a region does not grant it; the clause that turned the feature off is removed.
- A region has no download handling → the `download` protection is removed and the reason stated.
- Form detection was unspecified for subframes → injected into every frame in the region content world, trusted `input` events, flags per frame, cleared on navigation commit and submit; `beforeunload` is not adopted because the content world cannot see page listeners.
- `interactionState` had no owner after the region closes → the region returns it to the page before close and the page keeps it in memory with the tab.
- The pressure source starts only with the first region, has no level and no relay → it moves to an owner that starts with the host, reads the level, numbers reports, feeds the region consumer and the host event.
- `surface.unload` required contradicts `background` → required unless `background`, forbidden with it, listed with the reason `background`.
- Starting unloaded conflicts with `dormant()` and `disposeSurfacesExcept` → an unloaded tab is left out of `dormant()` and kept in the set, with a Red test.
- A pressure report without a candidate left no trace → the event `page.tab.unload.skipped`.
- Default on with partial protections → the default-on release follows F198.5.
- Storing tab state in `projects.json` changes its format → a separate store `tab-state.json` starts at format 1, keeps `projects.json` unchanged and keeps frequent writes out of the layout file.

Round 3 (one reviewer, by the criteria standard approach, nothing hidden, production stability, developer convenience, structural completeness). Each objection and its answer:

- A page script for media is unusual where the engine answers → the core asks `requestMediaPlaybackState` at each decision; camera and microphone stay on key-value observation; the media part of the script is removed.
- Form flags of removed frames and reloads were undefined → a per-frame map on the native side, cleared by `pagehide`, `submit`, main-frame commit and reload, with a Red test; the script stays for `form` only because WebKit has no public engine state for it.
- The stored unloaded flag duplicated rule 6, and two files could disagree → the flag is removed; coalescing is bounded and flushed at quit; the entry is removed after the layout write (its write-before part was removed in round 4); orphans are reconciled at load as events.
- `interactionState` could be empty after the process ended → restore at the stored address with `history: false`.
- `restored`, `page.tab.kept` and `core.tab.keep` were more than a first version needs → removed; least recently shown order prevents thrash; the keep mark is a follow-up item.
- A 5-minute default is far shorter than mainstream defaults → the default is 2 hours with a range of 5 minutes to 12 hours; pressure stays the fast path.

Round 4 (one reviewer). Each objection and its answer:

- The tab button state `kept` had no definition after round 3 → the button carries the status state `loaded`, `unloaded` or `restoring`; protections show only as reasons.
- Restart unloaded tabs even with the setting off → rule 6 applies only while `memorySaver` is on.
- The kept set of `disposeSurfacesExcept` does nothing for an unloaded tab, so the Red test would pass on unchanged code → rule 6 states that `dormant()` leaves the tab out and the store keeps its state; the Red test asserts no remount and no removed entry after a commit.
- "Never dropping the last value" contradicted "a crash loses at most one second" → the memory value is never dropped, the stored value follows within one second, and each store write is `page.tab.state.stored`.
- The write order for a new tab was impossible → a missing entry reads `null`; the order applies only to removal.
- Picture in picture was claimed as `playing` without evidence, and the query's failure was undefined → only `playing` protects; paused media in picture in picture is stated as not covered; the decision awaits the reply and a failed reply protects with `media-unknown` and is logged.
- `reasons` mixed protections with other reasons → one enumeration in rule 7 that rules 2 and 4, the status and the events use.
- The round 1 answer named the removed `restored` → marked as removed in round 3.
- A write after dispose threw into plugin teardown races → it is refused with a logged error once per context, and plugins stop work with `context.closing`.

Round 5 (one reviewer). Each objection and its answer:

- Step 3 still said writes after dispose throw → refused and logged once per context, with its Red test.
- Capture had no reason → the reason `capture`, changed by key-value observation.
- Playback in the status was undefined between decisions → `media` and `media-unknown` are the last decision's result with `checkedAt`.
- A tab protected by a query at its deadline had no retry → its next deadline is one delay later.
- A `form` flag can keep a tab loaded without bound → stated as the behavior, with navigation and `core.tab.unload` as the person's release; `core.tab.unload` does not wait for `recent`, `media`, `media-unknown`, `capture` or `form`.
- The round 3 answer still stated the removed write order → marked.

Comparison with two established platforms (an editor platform that destroys hidden web views and keeps state written by the view, and a desktop agent workbench that bounds hidden browser processes and keeps hidden terminal processes). Each difference and its answer:

- Both exempt a tab that the person pinned → the person's mark `kept` and `core.tab.keep` return to this item.
- One bounds hidden processes by count on show and hide events, the other closes least recently used editors over a count → not adopted in the first version: pressure answers the real limit; a count is measured after the first version.
- One saves dirty content one second after a change → matches the one-second store time.
- One silently drops state it cannot read → our rule refuses such a value with an error, which stays.
- One ignores `beforeunload` → matches rule 4.
- One keeps a hidden terminal's process and parsed model and restores the view from a numbered snapshot → the design for releasing a hidden terminal's image region follows that split when it is measured.
