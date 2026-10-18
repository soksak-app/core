// The memory saver of the main page (docs/spec/plugins.md#memory-saver): it unloads a hidden tab after the delay or under
// memory pressure and restores it when the tab is shown again. Only this module decides when a tab is unloaded.

import { emitEvent } from "./page-log.js";

const MINUTE = 60_000;
const LEVELS = new Set(["normal", "warn", "critical"]);
// The reasons that the region query of a decision gives; the other reasons change as their sources report.
const REGION_REASONS = new Set(["media", "media-unknown", "capture", "form"]);
// The order of the one enumeration of reasons (docs/spec/exposure.md#tab-memory).
const ORDER = ["shown", "recent", "keep:modified", "keep:busy", "media", "media-unknown", "capture", "form", "kept", "off",
  "undeclared", "background"];

/**
 * Creates the memory saver over its dependencies:
 *   now()               the monotonic time in milliseconds;
 *   enabled(), delay()  the settings memorySaver and memorySaverDelay (minutes);
 *   declaration(plugin) "unload" for a plugin that declares surface.unload, otherwise "undeclared" or "background";
 *   keeps(tab)          the keep reasons of the tab reports (keep:modified, keep:busy); kept(tab) the stored mark, which
 *                       setKept(tab, on) stores;
 *   regions(tab)        resolves the reasons of the document regions of the tab at a decision (media, media-unknown,
 *                       capture, form);
 *   interaction(tab)    stores the session history of the regions of the tab before it is unloaded;
 *   restore(tab)        gives the regions of a restored tab the stored session history;
 *   commit()            requests a commit and resolves after host.place replied;
 *   showLabel(tab)      shows the cached label of a tab that starts unloaded;
 *   changed()           announces that the status changed;
 *   failed(text)        shows a failed unload or restore through the error display of the page;
 *   stateChanged(tab, state) receives each change of the state of a tab (loaded, unloaded, restoring).
 */
