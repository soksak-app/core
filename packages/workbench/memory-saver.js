// The memory saver of the main page (docs/spec/plugins.md#memory-saver): it unloads a hidden tab after the delay or under
// memory pressure and restores it when the tab is shown again. Only this module decides when a tab is unloaded.

import { emitEvent } from "./page-log.js";
import { keepsBackground } from "./registry.js";

const MINUTE = 60_000;
const LEVELS = new Set(["normal", "warn", "critical"]);
// The reasons that the region query of a decision gives; the other reasons change as their sources report.
const REGION_REASONS = new Set(["media", "media-unknown", "capture", "form"]);
// The order of the one enumeration of reasons (docs/spec/exposure.md#tab-memory).
const ORDER = ["shown", "recent", "keep:modified", "keep:busy", "media", "media-unknown", "capture", "form", "kept", "off",
  "undeclared", "background"];

/**
 * The declaration of a tab or section surface {plugin, kind, unload}: "background" for a tab of a plugin with background,
 * "unload" for a surface whose descriptor declares unload, otherwise "undeclared" (docs/spec/plugins.md#memory-saver).
 */
export function unloadDeclaration({ plugin, kind, unload }) {
  if (keepsBackground({ plugin, kind })) return "background";
  return unload ? "unload" : "undeclared";
}

/**
 * The decisions of the memory saver as a function of the inputs that each call receives. Every call takes the input of its
 * moment {at, enabled, delay, keeps, kept}: the monotonic time in milliseconds, the settings memorySaver and memorySaverDelay
 * (minutes), the keep reasons of each tab (keep:modified, keep:busy) and the set of tabs with the stored mark kept. A call
 * returns the actions that its decision requires, in order:
 *   {type: "changed"}                    the status changed;
 *   {type: "state", tab, state}          the state of a tab changed (loaded, unloaded, restoring);
 *   {type: "event", level, event, fields} an event of the page log;
 *   {type: "failed", text}               a failed unload or restore for the error display of the page;
 *   {type: "regions", attempt, tab}      read the reasons of the document regions of the tab; answer(attempt, {regions}) or
 *                                        answer(attempt, {error});
 *   {type: "interaction", attempt, tab}  store the session history of the regions of the tab; answer(attempt, {}) or {error};
 *   {type: "commit", attempt}            commit the unload of the attempt; answer(attempt, {}) or {error};
 *   {type: "commit", retry: tab}         commit again after the failed commit of the unload of tab;
 *   {type: "commit", classify: true}     commit the surfaces that the classification started unloaded;
 *   {type: "restore", tab}               give the regions of a restored tab the stored session history;
 *   {type: "showLabel", tab}             show the cached label of a tab that starts unloaded;
 *   {type: "setKept", tab, on}           store or clear the mark kept;
 *   {type: "settled", request, error}    the end of the unload command `request`, with its error or null.
 * `deadline()` is the earliest deadline of a hidden candidate, or null; the caller runs `fire` at that time, because elapsed
 * time has no event source.
 */
