// Correlates native post acceptance with one page's source call and reply.
export function acceptedCurrentViewReplies(events, { window, page, plugin, surface }) {
  if (typeof window !== "string" || window.length === 0) throw new TypeError("viewReply evidence requires the current window identity");
  if (typeof page !== "string" || page.length === 0) throw new TypeError("viewReply evidence requires the current page identity");
  const sourceEvents = events.filter((event) => event.layer === "page" && event.page === page &&
    ["page.view.call", "page.view.reply"].includes(event.event));
  const dispatches = events.filter((event) => event.layer === "host" && event.event === "host.view.reply.dispatch");
  const matches = [];
  for (const event of dispatches) {
    const fields = event.fields;
    if (!fields || typeof fields.window !== "string" || fields.window.length === 0 ||
        typeof fields.page !== "string" || fields.page.length === 0 ||
        typeof fields.surface !== "string" || fields.surface.length === 0 ||
        !Number.isSafeInteger(fields.generation) || fields.generation < 1 ||
        !Number.isSafeInteger(fields.id) || fields.id < 0 ||
        !["result", "error"].includes(fields.outcome) ||
        !["posted", "discarded"].includes(fields.disposition)) {
      throw new Error("host.view.reply.dispatch has invalid fields");
    }
    if (fields.disposition === "discarded") {
      if (fields.reason !== "view-generation-not-current") {
        throw new Error(`viewReply ${fields.id} generation ${fields.generation} has an invalid discard reason`);
      }
    } else if (Object.hasOwn(fields, "reason")) {
      throw new Error(`viewReply ${fields.id} generation ${fields.generation} has a reason for a posted dispatch`);
    }
    if (fields.window !== window || fields.page !== page || fields.surface !== surface ||
        fields.disposition !== "posted") continue;
    const sameTarget = dispatches.filter((candidate) => candidate.fields?.window === fields.window &&
      candidate.fields?.page === fields.page && candidate.fields?.surface === fields.surface &&
      candidate.fields?.generation === fields.generation && candidate.fields?.id === fields.id);
    if (sameTarget.length !== 1) {
      throw new Error(`viewReply ${fields.id} generation ${fields.generation} has ${sameTarget.length} native dispatch records`);
    }
    const calls = sourceEvents.filter((source) => source.event === "page.view.call" &&
      source.fields.plugin === plugin && source.fields.surface === fields.surface &&
      source.fields.id === fields.id && source.fields.generation === fields.generation);
    if (calls.length === 0) continue;
    if (calls.length !== 1) {
      throw new Error(`viewReply ${fields.id} generation ${fields.generation} has ${calls.length} page receipts`);
    }
    const replies = sourceEvents.filter((source) => source.event === "page.view.reply" &&
      source.fields.plugin === plugin && source.fields.surface === fields.surface &&
      source.fields.id === fields.id && source.fields.generation === fields.generation &&
      source.fields.outcome === fields.outcome);
    if (replies.length === 0) continue;
    if (replies.length !== 1) {
      throw new Error(`viewReply ${fields.id} generation ${fields.generation} has ${replies.length} page replies`);
    }
    matches.push({ window, page, plugin, surface, generation: fields.generation, id: fields.id, outcome: fields.outcome });
  }
  return matches;
}

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const callIdentity = (fields) => `${fields.plugin}\u0000${fields.surface}\u0000${fields.id}`;
const sourceIdentity = (event) => `${event.page}\u0000${event.fields.plugin}\u0000${event.fields.surface}\u0000${event.fields.generation}\u0000${event.fields.id}`;

