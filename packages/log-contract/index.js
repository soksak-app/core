// The checker of the event contract (docs/spec/logging.md): it reads a log file of events and audits it against a catalog.
// A file that cannot be read as events is rejected with an error that names the file and the value found; an event that
// breaks the contract is a finding with its line.
import Ajv2020 from "ajv/dist/2020.js";

/** The schema number that this checker reads. */
export const SCHEMA = 2;
export const CATALOG_SCHEMA = 3;

const fieldSchemaAjv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const catalogFieldValidators = new WeakMap();

const LEVELS = new Set(["error", "warn", "info", "debug", "trace"]);
const LAYERS = new Set(["native", "host", "page", "plugin", "sidecar", "sok"]);
const CLASSES = new Set(["lifecycle", "input", "call", "io", "frame"]);

/** The levels that the file of each channel holds (docs/spec/logging.md#files). `log.open` and `log.rotated` start every file at the level info. */
const CHANNEL_LEVELS = { other: new Set(["error", "warn", "info"]), debug: new Set(["debug", "trace"]) };
const IN_EVERY_FILE = new Set(["log.open", "log.rotated"]);

/** The channel of an event file: `debug` for `<role>-<boot>.debug.jsonl` and its generations, `other` for every other file. */
export function channelOf(file) {
  return /\.debug\.jsonl(?:\.\d+)?$/.test(file.split("/").pop()) ? "debug" : "other";
}

/**
 * Reads the text of a log file into `{line, event, bytes}` entries, where `bytes` is the size of the line with its line feed. The first line must be `log.open` with the schema number
 * of this checker. A line that is not a JSON object is an error.
 */
const encoder = new TextEncoder();

/** The layers whose events are written by a document and name it in `page`. */
const PAGE_LAYERS = new Set(["page", "plugin"]);

export function parseLog(file, text) {
  const entries = [];
  const lines = text.split("\n").filter((line, index, all) => line !== "" || index < all.length - 1);
  lines.forEach((raw, index) => {
    const number = index + 1;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new Error(`${file}:${number}: not JSON: ${raw}`);
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new Error(`${file}:${number}: not an event object: ${raw}`);
    }
    entries.push({ line: number, event, bytes: encoder.encode(raw).length + 1 });
  });
  const first = entries[0]?.event;
  if (first?.event !== "log.open") {
    throw new Error(`${file}: the first line is not log.open: ${entries.length === 0 ? "the file is empty" : JSON.stringify(first.event)}`);
  }
  if (first.fields?.schema !== SCHEMA) {
    throw new Error(`${file}: schema ${first.fields?.schema} is not ${SCHEMA}`);
  }
  return entries;
}

/**
 * The declaration of an event name. A catalog name with a placeholder such as `page.record.<level>` declares every event of
 * its family: a placeholder stands for one or more characters of `a-z`, `0-9`, `_` and `.`.
 */
export function declaration(catalog, name) {
  if (catalog.events[name] !== undefined) return catalog.events[name];
  for (const [declared, value] of Object.entries(catalog.events)) {
    if (!declared.includes("<")) continue;
    const pattern = declared.split(/<[a-z_]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9_.]+");
    if (new RegExp(`^${pattern}$`).test(name)) return value;
  }
  return undefined;
}

