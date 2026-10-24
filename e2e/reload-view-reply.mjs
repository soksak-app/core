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
