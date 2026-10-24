// Correlates the generation-bearing host binding transcript with page view-call records.
export function acceptedCurrentViewReplies(events, transcriptLines, { plugin, surface }) {
  const prefix = "host viewReply ";
  const transcripts = [];
  for (const line of transcriptLines) {
    if (!line.startsWith(prefix)) continue;
    const separator = line.indexOf(" -> ", prefix.length);
    if (separator < 0) throw new Error(`viewReply transcript has no result separator: ${line}`);
    const payload = JSON.parse(line.slice(prefix.length, separator));
    if (payload?.surface !== surface) continue;
    if (!Number.isSafeInteger(payload.id) || !Number.isSafeInteger(payload.generation) || payload.generation < 1) {
      throw new Error(`viewReply transcript for ${surface} has no valid id and generation: ${line}`);
    }
    if ((Object.hasOwn(payload, "result") ? 1 : 0) + (Object.hasOwn(payload, "error") ? 1 : 0) !== 1) {
      throw new Error(`viewReply transcript for ${surface} must have exactly one result or error: ${line}`);
    }
    const answer = line.slice(separator + 4);
    if (answer !== "null") throw new Error(`host did not accept viewReply for ${surface}: ${line}`);
    transcripts.push({ payload, outcome: Object.hasOwn(payload, "error") ? "error" : "result" });
  }

  const sourceEvents = events.filter((event) => event.layer === "page" &&
    ["page.view.call", "page.view.reply", "page.view.call.cancel"].includes(event.event));
  const matches = [];
  for (const { payload, outcome } of transcripts) {
    const calls = sourceEvents.filter((event) => event.event === "page.view.call" &&
      event.fields.plugin === plugin && event.fields.surface === surface &&
      event.fields.id === payload.id && event.fields.generation === payload.generation);
    if (calls.length === 0) continue;
    if (calls.length !== 1) {
      throw new Error(`viewReply ${payload.id} generation ${payload.generation} has ${calls.length} page receipts`);
    }
    const call = calls[0];
    const replies = sourceEvents.filter((event) => event.event === "page.view.reply" && event.page === call.page &&
      event.fields.plugin === plugin && event.fields.surface === surface &&
      event.fields.id === payload.id && event.fields.generation === payload.generation &&
      event.fields.outcome === outcome && event.ts_us >= call.ts_us);
    if (replies.length === 0) continue;
    if (replies.length !== 1) {
      throw new Error(`viewReply ${payload.id} generation ${payload.generation} has ${replies.length} page replies`);
    }
    matches.push({ page: call.page, plugin, surface, generation: payload.generation, id: payload.id, outcome });
  }
  return matches;
}
