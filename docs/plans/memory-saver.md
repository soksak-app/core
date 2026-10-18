# Memory saver

[한국어](memory-saver.ko.md)

Pending proposal for F198. It moves into `docs/spec/plugins.md` and `docs/spec/settings.md` once it is approved.

## Problem

A tab that is not shown is never released. `dormant()` in `packages/workbench/index.html` commits every tab that is not shown as an invisible surface: the other tabs of each card, and every tab of every space and project. `disposeSurfacesExcept` releases only tabs that no longer exist. A surface is released only when its tab closes (`closeTab` → `disposeSurface`). Each hidden tab therefore keeps its memory:

- A document tab (browser, hwp) keeps its WebContent process and its page.
- A DOM tab (editor, flowmark, shell) keeps its DOM and objects in the main page process.
- An image tab (terminal) keeps its image region; its sidecar session is separate.

F196.29 clears the back-forward cache of a hidden document region, but the shown page of that region and its process stay.

## Decision

The core unloads a hidden tab and mounts it again from its stored state when it is shown. One user setting turns this on or off. The core alone decides when; a plugin only declares that its tabs may be unloaded and keeps its state current.

### Rules

1. **The core decides.** Only the core decides when a tab is unloaded and mounted again. A plugin has no timer and no unload decision of its own.
2. **Opt-in per plugin.** Only a tab whose plugin declares `surface.unload: true` in `plugin.json` can be unloaded. A plugin without the declaration is never unloaded.
3. **State is written on each change.** A plugin that declares `surface.unload` writes the state it needs to restore, through `context.tab.state.write(value)`, whenever that state changes. The value is JSON. The core stores it with the tab in the layout, so it survives an unload, a crash and a restart. A remounted surface reads it through `context.tab.state.read()`. There is no hook at the moment of unloading: an unload under pressure or a crash gives no chance to save.
4. **Protections.** A tab is not unloaded while any of these holds; each one is a named reason:
   - `shown`: it is the shown tab of its card in the shown space.
   - `recent`: it was shown less than the delay ago.
   - `modified`: the surface reports unsaved changes (`context.tab.modified`).
   - `busy`: the surface reports work in progress (`context.tab.busy(true)`), such as a running job or a transfer.
   - `media`: a document region plays audio or video, shows picture in picture, or captures camera, microphone or screen. The core reads these from the web view itself.
   - `kept`: the person marked the tab to stay loaded (command `core.tab.keep`).
   - `off`: the setting is off.
5. **Two triggers.**
   - `delay`: a tab that stays hidden for the delay (default 5 minutes) and has no protection is unloaded.
   - `pressure`: when the host reports memory pressure (warn or critical), the core unloads hidden tabs without a protection one at a time, the least recently shown first, until the next report. `recent` does not protect a tab under pressure; every other protection does.
6. **Observable.** Each unload and each remount is an event, `page.tab.unloaded {tab, plugin, reason}` and `page.tab.restored {tab}`, and each tab that a trigger considered and kept is an event `page.tab.kept {tab, reason}` with the protection. The status `core.tab.memory` lists the unloaded tabs and the protection of each kept tab.

### Setting

- `core.tabs.memorySaver` (boolean, default on), label "메모리 절약": unloads hidden tabs to return their memory.
- `core.tabs.memorySaverDelay` (minutes, 1 to 60, default 5), label "숨긴 뒤 내리기까지".

One setting covers every plugin. A plugin does not add its own setting; it decides only whether its tabs can be unloaded and what state they need.

### What each plugin keeps

- browser: the address and the scroll position of the page. History beyond the current page is not kept; going back after a remount starts from the restored page.
- editor: the file path, the cursor and the scroll position. A blank document with unsaved text is `modified` and is never unloaded.
- flowmark, shell, hwp: each states its own state when it adopts the declaration.
- terminal: no declaration. Its sidecar session keeps running, and its hidden output is already handled by the background session (F192).

## Adopted and not adopted

- Adopted: unloading hidden tabs after a delay and under memory pressure; state written by the view on each change; protection for shown, recently shown, edited, busy, media and capture, and person-kept tabs; unloading one tab per pressure report, least recently shown first; the reason of each unload and each protection as an event.
- Not adopted: unloading on hide at once (the delay keeps quick switches cheap); a save hook at unload (no chance to run under pressure or a crash); unloading tabs that did not declare it (the core cannot restore a state it does not know); keeping full back history across a remount (it would keep the earlier documents this feature frees).

## Steps

1. F198.1 Specification: `surface.unload`, `context.tab.state`, `context.tab.busy`, the rules, the setting, the events and the status; terms; `validateManifest` checks `surface.unload`.
2. F198.2 Tab state: `context.tab.state` in `surface-modules.js`, stored with the tab in the layout.
3. F198.3 Unload and remount: `dormant()` leaves an unloaded tab out of the commit so `disposeSurfacesExcept` releases it; renderCard mounts it again when shown; the delay timer per tab; the protections.
4. F198.4 Media and capture: the document region reports its media, picture in picture and capture state to the host.
5. F198.5 Memory pressure: the hosts send the native memory pressure (`sp_observe_memory_pressure`) to the page as `memory-pressure`.
6. F198.6 Setting and the command `core.tab.keep`.
7. F198.7 Plugins: browser, editor, flowmark, shell and hwp adopt the declaration in their own repositories.
8. F198.8 Window check: a hidden browser tab is unloaded after a short delay, its document process ends, and it is restored at the same address when shown.

## Review

The adversarial review of this proposal and the answered objections are recorded here.