/** Compiles one current-format catalog and refuses another catalog grammar. */
export function validateCatalog(catalog, source = "event catalog") {
  if (catalog?.schema !== CATALOG_SCHEMA) {
    const found = catalog?.schema === undefined ? "is missing" : `is ${JSON.stringify(catalog.schema)}`;
    throw new Error(`${source}: event catalog schema ${found}; expected ${CATALOG_SCHEMA}`);
  }
  if (catalog.events === null || typeof catalog.events !== "object" || Array.isArray(catalog.events)) {
    throw new Error(`${source}: event catalog events must be an object`);
  }
  const cached = catalogFieldValidators.get(catalog);
  if (cached !== undefined) return cached;
  const validators = new Map();
  for (const [name, event] of Object.entries(catalog.events)) {
    const schema = event?.fields;
    const branches = schema?.oneOf ?? [schema]; // default: a JSON Schema without oneOf declares this schema as its sole branch.
    const objectShape = (branch) => branch?.type === "object"
      && branch.properties !== null && typeof branch.properties === "object" && !Array.isArray(branch.properties)
      && Array.isArray(branch.required)
      && branch.required.every((field) => typeof field === "string" && Object.hasOwn(branch.properties, field));
    if (schema?.$schema !== "https://json-schema.org/draft/2020-12/schema"
      || !Array.isArray(branches) || branches.length === 0 || !branches.every(objectShape)) {
      throw new Error(`${source}: event ${name} has an invalid field schema: expected a Draft 2020-12 object schema with properties, required and optional oneOf branches`);
    }
    try {
      validators.set(event, fieldSchemaAjv.compile(event.fields));
    } catch (error) {
      throw new Error(`${source}: event ${name} has an invalid field schema: ${error.message}`, { cause: error });
    }
  }
  catalogFieldValidators.set(catalog, validators);
  return validators;
}

/** The findings of the structure of one event line in a file of `channel`. */
function lineFindings(entry, catalog, validators, channel = "other") {
  const { line, event } = entry;
  const findings = [];
  // A catalog names the layers it owns; the events of another layer belong to the catalog of another repository.
  if (catalog.layers !== undefined && LAYERS.has(event.layer) && !catalog.layers.includes(event.layer)) return findings;
  const report = (message) => findings.push({ line, message });
  if (!Number.isInteger(event.seq)) report("seq must be an integer");
  if (!Number.isInteger(event.ts_us)) report("ts_us must be an integer");
  if (!Number.isInteger(event.mono_ns) || event.mono_ns <= 0) report("mono_ns must be a positive integer");
  if (!LEVELS.has(event.level)) report(`level ${event.level} is not one of ${[...LEVELS].join(", ")}`);
  if (!LAYERS.has(event.layer)) report(`layer ${event.layer} is not one of ${[...LAYERS].join(", ")}`);
  // An event of a document names the document that wrote it, its time origin as page.start states it, so the anchor of its
  // clock (page.log.clock of the same page) is found from the line.
  if (PAGE_LAYERS.has(event.layer)) {
    if (typeof event.page !== "string" || event.page === "") report(`an event of the layer ${event.layer} names the page that wrote it in page`);
  } else if (event.page !== undefined) {
    report(`page names the writing page only on an event of the layer page or plugin, not ${event.layer}`);
  }
  // A file holds the levels of its channel: the main file error, warn and info, the debug file debug and trace.
  if (LEVELS.has(event.level) && !IN_EVERY_FILE.has(event.event) && !CHANNEL_LEVELS[channel].has(event.level)) {
    report(`the level ${event.level} belongs to the ${channel === "debug" ? "main" : "debug"} file, and this is a file of the channel ${channel}`);
  }
  const declared = declaration(catalog, event.event);
  if (declared === undefined) {
    if (event.undeclared !== true) report(`event ${event.event} is not declared`);
    // An undeclared event of the layer plugin takes the class lifecycle and is gated as it; any other undeclared event has no class.
    // default: the host contract assigns undeclared plugin events to lifecycle.
    else if (event.layer === "plugin" && event.class !== "lifecycle") report(`event ${event.event} is undeclared in the layer plugin, so it has the class lifecycle, found ${event.class ?? "none"}`);
    else if (event.layer !== "plugin" && event.class !== undefined) report(`event ${event.event} is undeclared, so it has no class, found ${event.class}`);
    return findings;
  }
  if (!CLASSES.has(declared.class)) report(`the catalog gives ${event.event} the class ${declared.class}`);
  // The line stores the class of its catalog entry, and an event the catalog declares is not marked undeclared.
  if (event.class === undefined) report(`event ${event.event} has no class, the catalog declares ${declared.class}`);
  else if (event.class !== declared.class) report(`event ${event.event} has the class ${event.class}, the catalog declares ${declared.class}`);
  if (event.undeclared === true) report(`event ${event.event} is marked undeclared but the catalog declares it`);
  // An event that the catalog declares with `cids: "required"` is one input of a chain: without an identifier it cannot be joined.
  if (declared.cids === "required" && !(Array.isArray(event.cids) && event.cids.length > 0 && event.cids.every((cid) => typeof cid === "string"))) {
    report(`event ${event.event} requires cids`);
  }
  // The writer stores an event over its size bound cut: `truncated` is the size of the fields before the cut, and the fields
  // hold only the head of their text, so the declared fields are not asked for (docs/spec/logging.md#bounds).
  if (event.truncated !== undefined) {
    if (!Number.isInteger(event.truncated) || event.truncated <= 0) report("truncated must be a positive integer");
    else if (typeof event.fields?.head !== "string") report("the fields of a truncated event must hold the string head");
    return findings;
  }
  const validateFields = validators.get(declared);
  if (validateFields !== undefined && !validateFields(event.fields)) {
    report(`fields do not match the schema of ${event.event}: ${fieldSchemaAjv.errorsText(validateFields.errors, { separator: "; " })}`);
  }
  // An entrance of calls that the catalog declares with `result: true` states its result in one form (docs/spec/logging.md#result-form):
  // `ok`, `micros` when present a non-negative integer, and `error` only for a failure, as `<code>: <text>`.
  if (declared.result === true) {
    // default: a line without fields is reported by the structure check, and the result check then has no values to compare.
    const { ok, micros, error } = event.fields ?? {};
    if (micros !== undefined && !(Number.isInteger(micros) && micros >= 0)) report("micros must be a non-negative integer");
    if (ok === true && error !== undefined) report("ok is true, so error must be absent");
    if (ok === false && error === undefined) report("ok is false, so error is required");
    if (typeof error === "string" && !/^-?\d+: ./s.test(error)) report(`error must be <code>: <text>, found ${JSON.stringify(error)}`);
  }
  return findings;
}