export function memorySaverCore({ declaration }) {
  // tab or section surface id -> {id, plugin, kind, unload, state, hiddenAt, shownAt, unloadAt, region, checkedAt, generation,
  // attempting, firstSeen}
  let entries = new Map();
  let pressure = { level: "normal", seq: 0 };
  // The attempts that wait for an answer, by id.
  const attempts = new Map();
  let nextAttempt = 1;
  // The entries that the deadline found due and that wait for their attempt, one at a time; null when no run of the deadline is in
  // progress.
  let firing = null;
  // The run of the pressure in progress: {seq, queue}; null when none.
  let relief = null;
  let next = null;
  // The input and the actions of the call in progress.
  let input = null;
  let actions = [];

  function call(given, run) {
    if (!given || !Number.isFinite(given.at) || typeof given.enabled !== "boolean" || !Number.isFinite(given.delay)
        || !(given.keeps instanceof Map) || !(given.kept instanceof Set)) {
      throw new TypeError("memory saver: an input is {at, enabled, delay, keeps, kept}");
    }
    input = { ...given, kept: new Set(given.kept) };
    actions = [];
    try {
      run();
      return actions;
    } finally {
      input = null;
    }
  }

  const emit = (action) => actions.push(action);
  const event = (level, name, fields) => emit({ type: "event", level, event: name, fields });
  const delayMs = () => input.delay * MINUTE;
  const sorted = (reasons) => ORDER.filter((reason) => reasons.has(reason));

  /** The reasons that protect an entry; under pressure recent does not protect. */
  function reasonsOf(entry, { underPressure = false, region = true } = {}) {
    const reasons = new Set();
    const kind = declaration(entry);
    if (kind !== "unload") reasons.add(kind);
    if (!input.enabled) reasons.add("off");
    if (entry.hiddenAt === null) reasons.add("shown");
    else if (!underPressure && entry.shownAt !== null && input.at - entry.shownAt < delayMs()) reasons.add("recent");
    // default: a tab that no view keeps has no keep reason.
    for (const reason of input.keeps.get(entry.id) ?? []) reasons.add(reason);
    if (input.kept.has(entry.id)) reasons.add("kept");
    if (region) for (const reason of entry.region) reasons.add(reason);
    return sorted(reasons);
  }

  /** The reasons that a decision does not read: an entry without them is a candidate. */
  const standing = (entry, underPressure) => reasonsOf(entry, { underPressure, region: false })
    .filter((reason) => reason !== "recent");

  // default: a tab without a deadline moved by the regions is due one delay after it was hidden.
  const deadline = (entry) => entry.unloadAt ?? entry.hiddenAt + delayMs();

  /** Computes the next deadline after a show or a hide, a protection change and a setting change. */
  function arm() {
    emit({ type: "changed" });
    next = null;
    if (!input.enabled) return;
    let earliest = Infinity;
    for (const entry of entries.values()) {
      if (entry.state !== "loaded" || entry.hiddenAt === null || entry.attempting || firing?.includes(entry)) continue;
      if (standing(entry, false).length) continue;
      earliest = Math.min(earliest, deadline(entry));
    }
    if (earliest !== Infinity) next = earliest;
  }

  function setState(entry, state) {
    entry.state = state;
    emit({ type: "state", tab: entry.id, state });
    emit({ type: "changed" });
  }

  function skipped(trigger, reasons) {
    event("info", "workbench.tab.unload.skipped", { trigger, seq: pressure.seq, reasons });
  }

  /**
   * Starts one unload attempt with its generation: a show increments the generation, and after every answered step the
   * protections are evaluated again before the tab is marked unloaded. The attempt ends with the reasons that ended it, empty
   * when the tab was unloaded, or the error of a failed read of the regions or commit. The command does not wait for recent and
   * the reasons of the regions, because it is the person's own decision (docs/spec/exposure.md#tab-memory).
   */
  function attempt(entry, trigger, underPressure, command = false, request = null) {
    entry.attempting = true;
    const id = nextAttempt++;
    attempts.set(id, { id, entry, trigger, underPressure, command, request, generation: entry.generation, step: "regions" });
    emit({ type: "regions", attempt: id, tab: entry.id });
  }

  function ended(run) {
    const { entry } = run;
    if (entries.get(entry.id) !== entry) return ["shown"];
    const reasons = standing(entry, run.underPressure);
    if (run.generation !== entry.generation && !reasons.includes("shown")) reasons.unshift("shown");
    return reasons;
  }

  /** Takes the answer of the step of an attempt. */
  function step(run, answer) {
    const { entry, trigger } = run;
    if (run.step === "regions") {
      if (answer.error) return finish(run, unloadFailed(entry, trigger, answer.error));
      entry.region = answer.regions;
      entry.checkedAt = input.at;
      const reasons = ended(run);
      if (reasons.length) {
        skipped(trigger, reasons);
        return finish(run, reasons);
      }
      if (entry.region.length && !run.command) {
        // A tab that the regions protect at its deadline gets its next deadline one delay later.
        if (trigger === "delay") entry.unloadAt = input.at + delayMs();
        return finish(run, entry.region);
      }
      run.step = "interaction";
      return emit({ type: "interaction", attempt: run.id, tab: entry.id });
    }
    if (run.step === "interaction") {
      if (answer.error) return finish(run, unloadFailed(entry, trigger, answer.error));
      const reasons = ended(run);
      if (reasons.length) {
        skipped(trigger, reasons);
        return finish(run, reasons);
      }
      setState(entry, "unloaded");
      entry.unloadAt = null;
      run.step = "commit";
      return emit({ type: "commit", attempt: run.id });
    }
    if (answer.error) {
      // A commit that fails after the tab is marked returns the tab to loaded, and the next commit declares its surface.
      setState(entry, "loaded");
      emit({ type: "commit", retry: entry.id });
      return finish(run, unloadFailed(entry, trigger, answer.error));
    }
    event("info", "workbench.tab.unloaded", { tab: entry.id, plugin: entry.plugin, trigger });
    return finish(run, []);
  }

  /** Ends an attempt with its result and continues the run of its trigger. */
  function finish(run, result) {
    run.entry.attempting = false;
    attempts.delete(run.id);
    if (run.trigger === "delay") return fireNext();
    if (run.trigger === "pressure") {
      if (Array.isArray(result) && result.length === 0) return relieve();
      return relieveNext();
    }
    arm();
    const refuse = (reasons) => new Error(`tab ${run.entry.id} is protected: ${reasons.join(", ")}`);
    emit({ type: "settled", request: run.request, error: result instanceof Error ? result : result.length ? refuse(result) : null });
  }

  /**
   * A rejected read of the regions or a failed commit ends the attempt with the tab loaded; returns the error as the result
   * of the attempt.
   */
  function unloadFailed(entry, trigger, error) {
    // A read that keeps failing runs once per delay, not again at the deadline that passed.
    if (trigger === "delay") entry.unloadAt = input.at + delayMs();
    event("error", "workbench.tab.unload.failed", { tab: entry.id, plugin: entry.plugin, trigger, reason: error.message });
    emit({ type: "failed", text: `memory saver: tab ${entry.id}: unload failed: ${error.message}` });
    return error;
  }

  /** Starts the attempt of the next due entry of the deadline run, and ends the run when none is left. */
  function fireNext() {
    const entry = firing.shift();
    if (entry) return attempt(entry, "delay", false);
    firing = null;
    arm();
  }

  /** The restoring entry of a tab whose surface reported the end of its restore. */
  function restoring(tab) {
    const entry = entries.get(tab);
    if (entry?.state !== "restoring") throw new Error(`tab ${tab} is not restoring`);
    return entry;
  }

  // While the level is warn or critical, unloads one candidate at a time, least recently shown first, after the
  // previous unload ends, until a normal report or until no candidate remains.
  function relieve() {
    if (pressure.level === "normal" || !input.enabled) return endRelief();
    relief = {
      seq: pressure.seq,
      queue: [...entries.values()]
        .filter((entry) => entry.state === "loaded" && !entry.attempting && standing(entry, true).length === 0)
        // default: a tab that was never shown goes first.
        .sort((a, b) => (a.shownAt ?? -Infinity) - (b.shownAt ?? -Infinity)),
    };
    relieveNext();
  }

  function relieveNext() {
    if (pressure.level === "normal") return endRelief();
    const entry = relief.queue.shift();
    if (entry) return attempt(entry, "pressure", true);
    const reasons = new Set();
    for (const candidate of entries.values()) {
      if (candidate.state === "loaded") for (const reason of reasonsOf(candidate, { underPressure: true })) reasons.add(reason);
    }
    event("info", "workbench.tab.unload.skipped", { trigger: "pressure", seq: relief.seq, reasons: sorted(reasons) });
    endRelief();
  }

  function endRelief() {
    relief = null;
    arm();
  }

  function startRelief() {
    if (relief) return;
    relief = { seq: pressure.seq, queue: [] };
    relieve();
  }

  return {
    /**
     * Takes the tabs of every layout and the section surfaces [{id, plugin, kind, unload}] of loaded plugins and the ids of the
     * shown ones at a commit. A tab seen first while hidden takes this time as its hidden time; showing an unloaded tab restores
     * it.
     */
    observe: (shown, tabs, given) => call(given, () => {
      const time = input.at;
      const nextEntries = new Map();
      for (const { id, plugin, kind, unload } of tabs) {
        if (kind !== "tab" && kind !== "section") throw new TypeError(`memory saver: surface ${id} has kind ${kind}`);
        let entry = entries.get(id);
        const isShown = shown.has(id);
        if (!entry) {
          entry = { id, plugin, kind, unload, state: "loaded", hiddenAt: isShown ? null : time, shownAt: isShown ? time : null,
            unloadAt: null, region: [], checkedAt: null, generation: 0, attempting: false, firstSeen: true };
        } else if (isShown && entry.hiddenAt !== null) {
          entry.hiddenAt = null;
          entry.shownAt = time;
          entry.unloadAt = null;
          entry.region = [];
          entry.generation++;
          if (entry.state === "unloaded") {
            setState(entry, "restoring");
            emit({ type: "restore", tab: id });
          }
        } else if (isShown) {
          entry.shownAt = time;
        } else if (entry.hiddenAt === null) {
          entry.hiddenAt = time;
        }
        nextEntries.set(id, entry);
      }
      entries = nextEntries;
      arm();
    }),
    /**
     * Classifies the surfaces first seen since the last call, at a drawn commit: while the setting is on, a hidden surface that
     * declares unload and was never shown starts unloaded and shows its cached label, so it never mounts only to unload. A surface
     * first seen while the setting is off stays and waits for the delay (docs/spec/plugins.md#memory-saver).
     */
    classify: (given) => call(given, () => {
      const seen = [...entries.values()].filter((entry) => entry.firstSeen);
      for (const entry of seen) entry.firstSeen = false;
      if (!input.enabled) return;
      let started = false;
      for (const entry of seen) {
        if (entry.state !== "loaded" || entry.hiddenAt === null || entry.shownAt !== null) continue;
        if (declaration(entry) !== "unload") continue;
        setState(entry, "unloaded");
        emit({ type: "showLabel", tab: entry.id });
        started = true;
      }
      arm();
      if (started) emit({ type: "commit", classify: true });
    }),
    /** Takes a memory pressure report {level, seq} of the host. */
    pressure: (report, given) => call(given, () => {
      if (!LEVELS.has(report?.level) || !Number.isInteger(report.seq)) {
        throw new TypeError(`memory pressure report ${JSON.stringify(report)} is not {level, seq}`);
      }
      pressure = { level: report.level, seq: report.seq };
      emit({ type: "changed" });
      if (pressure.level !== "normal") startRelief();
    }),
    /** Computes the next deadline again after a setting changed. */
    settingsChanged: (given) => call(given, () => {
      arm();
      if (pressure.level !== "normal") startRelief();
    }),
    /** Computes the next deadline again after a protection of a tab report or the mark changed. */
    protectionsChanged: (given) => call(given, arm),
    /** Runs the attempts of the hidden candidates whose deadline is not later than the time of the input. */
    fire: (given) => call(given, () => {
      const due = [...entries.values()].filter((entry) => entry.state === "loaded" && entry.hiddenAt !== null &&
        !entry.attempting && !firing?.includes(entry) && standing(entry, false).length === 0 && deadline(entry) <= input.at);
      if (firing) {
        firing.push(...due);
        return arm();
      }
      firing = due;
      fireNext();
    }),
    /** Takes the answer {regions} or {} or {error} of the waiting step of an attempt. */
    answer: (id, answer, given) => call(given, () => {
      const run = attempts.get(id);
      if (!run) throw new Error(`memory saver: attempt ${id} waits for no answer`);
      step(run, answer);
    }),
    /** The earliest deadline of a hidden candidate at the last call, or null. */
    deadline: () => next,
    /** Whether a run of a deadline or of the pressure is in progress. */
    busy: () => firing !== null || relief !== null,
    /** The ids of the known tabs and section surfaces. */
    ids: () => [...entries.keys()],
    /** Whether the memory saver knows the tab. */
    known: (tab) => entries.has(tab),
    /**
     * Returns the id of a known tab for core.tab.unload, core.tab.keep and core.tab.menu. A section surface id is refused, so
     * only the memory saver unloads a section (docs/spec/plugins.md#memory-saver).
     */
    tab(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown tab ${JSON.stringify(id)}`);
      if (entry.kind === "section") throw new Error(`${id} is a section surface, not a tab`);
      return id;
    },
    /**
     * Starts the unload of a hidden tab now (core.tab.unload) as `request`; the action settled ends it. It does not wait for
     * recent and the reasons of the regions; it refuses the other reasons and the reasons that ended the attempt with
     * `tab <id> is protected: <reasons>`.
     */
    unload: (tab, request, given) => call(given, () => {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      if (entry.state === "unloaded") return emit({ type: "settled", request, error: null });
      const before = standing(entry, true);
      if (before.length) throw new Error(`tab ${tab} is protected: ${before.join(", ")}`);
      attempt(entry, "command", true, true, request);
    }),
    /**
     * Sets or clears the mark kept of a tab (core.tab.keep) with one workbench.tab.keep.changed per change; a tab that can never
     * be unloaded is refused.
     */
    keep: (tab, on, given) => call(given, () => {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      const kind = declaration(entry);
      if (kind !== "unload") throw new Error(`tab ${tab} can never be unloaded: ${kind}`);
      if (input.kept.has(tab) === on) return;
      if (on) input.kept.add(tab);
      else input.kept.delete(tab);
      emit({ type: "setKept", tab, on });
      event("info", "workbench.tab.keep.changed", { tab, keep: on });
      arm();
    }),
    /** The memory saver part of the status core.tab.memory: the last pressure report and each tab. */
    status: (given) => {
      let status;
      call(given, () => {
        status = {
          pressure: { ...pressure },
          tabs: [...entries.values()].map((entry) => ({
            tab: entry.id, plugin: entry.plugin, kind: entry.kind, state: entry.state, reasons: reasonsOf(entry),
            hiddenAt: entry.hiddenAt,
            // default: a tab without a next deadline (shown, unloaded, or protected by a standing reason) has null.
            unloadAt: entry.state === "loaded" && entry.hiddenAt !== null && input.enabled && standing(entry, false).length === 0
              ? deadline(entry) : null,
            checkedAt: entry.checkedAt,
          })),
        };
      });
      return status;
    },
    /** Ends the restore of a tab whose surface mounted; history is whether a region of it restored a session history. */
    restored: (tab, history, given) => call(given, () => {
      const entry = restoring(tab);
      setState(entry, "loaded");
      event("info", "workbench.tab.restored", { tab, plugin: entry.plugin, history });
    }),
    /** Ends the restore of a tab whose surface or region refused it, and shows the failure (docs/spec/plugins.md#memory-saver). */
    restoreFailed: (tab, reason, given) => call(given, () => {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      if (entry.state === "restoring") setState(entry, "loaded");
      event("error", "workbench.tab.restore.failed", { tab, plugin: entry.plugin, reason });
      emit({ type: "failed", text: `memory saver: tab ${tab}: restore failed: ${reason}` });
    }),
    /**
     * Reports a document region of a tab of plugin that refused its restored session history. The region attaches again
     * without it, so a restore stays open and the end of the mount still emits workbench.tab.restored
     * (docs/spec/plugins.md#memory-saver). The first show of a tab after a restart restores a session history before any
     * commit gives the tab to the memory saver, so the tab need not be known.
     */
    historyRefused: (tab, plugin, reason, given) => call(given, () => {
      event("error", "workbench.tab.restore.failed", { tab, plugin, reason });
      emit({ type: "failed", text: `memory saver: tab ${tab}: restore failed: ${reason}` });
    }),
    /** The state of the tab: loaded, unloaded or restoring. */
    // default: a tab that no commit gave the memory saver yet has no state (null).
    state: (tab) => entries.get(tab)?.state ?? null,
    /** Whether the tab is unloaded. */
    unloaded: (tab) => entries.get(tab)?.state === "unloaded",
    /** The reasons that protect the tab now. */
    reasons(tab, given) {
      const entry = entries.get(tab);
      if (!entry) throw new Error(`unknown tab ${tab}`);
      let reasons;
      call(given, () => { reasons = reasonsOf(entry); });
      return reasons;
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

/**
 * Creates the memory saver of the page over the decisions of memorySaverCore and its dependencies. It reads the time with
 * performance.now() and the inputs of each decision from its dependencies at the moment of the decision, holds the one timer of
 * the next deadline and runs the actions of the decisions:
 *   enabled(), delay()  the settings memorySaver and memorySaverDelay (minutes);
 *   declaration(entry) "unload" for a tab or section surface {id, plugin, kind, unload} whose descriptor declares unload,
 *                       otherwise "undeclared" or "background";
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
  enabled, delay, declaration, keeps, kept, setKept, regions, interaction, restore, commit, showLabel, changed, failed,
  stateChanged,
}) {
  const core = memorySaverCore({ declaration });
  let timer = null;
  let idleWaits = [];
  let nextRequest = 1;
  const requests = new Map();

  /** The input of a decision now, for the known tabs and the tabs of ids. */
  function input(ids = []) {
    const tabs = [...new Set([...core.ids(), ...ids])];
    return {
      at: performance.now(), enabled: enabled(), delay: delay(), keeps: new Map(tabs.map((tab) => [tab, keeps(tab)])),
      kept: new Set(tabs.filter((tab) => kept(tab))),
    };
  }

  /** Runs the answer of a step of an attempt when its promise settles. */
  function answered(attempt, work) {
    Promise.resolve().then(work).then(
      (answer) => run(core.answer(attempt, answer, input())),
      (error) => run(core.answer(attempt, { error }, input())));
  }

  function perform(action) {
    switch (action.type) {
      case "changed": return changed();
      case "state": return stateChanged(action.tab, action.state);
      // events: workbench.tab.keep.changed, workbench.tab.restore.failed, workbench.tab.restored, workbench.tab.unload.failed, workbench.tab.unload.skipped, workbench.tab.unloaded
      case "event": return emitEvent(action.level, action.event, action.fields);
      case "failed": return failed(action.text);
      case "restore": return restore(action.tab);
      case "showLabel": return showLabel(action.tab);
      case "setKept": return setKept(action.tab, action.on);
      case "regions": return answered(action.attempt, async () => ({ regions: await regions(action.tab) }));
      case "interaction": return answered(action.attempt, async () => { await interaction(action.tab); return {}; });
      case "commit":
        if (action.attempt) return answered(action.attempt, async () => { await commit(); return {}; });
        if (action.retry) return commit().catch((again) => failed(`memory saver: tab ${action.retry}: commit failed: ${again.message}`));
        return commit().catch((error) => dispatchEvent(new ErrorEvent("error", { message: `memory saver commit: ${error.message}` })));
      case "settled": {
        const { resolve, reject } = requests.get(action.request);
        requests.delete(action.request);
        return action.error ? reject(action.error) : resolve();
      }
      default: throw new Error(`memory saver: unknown action ${action.type}`);
    }
  }

  // The timer of the next deadline: elapsed time has no event source, so the page holds one timer for the earliest deadline and
  // takes it again after each decision.
  function run(actions) {
    for (const action of actions) perform(action);
    clearTimeout(timer);
    timer = null;
    const next = core.deadline();
    if (next !== null) timer = setTimeout(() => { timer = null; run(core.fire(input())); }, Math.max(0, next - performance.now()));
    if (!core.busy()) {
      const waits = idleWaits;
      idleWaits = [];
      for (const resolve of waits) resolve();
    }
  }

  return {
    observe: (shown, tabs) => run(core.observe(shown, tabs, input(tabs.map(({ id }) => id)))),
    classify: () => run(core.classify(input())),
    pressure: (report) => run(core.pressure(report, input())),
    settingsChanged: () => run(core.settingsChanged(input())),
    /**
     * Resolves when no unload run of a deadline or of the pressure is in progress, at once when none is; a run that waits for
     * a step of its dependencies resolves it only after that step.
     */
    idle: () => (core.busy() ? new Promise((resolve) => idleWaits.push(resolve)) : Promise.resolve()),
    protectionsChanged: () => run(core.protectionsChanged(input())),
    known: (tab) => core.known(tab),
    tab: (id) => core.tab(id),
    async unload(tab) {
      const request = nextRequest++;
      const settled = new Promise((resolve, reject) => requests.set(request, { resolve, reject }));
      try {
        run(core.unload(tab, request, input()));
      } catch (error) {
        requests.delete(request);
        throw error;
      }
      return settled;
    },
    keep: (tab, on) => run(core.keep(tab, on, input())),
    status: () => core.status(input()),
    restored: (tab, history) => run(core.restored(tab, history, input())),
    restoreFailed: (tab, reason) => run(core.restoreFailed(tab, reason, input())),
    historyRefused: (tab, plugin, reason) => run(core.historyRefused(tab, plugin, reason, input())),
    state: (tab) => core.state(tab),
    unloaded: (tab) => core.unloaded(tab),
    reasons: (tab) => core.reasons(tab, input()),
    place: (surfaces) => core.place(surfaces),
  };
}