export function createMemorySaver({
  now, enabled, delay, declaration, keeps, kept, setKept, regions, interaction, restore, commit, showLabel, changed, failed,
  stateChanged,
}) {
  // tab id -> {id, plugin, state, hiddenAt, shownAt, unloadAt, region, checkedAt, generation, attempting}
  let entries = new Map();
  let timer = null;
  let pressure = { level: "normal", seq: 0 };
  let pressing = false;

  const delayMs = () => delay() * MINUTE;
  const sorted = (reasons) => ORDER.filter((reason) => reasons.has(reason));

  /** The reasons that protect an entry; under pressure recent does not protect. */
  function reasonsOf(entry, { underPressure = false, region = true } = {}) {
    const reasons = new Set();
    const kind = declaration(entry.plugin);
    if (kind !== "unload") reasons.add(kind);
    if (!enabled()) reasons.add("off");
    if (entry.hiddenAt === null) reasons.add("shown");
    else if (!underPressure && entry.shownAt !== null && now() - entry.shownAt < delayMs()) reasons.add("recent");
    for (const reason of keeps(entry.id)) reasons.add(reason);
    if (kept(entry.id)) reasons.add("kept");
    if (region) for (const reason of entry.region) reasons.add(reason);
    return sorted(reasons);
  }

  /** The reasons that a decision does not read: an entry without them is a candidate. */
  const standing = (entry, underPressure) => reasonsOf(entry, { underPressure, region: false })
    .filter((reason) => reason !== "recent");

  // default: a tab without a deadline moved by the regions is due one delay after it was hidden.
  const deadline = (entry) => entry.unloadAt ?? entry.hiddenAt + delayMs();

  // The scheduler holds one timer for the earliest deadline, because elapsed time has no event source; it re-arms on a
  // show or a hide, a protection change and a setting change.
  function arm() {
    changed();
    clearTimeout(timer);
    timer = null;
    if (!enabled()) return;
    let earliest = Infinity;
    for (const entry of entries.values()) {
      if (entry.state !== "loaded" || entry.hiddenAt === null || entry.attempting || standing(entry, false).length) continue;
      earliest = Math.min(earliest, deadline(entry));
    }
    if (earliest === Infinity) return;
    timer = setTimeout(fire, Math.max(0, earliest - now()));
  }

  async function fire() {
    timer = null;
    const due = [...entries.values()].filter((entry) => entry.state === "loaded" && entry.hiddenAt !== null &&
      !entry.attempting && standing(entry, false).length === 0 && deadline(entry) <= now());
    for (const entry of due) await attempt(entry, "delay", false);
    arm();
  }

  function setState(entry, state) {
    entry.state = state;
    stateChanged(entry.id, state);
    changed();
  }

  function skipped(trigger, reasons) {
    emitEvent("info", "page.tab.unload.skipped", { trigger, seq: pressure.seq, reasons });
  }

  /**
   * One unload attempt with its generation: a show increments the generation, and after every awaited step the
   * protections are evaluated again before the tab is marked unloaded. Resolves the reasons that ended the attempt, empty
   * when the tab was unloaded, or the error of a failed read of the regions or commit. The command does not wait for recent and the reasons of the regions, because it is the
   * person's own decision (docs/spec/exposure.md#tab-memory).
   */
  async function attempt(entry, trigger, underPressure, command = false) {
    entry.attempting = true;
    const generation = entry.generation;
    const ended = () => {
      if (entries.get(entry.id) !== entry) return ["shown"];
      const reasons = standing(entry, underPressure);
      if (generation !== entry.generation && !reasons.includes("shown")) reasons.unshift("shown");
      return reasons;
    };
    try {
      try {
        entry.region = await regions(entry.id);
      } catch (error) {
        return unloadFailed(entry, trigger, error);
      }
      entry.checkedAt = now();
      let reasons = ended();
      if (reasons.length) {
        skipped(trigger, reasons);
        return reasons;
      }
      if (entry.region.length && !command) {
        // A tab that the regions protect at its deadline gets its next deadline one delay later.
        if (trigger === "delay") entry.unloadAt = now() + delayMs();
        return entry.region;
      }
      try {
        await interaction(entry.id);
      } catch (error) {
        return unloadFailed(entry, trigger, error);
      }
      reasons = ended();
      if (reasons.length) {
        skipped(trigger, reasons);
        return reasons;
      }
      setState(entry, "unloaded");
      entry.unloadAt = null;
      try {
        await commit();
      } catch (error) {
        // A commit that fails after the tab is marked returns the tab to loaded, and the next commit declares its surface.
        setState(entry, "loaded");
        commit().catch((again) => failed(`memory saver: tab ${entry.id}: commit failed: ${again.message}`));
        return unloadFailed(entry, trigger, error);
      }
      emitEvent("info", "page.tab.unloaded", { tab: entry.id, plugin: entry.plugin, trigger });
      return [];
    } finally {
      entry.attempting = false;
    }
  }

  /**
   * A rejected read of the regions or a failed commit ends the attempt with the tab loaded; returns the error as the result
   * of the attempt.
   */
  function unloadFailed(entry, trigger, error) {
    emitEvent("error", "page.tab.unload.failed", { tab: entry.id, plugin: entry.plugin, trigger, reason: error.message });
    failed(`memory saver: tab ${entry.id}: unload failed: ${error.message}`);
    return error;
  }

  /** The restoring entry of a tab whose surface reported the end of its restore. */
  function restoring(tab) {
    const entry = entries.get(tab);
    if (entry?.state !== "restoring") throw new Error(`tab ${tab} is not restoring`);
    return entry;
  }

  // While the level is warn or critical, unloads one candidate at a time, least recently shown first, after the
  // previous unload ends, until a normal report or until no candidate remains.
  async function relieve() {
    if (pressing) return;
    pressing = true;
    try {
      while (pressure.level !== "normal" && enabled()) {
        const { seq } = pressure;
        const candidates = [...entries.values()]
          .filter((entry) => entry.state === "loaded" && !entry.attempting && standing(entry, true).length === 0)
          // default: a tab that was never shown goes first.
          .sort((a, b) => (a.shownAt ?? -Infinity) - (b.shownAt ?? -Infinity));
        let unloaded = false;
        for (const entry of candidates) {
          if (pressure.level === "normal") return;
          const result = await attempt(entry, "pressure", true);
          if (Array.isArray(result) && result.length === 0) {
            unloaded = true;
            break;
          }
        }
        if (unloaded) continue;
        const reasons = new Set();
        for (const entry of entries.values()) {
          if (entry.state === "loaded") for (const reason of reasonsOf(entry, { underPressure: true })) reasons.add(reason);
        }
        emitEvent("info", "page.tab.unload.skipped", { trigger: "pressure", seq, reasons: sorted(reasons) });
        return;
      }
    } finally {
      pressing = false;
      arm();
    }
  }

  return {
    /**
     * Takes the tabs of every layout [{id, plugin}] of loaded plugins and the ids of the shown tabs at a commit. A tab seen
     * first while hidden takes this time as its hidden time; showing an unloaded tab restores it.
     */
    observe(shown, tabs) {
      const time = now();
      const next = new Map();
      for (const { id, plugin } of tabs) {
        let entry = entries.get(id);
        const isShown = shown.has(id);
        if (!entry) {
          entry = { id, plugin, state: "loaded", hiddenAt: isShown ? null : time, shownAt: isShown ? time : null,
            unloadAt: null, region: [], checkedAt: null, generation: 0, attempting: false };
        } else if (isShown && entry.hiddenAt !== null) {
          entry.hiddenAt = null;
          entry.shownAt = time;
          entry.unloadAt = null;
          entry.region = [];
          entry.generation++;
          if (entry.state === "unloaded") {
            setState(entry, "restoring");
            restore(id);
          }
        } else if (isShown) {
          entry.shownAt = time;
        } else if (entry.hiddenAt === null) {
          entry.hiddenAt = time;
        }
        next.set(id, entry);
      }
      entries = next;
      arm();
    },
    /**
     * Ends the start of the page: while the setting is on, a hidden tab of a declaring plugin that was never shown starts
     * unloaded and shows its cached label (docs/spec/plugins.md#memory-saver).
     */
    start() {
      if (!enabled()) return;
      let changed = false;
      for (const entry of entries.values()) {
        if (entry.state !== "loaded" || entry.hiddenAt === null || entry.shownAt !== null) continue;
        if (declaration(entry.plugin) !== "unload") continue;
        setState(entry, "unloaded");
        showLabel(entry.id);
        changed = true;
      }
      arm();
      if (changed) commit().catch((error) => dispatchEvent(new ErrorEvent("error", { message: `memory saver commit: ${error.message}` })));
    },
    /** Takes a memory pressure report {level, seq} of the host. */
    pressure(report) {
      if (!LEVELS.has(report?.level) || !Number.isInteger(report.seq)) {
        throw new TypeError(`memory pressure report ${JSON.stringify(report)} is not {level, seq}`);
      }
      pressure = { level: report.level, seq: report.seq };
      changed();
      if (pressure.level !== "normal") relieve();
    },
    /** Re-arms the scheduler after a setting changed. */
    settingsChanged() {
      arm();
      if (pressure.level !== "normal") relieve();
    },
    /** Re-arms the scheduler after a protection of a tab report or the mark changed. */
    protectionsChanged: () => arm(),
    /** Whether the memory saver knows the tab. */
    known: (tab) => entries.has(tab),
    /**
     * Unloads a hidden tab now (core.tab.unload). It does not wait for recent and the reasons of the regions; it refuses the
     * other reasons and the reasons that ended the attempt with `tab <id> is protected: <reasons>`.
     */
    async unload(tab) {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      if (entry.state === "unloaded") return;
      const refuse = (reasons) => new Error(`tab ${tab} is protected: ${reasons.join(", ")}`);
      const before = standing(entry, true);
      if (before.length) throw refuse(before);
      const reasons = await attempt(entry, "command", true, true);
      arm();
      if (reasons instanceof Error) throw reasons;
      if (reasons.length) throw refuse(reasons);
    },
    /**
     * Sets or clears the mark kept of a tab (core.tab.keep) with one page.tab.keep.changed per change; a tab that can never
     * be unloaded is refused.
     */
    keep(tab, on) {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      const kind = declaration(entry.plugin);
      if (kind !== "unload") throw new Error(`tab ${tab} can never be unloaded: ${kind}`);
      if (kept(tab) === on) return;
      setKept(tab, on);
      emitEvent("info", "page.tab.keep.changed", { tab, keep: on });
      arm();
    },
    /** The memory saver part of the status core.tab.memory: the last pressure report and each tab. */
    status: () => ({
      pressure: { ...pressure },
      tabs: [...entries.values()].map((entry) => ({
        tab: entry.id, plugin: entry.plugin, state: entry.state, reasons: reasonsOf(entry), hiddenAt: entry.hiddenAt,
        // default: a tab without a next deadline (shown, unloaded, or protected by a standing reason) has null.
        unloadAt: entry.state === "loaded" && entry.hiddenAt !== null && enabled() && standing(entry, false).length === 0
          ? deadline(entry) : null,
        checkedAt: entry.checkedAt,
      })),
    }),
    /** Ends the restore of a tab whose surface mounted; history is whether a region of it restored a session history. */
    restored(tab, history) {
      const entry = restoring(tab);
      setState(entry, "loaded");
      emitEvent("info", "page.tab.restored", { tab, plugin: entry.plugin, history });
    },
    /** Ends the restore of a tab whose surface or region refused it, and shows the failure (docs/spec/plugins.md#memory-saver). */
    restoreFailed(tab, reason) {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      if (entry.state === "restoring") setState(entry, "loaded");
      emitEvent("error", "page.tab.restore.failed", { tab, plugin: entry.plugin, reason });
      failed(`memory saver: tab ${tab}: restore failed: ${reason}`);
    },
    /**
     * Reports a document region that refused its restored session history. The region attaches again without it, so the
     * restore stays open and the end of the mount still emits page.tab.restored (docs/spec/plugins.md#memory-saver).
     */
    historyRefused(tab, reason) {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      emitEvent("error", "page.tab.restore.failed", { tab, plugin: entry.plugin, reason });
      failed(`memory saver: tab ${tab}: restore failed: ${reason}`);
    },
    /** The state of the tab: loaded, unloaded or restoring. */
    // default: a tab that no commit gave the memory saver yet has no state (null).
    state: (tab) => entries.get(tab)?.state ?? null,
    /** Whether the tab is unloaded. */
    unloaded: (tab) => entries.get(tab)?.state === "unloaded",
    /** The reasons that protect the tab now. */
    reasons(tab) {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      return reasonsOf(entry);
    },
    /**
     * Splits the surfaces of a commit: surfaces are those it declares to the host, retain the ids it keeps, which include
     * the unloaded tabs that stay in the layout, and unload the ids whose surfaces it releases in the unload mode.
     */
    place(surfaces) {
      const unload = [...entries.values()].filter((entry) => entry.state === "unloaded").map((entry) => entry.id);
      const left = new Set(unload);
      return {
        surfaces: surfaces.filter((surface) => !left.has(surface.id)),
        retain: new Set([...surfaces.map((surface) => surface.id), ...unload]),
        unload,
      };
    },
  };
}