/** The ranges `[from, to]` of seq that `log.dropped` events of the file explain. */
function explainedRanges(entries) {
  return entries
    .filter(({ event }) => event.event === "log.dropped")
    .map(({ event }) => [event.fields.from_seq, event.fields.to_seq]);
}

/** The findings of the order of seq: consecutive, except for ranges that `log.dropped` names. */
function seqFindings(entries) {
  const ranges = explainedRanges(entries);
  const findings = [];
  let previous = null;
  for (const { line, event } of entries) {
    if (previous !== null && event.seq !== previous + 1) {
      const covered = ranges.some(([from, to]) => from === previous + 1 && to === event.seq - 1);
      if (!covered) findings.push({ line, message: `seq ${event.seq} follows seq ${previous}` });
    }
    previous = event.seq;
  }
  return findings;
}

/** The findings of the declared chains: each correlation identifier that starts a chain must reach its last event. */
function chainFindings(entries, catalog) {
  const findings = [];
  // The policies that each process applied, by time (`log.policy`); before the first one the default policy is in force.
  // A chain crosses processes, so the time and not the seq places a policy against it.
  // The page puts the policy of the setting `diagnostics.log` in its gate when the setting changes, and the host records
  // `log.policy` after it, so the policy that follows such a change is in force from the change.
  const policies = new Map();
  const changes = new Map();
  for (const { file, event } of [...entries].sort((a, b) => a.event.ts_us - b.event.ts_us)) {
    const process = processOf(file);
    // The catalog declares `keys` a required string, and the line check refuses a line without it.
    if (event.event === "page.settings.change" && event.fields.keys.split(",").includes("diagnostics.log")) {
      if (!changes.has(process)) changes.set(process, event.ts_us);
      continue;
    }
    if (event.event !== "log.policy") continue;
    // default: the first policy of a process starts its list, and a policy without a change of the setting before it is in
    // force from its own time.
    policies.set(process, [...(policies.get(process) ?? []), { ts: changes.get(process) ?? event.ts_us, classes: event.fields.classes }]);
    changes.delete(process);
  }
  // Whether every policy in force in the process of the first event, from the first to the last event of the chain,
  // stores the hop.
  const stored = (file, from, to, hop) => {
    const declared = catalog.events[hop];
    // default: a hop that the catalog does not declare with a class of the policy is asked for under every policy.
    if (declared === undefined || !POLICY_CLASSES.includes(declared.class)) return true;
    // default: a process that recorded no policy applied only the default policy.
    const all = [...(policies.get(processOf(file)) ?? [])].sort((a, b) => a.ts - b.ts);
    const first = all.filter((policy) => policy.ts <= from).at(-1);
    // default: the policy in force at the first event is the last one before it, or the default policy before the first one.
    const applied = [first ?? DEFAULT_POLICY, ...all.filter((policy) => policy.ts > from && policy.ts <= to)];
    // A hop declared with several levels is stored only when the policy stores each of them.
    const levels = Array.isArray(declared.level) ? declared.level : [declared.level];
    return applied.every((policy) => levels.every((level) => policyAllows(policy, declared.class, level)));
  };
  // default: a catalog that declares no chain has no chain to check.
  for (const [name, hops] of Object.entries(catalog.chains ?? {})) {
    const seen = new Map();
    for (const { line, file, event } of entries) {
      // default: an event that does not belong to the input has no correlation identifier.
      for (const cid of event.cids ?? []) {
        if (!seen.has(cid)) seen.set(cid, { line, file, from: event.ts_us, to: event.ts_us, events: new Set(), failed: false });
        seen.get(cid).events.add(event.event);
        seen.get(cid).to = Math.max(seen.get(cid).to, event.ts_us);
        if (event.level === "error") seen.get(cid).failed = true;
      }
    }
    for (const [cid, { line, file, from, to, events, failed }] of seen) {
      // An input that failed ends at the error that carries its identifier; the error is the record of its end.
      if (!events.has(hops[0]) || failed) continue;
      // A hop that a policy in force while the chain ran does not store is not asked for.
      const missing = hops.find((hop) => !events.has(hop) && stored(file, from, to, hop));
      if (missing !== undefined) findings.push({ line, file, message: `chain ${name} of ${cid} lacks ${missing}` });
    }
  }
  return findings;
}