/** Selects sealed host calls that occurred after the replacement page start beyond its stated clock uncertainty. */
export function currentPageNativeViewCalls(events, { page }) {
  if (typeof page !== "string" || page.length === 0) throw new TypeError("view-call coverage requires the current page identity");
  const starts = events.filter((event) => event.layer === "page" && event.event === "page.start" && event.page === page);
  const timeOrigin = starts[0]?.fields?.time_origin;
  if (starts.length !== 1 || !integer(starts[0].mono_ns) || starts[0].mono_ns === 0 ||
      typeof timeOrigin !== "number" || !Number.isFinite(timeOrigin) || timeOrigin <= 0 || String(timeOrigin) !== page) {
    throw new Error(`the current page ${page} has no unique valid page.start record`);
  }
  const clocks = events.filter((event) => event.layer === "page" && event.event === "page.log.clock" && event.page === page);
  if (clocks.length !== 1 || !integer(clocks[0].fields?.trip_us) ||
      !integer(clocks[0].fields?.resolution_us) || clocks[0].fields.resolution_us === 0) {
    throw new Error(`the current page ${page} has no unique valid page.log.clock record`);
  }
  const clockBoundNs = Math.ceil(clocks[0].fields.trip_us * 500 + clocks[0].fields.resolution_us * 1000);
  if (!Number.isSafeInteger(clockBoundNs)) throw new Error(`the current page ${page} has an invalid page clock bound`);
  const boundary = starts[0].mono_ns;
  const calls = [];
  const identities = new Set();
  for (const event of events) {
    if (event.layer !== "host" || event.event !== "host.view.call") continue;
    const fields = event.fields;
    if (typeof fields?.plugin !== "string" || fields.plugin.length === 0 ||
        typeof fields.surface !== "string" || fields.surface.length === 0 ||
        !integer(fields.id) || typeof fields.command !== "string" || fields.command.length === 0 ||
        !integer(event.mono_ns) || event.mono_ns === 0) {
      throw new Error("host.view.call has invalid fields or no host monotonic timestamp");
    }
    const delta = event.mono_ns - boundary;
    if (delta > clockBoundNs) {
      const identity = callIdentity(fields);
      if (identities.has(identity)) {
        throw new Error(`host.view.call ${fields.plugin}/${fields.surface}/${fields.id} is duplicated in the sealed set`);
      }
      identities.add(identity);
      calls.push({ plugin: fields.plugin, surface: fields.surface, id: fields.id, mono_ns: event.mono_ns });
    } else if (delta >= -clockBoundNs) {
      throw new Error(`host.view.call ${fields.plugin}/${fields.surface}/${fields.id} falls within the page-start clock uncertainty`);
    }
  }
  return calls;
}

