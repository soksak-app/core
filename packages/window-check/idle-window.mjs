// The judgement of an idle window (docs/spec/debug.md#files): over a span of display refreshes that the display of the window
// delivered, the application records no work, so the window runs no frame step and receives no notice. The refreshes come from the
// display-link trace of a recording (display-link.json) and the work from the host event logs; both clocks are the Mach clock, and
// alignClocks shows that by measurement before a refresh and a record are compared.

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** The nanoseconds of a raw Mach time in decimal with the Mach timebase of its observation. */
function machNanoseconds(raw, numerator, denominator, name) {
  if (typeof raw !== "string" || !DECIMAL.test(raw)) throw new Error(`${name} is ${JSON.stringify(raw)}, not a raw Mach time in decimal`);
  if (!Number.isSafeInteger(numerator) || numerator <= 0 || !Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new Error(`${name} has the Mach timebase ${numerator}/${denominator}`);
  }
  return BigInt(raw) * BigInt(numerator) / BigInt(denominator);
}

/** The nanoseconds of a mono_ns value in decimal, as diagnostics.clock answers it. */
export function clockNanoseconds(value, name = "mono_ns") {
  if (typeof value !== "string" || !DECIMAL.test(value) || value === "0") {
    throw new Error(`${name} is ${JSON.stringify(value)}, not positive nanoseconds in decimal`);
  }
  return BigInt(value);
}

/**
 * The refreshes of a display-link trace on the host event clock, with the measurement that puts them there. Each observation holds
 * its callback time on the raw Mach clock (callbackTime) and on the Core Animation media clock (callbackMediaTime), and the timestamp
 * of its refresh on the media clock. The host event clock (mono_ns, diagnostics.clock) is CLOCK_UPTIME_RAW, the Mach clock in
 * nanoseconds, so the alignment requires that every callback lies between the clock reads `before` and `after` that bracket the
 * recording, and that the media clock and the Mach clock of each callback differ by less than one display period. A refresh is then
 * at its media timestamp on the host event clock. Returns `{refreshes: [{ns, periodNs}], skewNs}`, skewNs the largest difference of
 * the two clocks of a callback.
 */
export function alignClocks(link, { before, after }) {
  if (link?.state !== "available") throw new Error(`the display link is ${link?.state}: ${link?.reason}`);
  if (link.omittedObservations !== 0) throw new Error(`the display link omitted ${link.omittedObservations} observations`);
  if (!Array.isArray(link.observations) || link.observations.length === 0) throw new Error("the display link holds no observation");
  if (before >= after) throw new Error(`the clock read before the recording (${before} ns) is not before the read after it (${after} ns)`);
  let skewNs = 0n;
  const refreshes = link.observations.map((observation, index) => {
    const label = `display-link observation ${index + 1}`;
    const callback = machNanoseconds(observation.callbackTime, observation.machTimebaseNumerator, observation.machTimebaseDenominator,
      `${label} callbackTime`);
    if (callback < before || callback > after) {
      throw new Error(`${label} has its callback at ${callback} ns, outside the clock reads ${before} to ${after} ns of the recording`);
    }
    for (const name of ["timestamp", "duration", "callbackMediaTime"]) {
      if (!Number.isFinite(observation[name]) || observation[name] <= 0) throw new Error(`${label} has ${name} ${observation[name]}`);
    }
    const periodNs = BigInt(Math.round(observation.duration * 1e9));
    const media = BigInt(Math.round(observation.callbackMediaTime * 1e9));
    const skew = media > callback ? media - callback : callback - media;
    if (skew >= periodNs) {
      throw new Error(`${label} has its callback at ${media} ns on the media clock and ${callback} ns on the Mach clock, ` +
        `${skew} ns apart, not within its display period of ${periodNs} ns`);
    }
    if (skew > skewNs) skewNs = skew;
    return { ns: BigInt(Math.round(observation.timestamp * 1e9)), periodNs };
  });
  return { refreshes, skewNs };
}

/**
 * The judgement of an idle span from `from` to `to` (nanoseconds on the host event clock): the refreshes that the display delivered
 * in the span and the records written in it, other than the records that an exclusion names. events are the events of the event logs
 * (readEvents of event-log.mjs), each with its mono_ns; exclusions are `{name, matches(event)}`, each a record that the check itself
 * causes. Returns `{refreshes, work, excluded}`: the number of refreshes, the records of work counted by `<layer> <event>` (with the
 * callback of a step), and the records that each exclusion took. An event without a canonical mono_ns is an error that names it.
 */
export function idleSpan({ refreshes, events, from, to, exclusions = [] }) {
  if (from >= to) throw new Error(`the idle span from ${from} ns to ${to} ns is empty`);
  const delivered = refreshes.filter(({ ns }) => ns > from && ns <= to).length;
  const work = {};
  const excluded = Object.fromEntries(exclusions.map(({ name }) => [name, 0]));
  for (const event of events) {
    if (!Number.isSafeInteger(event.mono_ns) || event.mono_ns <= 0) {
      throw new Error(`the ${event.event} record at seq ${event.seq} has mono_ns ${JSON.stringify(event.mono_ns)}`);
    }
    const at = BigInt(event.mono_ns);
    if (at <= from || at > to) continue;
    const exclusion = exclusions.find(({ matches }) => matches(event));
    if (exclusion !== undefined) {
      excluded[exclusion.name] += 1;
      continue;
    }
    const callback = event.event === "host.frame.step" ? ` ${event.fields?.callback}` : "";
    const key = `${event.layer} ${event.event}${callback}`;
    work[key] = (work[key] ?? 0) + 1;
  }
  return { refreshes: delivered, work, excluded };
}