/** The form of a declaration that two catalogs must share for an event they both declare: everything but the layer and the description. */
function sharedForm(declared) {
  const { layer, description, ...rest } = declared;
  return JSON.stringify(rest, (key, value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) : value));
}

/** Throws an error for an extension that the catalog cannot verify; `extension.sidecar` is the name that the error reports. */
function checkExtension(catalog, extension) {
  const where = `sidecar ${extension.sidecar}`;
  const hops = catalog.chains?.[extension.chain];
  if (hops === undefined) throw new Error(`${where}: the extension names the chain ${extension.chain}, which the catalog does not declare`);
  if (!hops.includes(extension.after)) throw new Error(`${where}: the extension follows ${extension.after}, which is not an event of the chain ${extension.chain}`);
  if (declaration(catalog, extension.after)?.fields?.properties?.name?.type !== "string") throw new Error(`${where}: the extension follows ${extension.after}, which has no field name`);
  if (!Array.isArray(extension.events) || extension.events.length === 0) throw new Error(`${where}: the extension of the chain ${extension.chain} lists no events`);
  for (const name of extension.events) {
    if (declaration(catalog, name) === undefined) throw new Error(`${where}: the extension names ${name}, which the catalog does not declare`);
  }
}

/**
 * Composes the base catalog with installed package catalogs (docs/spec/logging.md#sidecar-catalogs). Sidecar catalogs declare
 * their sidecar name and may extend a base chain. Plugin catalogs are passed as `{ kind: "plugin", id, catalog, source }`
 * descriptors and declare only `plugin.<id>.*` events. A `log.*` event shared with a sidecar must match the base declaration.
 * The result is the catalog that `auditLogs` takes: the union of events and layers, and sidecar chain extensions.
 */