/** Returns undefined while sealed calls await page-log ingress; rejects ambiguous or invalid evidence. */
export function currentPageViewCallCoverage(events, { window, page, calls }) {
  if (typeof window !== "string" || window.length === 0) throw new TypeError("view-call coverage requires the current window identity");
  if (typeof page !== "string" || page.length === 0) throw new TypeError("view-call coverage requires the current page identity");
  if (!Array.isArray(calls)) throw new TypeError("view-call coverage requires a sealed native call set");
  const targetBySurfaceCall = new Map();
  const nativeIdentities = new Set();
  for (const nativeCall of calls) {
    if (typeof nativeCall?.plugin !== "string" || nativeCall.plugin.length === 0 ||
        typeof nativeCall.surface !== "string" || nativeCall.surface.length === 0 || !integer(nativeCall.id)) {
      throw new Error("sealed host.view.call has invalid plugin, surface or id fields");
    }
    const identity = callIdentity(nativeCall);
    if (nativeIdentities.has(identity)) throw new Error(`sealed host.view.call ${identity.replaceAll("\u0000", "/")} is duplicated`);
    nativeIdentities.add(identity);
    const surfaceCall = `${nativeCall.surface}\u0000${nativeCall.id}`;
    if (targetBySurfaceCall.has(surfaceCall)) {
      throw new Error(`sealed host.view.call ${surfaceCall.replaceAll("\u0000", "/")} has multiple plugin identities`);
    }
    targetBySurfaceCall.set(surfaceCall, { ...nativeCall, identity });
  }

  for (const event of events) {
    if (event.layer !== "host" || event.event !== "host.view.reply.dispatch") continue;
    const fields = event.fields;
    if (fields?.page !== page || typeof fields?.surface !== "string") continue;
    const surfaceCall = `${fields.surface}\u0000${fields.id}`;
    if (!targetBySurfaceCall.has(surfaceCall)) continue;
    if (typeof fields?.window !== "string" || fields.window.length === 0 ||
        typeof fields.page !== "string" || fields.page.length === 0 ||
        typeof fields.surface !== "string" || fields.surface.length === 0 ||
        !integer(fields.generation) || fields.generation === 0 || !integer(fields.id) ||
        !["result", "error"].includes(fields.outcome) || !["posted", "discarded"].includes(fields.disposition)) {
      throw new Error("host.view.reply.dispatch has invalid fields");
    }
    if (fields.disposition === "posted" && Object.hasOwn(fields, "reason")) {
      throw new Error(`host.view.reply.dispatch ${fields.id} has a reason for a posted dispatch`);
    }
    if (fields.disposition === "discarded" && fields.reason !== "view-generation-not-current") {
      throw new Error(`host.view.reply.dispatch ${fields.id} has an invalid discard reason`);
    }
  }
  const groups = new Map();
  const candidates = new Map();
  for (const event of events) {
    if (event.layer !== "page" || event.page !== page ||
        !["page.view.call", "page.view.reply", "page.view.call.cancel"].includes(event.event)) continue;
    const fields = event.fields;
    if (typeof fields?.surface !== "string") continue;
    const surfaceCall = `${fields.surface}\u0000${fields.id}`;
    const target = targetBySurfaceCall.get(surfaceCall);
    if (!target) continue;
    if (typeof fields.plugin !== "string" || fields.plugin !== target.plugin || !integer(fields.id) ||
        !integer(fields.generation) || fields.generation === 0) {
      throw new Error(`${event.event} for sealed ${target.plugin}/${target.surface}/${target.id} has an invalid source identity`);
    }
    const source = sourceIdentity(event);
    const group = groups.get(source) ?? { page: event.page, plugin: fields.plugin, surface: fields.surface,
      generation: fields.generation, id: fields.id, calls: [], replies: [], cancels: [] };
    if (event.event === "page.view.call") {
      if (typeof fields.command !== "string" || fields.command.length === 0) throw new Error("page.view.call has no command");
      group.calls.push(event);
    }
    if (event.event === "page.view.reply") {
      if (!["result", "error"].includes(fields.outcome)) throw new Error("page.view.reply has an invalid outcome");
      group.replies.push(event);
    }
    if (event.event === "page.view.call.cancel") {
      if (typeof fields.command !== "string" || fields.command.length === 0) throw new Error("page.view.call.cancel has no command");
      group.cancels.push(event);
    }
    groups.set(source, group);
    const identity = callIdentity(fields);
    if (!candidates.has(identity)) candidates.set(identity, new Set());
    candidates.get(identity).add(source);
  }

  const settled = [];
  for (const nativeCall of calls) {
    const identity = callIdentity(nativeCall);
    const matches = [...(candidates.get(identity) ?? [])];
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) {
      throw new Error(`host.view.call ${identity.replaceAll("\u0000", "/")} matches ${matches.length} page generations`);
    }
    const group = groups.get(matches[0]);
    if (group.page !== page) {
      throw new Error(`host.view.call ${identity.replaceAll("\u0000", "/")} matched page ${group.page}, not current page ${page}`);
    }
    if (group.calls.length > 1 || group.replies.length > 1 || group.cancels.length > 1 ||
        (group.replies.length > 0 && group.cancels.length > 0)) {
      throw new Error(`host.view.call ${identity.replaceAll("\u0000", "/")} has duplicate page receipts or terminal records`);
    }
    if (group.calls.length === 0 && group.cancels.length !== 1) {
      throw new Error(`host.view.call ${identity.replaceAll("\u0000", "/")} has no page receipt or valid cancellation`);
    }
    if (group.calls.length === 1 && group.replies.length === 0 && group.cancels.length === 0) return undefined;
    if (group.cancels.length === 1) {
      const dispatches = events.filter((event) => event.layer === "host" && event.event === "host.view.reply.dispatch" &&
        event.fields?.page === page && event.fields?.surface === group.surface &&
        event.fields?.generation === group.generation && event.fields?.id === group.id);
      if (dispatches.length !== 0) throw new Error(`canceled host.view.call ${identity.replaceAll("\u0000", "/")} also has a native reply dispatch`);
      settled.push({ plugin: group.plugin, surface: group.surface, generation: group.generation, id: group.id, outcome: "cancel" });
      continue;
    }
    if (group.calls.length !== 1 || group.replies.length !== 1) return undefined;
    const reply = group.replies[0];
    if (!(["result", "error"].includes(reply.fields?.outcome))) {
      throw new Error(`page.view.reply ${identity.replaceAll("\u0000", "/")} has an invalid outcome`);
    }
    const dispatches = events.filter((event) => event.layer === "host" && event.event === "host.view.reply.dispatch" &&
      event.fields?.page === page && event.fields?.surface === group.surface &&
      event.fields?.generation === group.generation && event.fields?.id === group.id);
    if (dispatches.length === 0) return undefined;
    if (dispatches.length !== 1) throw new Error(`page.view.reply ${identity.replaceAll("\u0000", "/")} has ${dispatches.length} native dispatch records`);
    const dispatch = dispatches[0].fields;
    if (dispatch.window !== window || dispatch.outcome !== reply.fields.outcome || dispatch.disposition !== "posted" ||
        Object.hasOwn(dispatch, "reason")) {
      throw new Error(`page.view.reply ${identity.replaceAll("\u0000", "/")} has no matching posted native dispatch`);
    }
    settled.push({ plugin: group.plugin, surface: group.surface, generation: group.generation, id: group.id,
      outcome: reply.fields.outcome });
  }
  return settled;
}