export function composeCatalogs(base, ...catalogs) {
  validateCatalog(base, "base event catalog");
  const events = { ...base.events };
  const layers = new Set(base.layers ?? []);
  // default: a catalog without extensions has none to carry over.
  const extensions = [...(base.extends ?? [])];
  for (const entry of catalogs) {
    if (entry?.kind === "plugin") {
      const { id, catalog, source } = entry;
      const where = `plugin ${id}`;
      validateCatalog(catalog, `${source ?? where + " event catalog"}`);
      if (typeof id !== "string" || id === "") throw new Error(`${source ?? "plugin event catalog"}: the installed plugin id is required`);
      if (JSON.stringify(catalog.layers) !== '["plugin"]') throw new Error(`${source ?? where}: layers must be ["plugin"], found ${JSON.stringify(catalog.layers)}`);
      for (const [name, declared] of Object.entries(catalog.events)) {
        if (declared.layer !== "plugin") throw new Error(`${source ?? where}: event ${name} has the layer ${declared.layer}, not plugin`);
        if (!name.startsWith(`plugin.${id}.`)) throw new Error(`${source ?? where}: event ${name} is outside plugin.${id}.`);
        if (events[name] !== undefined) throw new Error(`${source ?? where}: event ${name} is declared twice`);
        events[name] = declared;
      }
      layers.add("plugin");
      continue;
    }
    const catalog = entry;
    validateCatalog(catalog, `sidecar ${catalog?.sidecar ?? ""} event catalog`); // default: a malformed catalog may lack its name before schema validation.
    if (typeof catalog.sidecar !== "string" || catalog.sidecar === "") throw new Error("sidecar catalog: the member sidecar must name the sidecar");
    const where = `sidecar ${catalog.sidecar}`;
    if (JSON.stringify(catalog.layers) !== '["sidecar"]') throw new Error(`${where}: layers must be ["sidecar"], found ${JSON.stringify(catalog.layers)}`);
    for (const [name, declared] of Object.entries(catalog.events)) {
      if (declared.layer !== "sidecar") throw new Error(`${where}: event ${name} has the layer ${declared.layer}, not sidecar`);
      if (name.startsWith("log.")) {
        if (events[name] !== undefined && sharedForm(events[name]) !== sharedForm(declared)) throw new Error(`${where}: event ${name} differs from the declaration of the base catalog`);
        if (events[name] === undefined) events[name] = declared;
      } else if (!name.startsWith(`sidecar.${catalog.sidecar}.`)) {
        throw new Error(`${where}: event ${name} does not start with sidecar.${catalog.sidecar}.`);
      } else if (events[name] !== undefined) {
        throw new Error(`${where}: event ${name} is declared twice`);
      } else events[name] = declared;
    }
    // default: a sidecar catalog without `extends` extends no chain.
    for (const extension of catalog.extends ?? []) extensions.push({ sidecar: catalog.sidecar, ...extension });
    layers.add("sidecar");
  }
  const composed = { ...base, layers: [...layers], events, extends: extensions };
  for (const extension of extensions) checkExtension(composed, extension);
  return composed;
}

/** The findings of the chain extensions: a request that names the sidecar of an extension must be followed by the events it lists, for its cids. */
function extensionFindings(entries, catalog) {
  const findings = [];
  const seen = new Map();
  for (const { event } of entries) {
    // default: an event outside the chains has no correlation identifier.
    for (const cid of event.cids ?? []) seen.set(cid, (seen.get(cid) ?? new Set()).add(event.event));
  }
  // default: a catalog without `extends` has no extension to check.
  for (const extension of catalog.extends ?? []) {
    checkExtension(catalog, extension);
    const reported = new Set();
    for (const { line, file, event } of entries) {
      if (event.event !== extension.after || event.fields?.name !== extension.sidecar) continue;
      // default: a request without cids is reported by the structure check of the required cids.
      for (const cid of event.cids ?? []) {
        const missing = extension.events.find((name) => !seen.get(cid).has(name));
        if (missing === undefined || reported.has(cid)) continue;
        reported.add(cid);
        findings.push({ line, file, message: `chain ${extension.chain} of ${cid} lacks ${missing} after ${extension.after} of ${extension.sidecar}` });
      }
    }
  }
  return findings;
}

/**
 * Audits the text of one log file against a catalog and returns the findings `{line, message}`: undeclared events,
 * missing or mistyped fields, gaps of seq that no `log.dropped` explains, and declared chains that stop early.
 */
export function auditLog(file, text, catalog) {
  const validators = validateCatalog(catalog, file);
  const entries = parseLog(file, text).map((entry) => ({ ...entry, file }));
  return [
    ...entries.flatMap((entry) => lineFindings(entry, catalog, validators, channelOf(file))),
    ...seqFindings(entries),
    ...chainFindings(entries, catalog),
    ...extensionFindings(entries, catalog),
  ].sort((a, b) => a.line - b.line);
}

/** The process a file belongs to and its position in the order of the generations: `host-1-2.jsonl.1` and `host-1-2.debug.jsonl` belong to `host-1-2`. */
export function processOf(file) {
  const base = file.split("/").pop();
  const match = /^(.+?)(?:\.debug)?\.jsonl(?:\.\d+)?$/.exec(base);
  if (match === null) throw new Error(`${file}: not an event file name (<role>-<boot>[.debug].jsonl[.<generation>])`);
  return match[1];
}

/** The text of an `error` event for a finding. */
function errorText(event) {
  // default: a line may carry no fields, which the structure check reports on its own; the text then names the event.
  const { where, text } = event.fields ?? {};
  // default: the same absent fields give the empty record in the text of an event that has no where and text.
  return typeof where === "string" && typeof text === "string" ? `${where}: ${text}` : `${event.event}: ${JSON.stringify(event.fields ?? {})}`;
}

/**
 * Audits the event files of one configuration folder together and returns the findings `{file, line, message}`. `logs` is
 * `[{file, text}]` for every layer and generation. Each line is checked against the catalog. The `seq` of one process is
 * consecutive across its rotated generations and its debug file (gaps that `log.dropped` names are explained), the declared
 * chains join the events of all files because a chain crosses processes, and an `error` event is a finding unless
 * `declaredError(file, {line, event})` is true.
 */
export function auditLogs(logs, catalog, declaredError = () => false) {
  const parsed = logs.map(({ file, text }) => ({ file, process: processOf(file), entries: parseLog(file, text).map((entry) => ({ ...entry, file })) }));
  return auditParsed(parsed, catalog, declaredError);
}

/** The audit of `auditLogs` for files that are already read: `[{file, process, entries}]` with `file` on each entry. */
export function auditParsed(parsed, catalog, declaredError = () => false) {
  const validators = validateCatalog(catalog, "event catalog");
  const findings = [];
  const located = (file, list) => list.forEach(({ line, message }) => findings.push({ file, line, message }));
  for (const { file, entries } of parsed) {
    located(file, entries.flatMap((entry) => lineFindings(entry, catalog, validators, channelOf(file))));
    for (const entry of entries) {
      if (entry.event.level === "error" && !declaredError(file, entry)) {
        findings.push({ file, line: entry.line, message: `undeclared error ${errorText(entry.event)}` });
      }
    }
    // seq increases within one file; the merge below checks the continuity of the process.
    entries.forEach((entry, index) => {
      if (index > 0 && entry.event.seq <= entries[index - 1].event.seq) {
        findings.push({ file, line: entry.line, message: `seq ${entry.event.seq} follows seq ${entries[index - 1].event.seq}` });
      }
    });
  }
  const processes = new Map();
  // default: the first file of a process has no entries collected yet.
  for (const { process, entries } of parsed) processes.set(process, [...(processes.get(process) ?? []), ...entries]);
  for (const entries of processes.values()) {
    const ordered = [...entries].sort((a, b) => a.event.seq - b.event.seq);
    const ranges = explainedRanges(ordered);
    ordered.forEach((entry, index) => {
      const previous = ordered[index - 1];
      if (previous === undefined || entry.event.seq === previous.event.seq + 1) return;
      // A file whose seq runs backwards is already reported above.
      if (previous.file === entry.file && entry.event.seq < previous.event.seq) return;
      const covered = ranges.some(([from, to]) => from === previous.event.seq + 1 && to === entry.event.seq - 1);
      if (!covered) findings.push({ file: entry.file, line: entry.line, message: `seq ${entry.event.seq} follows seq ${previous.event.seq}` });
    });
  }
  const all = parsed.flatMap(({ entries }) => entries);
  for (const { line, message, file } of [...chainFindings(all, catalog), ...extensionFindings(all, catalog)]) findings.push({ file, line, message });
  const order = new Map(parsed.map(({ file }, index) => [file, index]));
  // default: findings of the same file, or of a file without an order, are ordered by their line.
  return findings.sort((a, b) => order.get(a.file) - order.get(b.file) || a.line - b.line);
}

/** The schema number of the policy file `log-policy.json` (docs/spec/logging.md#policy-file). */
export const POLICY_SCHEMA = 1;
/** The classes that the policy file names, in the order of the contract. */
export const POLICY_CLASSES = ["lifecycle", "input", "call", "io", "frame"];

/** The default policy, which every writer and the native ring apply before the first policy and while no policy file
 * exists: only `error` in every class (docs/spec/logging.md#policy). `fixtures/policy/cases.json` holds the same value as
 * `default`, which the readers of the other languages check. */
export const DEFAULT_POLICY = Object.freeze({ classes: Object.freeze(Object.fromEntries(POLICY_CLASSES.map((kind) => [kind, "error"]))) });
/** The values of a class in the policy file, from the one that stores nothing to the one that stores every level. */
export const POLICY_VALUES = ["off", "error", "warn", "info", "debug", "trace"];
const POLICY_LEVELS = POLICY_VALUES.slice(1);

/**
 * Reads the text of a policy file into `{schema, classes}`. Every member, class and value is checked, and an error names `file`
 * and what it found; a policy that leaves a class out is refused, because no value stands in for it. The messages are those of
 * the host and the command line tool, except the text after `not JSON: `, which is the message of the parser of the language.
 */
export function parsePolicy(file, text) {
  let members;
  try {
    members = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: not JSON: ${error.message}`, { cause: error });
  }
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(members)) throw new Error(`${file}: not JSON: the text is not an object`);
  for (const name of Object.keys(members).sort()) {
    if (name !== "schema" && name !== "classes") throw new Error(`${file}: the member ${name} is not one of schema, classes`);
  }
  if (!Number.isInteger(members.schema)) {
    throw new Error(`${file}: schema must be the number ${POLICY_SCHEMA}, found ${members.schema === undefined ? "" : JSON.stringify(members.schema)}`);
  }
  if (members.schema !== POLICY_SCHEMA) throw new Error(`${file}: schema ${members.schema} is not ${POLICY_SCHEMA}`);
  if (!isObject(members.classes)) throw new Error(`${file}: classes must be an object that names every class`);
  for (const name of Object.keys(members.classes).sort()) {
    if (!POLICY_CLASSES.includes(name)) throw new Error(`${file}: the class ${name} is not one of ${POLICY_CLASSES.join(", ")}`);
  }
  const classes = {};
  for (const name of POLICY_CLASSES) {
    const value = members.classes[name];
    if (value === undefined) throw new Error(`${file}: the class ${name} is missing`);
    if (typeof value !== "string") throw new Error(`${file}: the level of the class ${name} must be text, found ${JSON.stringify(value)}`);
    if (!POLICY_VALUES.includes(value)) throw new Error(`${file}: the level ${JSON.stringify(value)} of the class ${name} is not one of ${POLICY_VALUES.join(", ")}`);
    classes[name] = value;
  }
  return { schema: POLICY_SCHEMA, classes };
}

/** Whether a policy from `parsePolicy` stores an event of the class at the level: the level is not more verbose than the value of the class. */
export function policyAllows(policy, kind, level) {
  if (!POLICY_CLASSES.includes(kind)) throw new Error(`the class ${kind} is not one of ${POLICY_CLASSES.join(", ")}`);
  if (!POLICY_LEVELS.includes(level)) throw new Error(`the level ${level} is not one of ${POLICY_LEVELS.join(", ")}`);
  return POLICY_VALUES.indexOf(policy.classes[kind]) >= POLICY_VALUES.indexOf(level);
}

/** The kinds of replay input (docs/spec/replay.md#records). */
export const REPLAY_INPUT_KINDS = ["output", "write", "resize", "selection", "viewport", "theme"];
const SELECTION_ACTIONS = ["start", "update", "end", "clear"];
const THEME_REQUIRED = ["foreground", "background", "selection"];

const shown = (value) => (value === undefined ? "undefined" : JSON.stringify(value));

/**
 * The problem of the fields of one replay input of `kind`, as text, or null when the fields are in the form of the contract.
 * The kind of an event is the sidecar's choice of name; the fields are the contract's.
 */
export function replayInputProblem(kind, fields) {
  if (!REPLAY_INPUT_KINDS.includes(kind)) return `replay input ${kind} is not one of ${REPLAY_INPUT_KINDS.join(", ")}`;
  const integerFrom = (name, min) => (Number.isInteger(fields[name]) && fields[name] >= min ? null : `${kind}: ${name} must be an integer from ${min}, found ${shown(fields[name])}`);
  const sequence = integerFrom("sequence", 1);
  if (sequence !== null) return sequence;
  if (kind === "output" || kind === "write") {
    return typeof fields.hex === "string" && /^(?:[0-9a-f]{2})+$/.test(fields.hex) ? null : `${kind}: hex must be lowercase hexadecimal text of whole bytes, found ${shown(fields.hex)}`;
  }
  if (kind === "resize") return integerFrom("rows", 1) || integerFrom("cols", 1);
  if (kind === "selection") {
    if (!SELECTION_ACTIONS.includes(fields.action)) return `selection: action must be start, update, end or clear, found ${shown(fields.action)}`;
    if (fields.action === "start" || fields.action === "update") return integerFrom("edge", 0) || integerFrom("row", 0);
    return fields.edge === undefined && fields.row === undefined ? null : `selection: ${fields.action} takes no edge and no row`;
  }
  if (kind === "viewport") {
    if (fields.lines !== undefined && fields.newest !== undefined) return "viewport: lines and newest are exclusive";
    if (fields.lines === undefined && fields.newest === undefined) return "viewport: lines (a non-zero integer) or newest (true) is required";
    if (fields.newest !== undefined) return fields.newest === true ? null : `viewport: newest must be true, found ${shown(fields.newest)}`;
    return Number.isInteger(fields.lines) && fields.lines !== 0 ? null : `viewport: lines must be a non-zero integer, found ${shown(fields.lines)}`;
  }
  const colors = fields.colors;
  if (colors === null || typeof colors !== "object" || Array.isArray(colors)) return `theme: colors must be an object of colors, found ${shown(colors)}`;
  for (const name of THEME_REQUIRED) if (colors[name] === undefined) return `theme: colors.${name} is required`;
  for (const [name, color] of Object.entries(colors)) {
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/.test(color)) return `theme: colors.${name} must be "#rrggbb" in lowercase, found ${shown(color)}`;
  }
  return null;
}

/**
 * The problem of the replay inputs of one session, `[{kind, fields}]` in the order they were applied, as text, or null: each
 * input is in form, the sequences run from 1 without a gap, the first input is a theme, and a selection start or update lies inside the grid of the
 * last resize, and a selection update or end follows a selection start.
 */
export function replaySessionProblem(inputs) {
  let previous = 0;
  let selecting = false;
  let size = null;
  for (const [index, { kind, fields }] of inputs.entries()) {
    const at = index + 1;
    const problem = replayInputProblem(kind, fields);
    if (problem !== null) return `input ${at}: ${problem}`;
    if (fields.sequence !== previous + 1) return `input ${at} has sequence ${fields.sequence} and the sequence after ${previous} is ${previous + 1}`;
    previous = fields.sequence;
    if (index === 0 && kind !== "theme") return `input 1 is a ${kind} and the first input of a session is a theme`;
    if (kind === "resize") size = fields;
    if (kind === "selection") {
      if (fields.action === "start" || fields.action === "update") {
        if (size === null) return `input ${at} is a selection ${fields.action} before any resize`;
        if (fields.row >= size.rows || fields.edge > size.cols) return `input ${at} is a selection ${fields.action} at edge ${fields.edge} row ${fields.row} outside the grid of ${size.rows} rows and ${size.cols} columns`;
      }
      if ((fields.action === "update" || fields.action === "end") && !selecting) return `input ${at} is a selection ${fields.action} and no selection has started`;
      selecting = fields.action === "start" || fields.action === "update";
    }
  }
  return null;
}

/** Whether the text of a policy file is one that a writer truncated and is writing: a reader waits for the next notification and reports nothing. */
export const policyIsBeingWritten = (text) => text.trim() === "";
