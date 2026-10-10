// The state files of the debug view (docs/spec/debug.md): `logs/state-<time>.json` is parsed, shown as tree lines and
// compared with another state file.

/** The hosts that a state file names. */
const HOSTS = ["wailsv3", "tauriv2"];

/** The text of a value in an error message. */
const found = (value) => JSON.stringify(value);

/** The state files in the debug file list, in path order: `logs/state-<time>.json`. */
export function stateFiles(entries) {
  return entries.map((entry) => entry.path).filter((path) => /^logs\/state-[^/]+\.json$/.test(path)).toSorted();
}

/** The state of the text of one state file, or an error that names the file and what was found. */
export function parseState(file, text, truncated) {
  if (truncated) throw new Error(`${file}: the text was cut at the read limit, so the state cannot be read`);
  let state;
  try {
    state = JSON.parse(text);
  } catch (reason) {
    throw new Error(`${file}: not JSON: ${reason.message}`);
  }
  if (state === null || typeof state !== "object" || Array.isArray(state)) throw new Error(`${file}: not a state object: ${text.slice(0, 80)}`);
  if (typeof state.time !== "string") throw new Error(`${file}: time must be a string, found ${found(state.time)}`);
  if (!HOSTS.includes(state.host)) throw new Error(`${file}: host ${found(state.host)} is not one of ${HOSTS.join(", ")}`);
  if (state.versions === null || typeof state.versions !== "object" || Array.isArray(state.versions)) throw new Error(`${file}: versions must be an object, found ${found(state.versions)}`);
  // `page` is the value the page sent (docs/spec/debug.md): the entries of its exposure, so an array is as valid as an object.
  if (state.page === null || typeof state.page !== "object") throw new Error(`${file}: page must be an object or an array, found ${found(state.page)}`);
  if (!Array.isArray(state.windows)) throw new Error(`${file}: windows must be an array, found ${found(state.windows)}`);
  return state;
}

const isContainer = (value) => value !== null && typeof value === "object";
const isEmpty = (value) => Object.keys(value).length === 0;

/** The tree lines `{depth, key, value}` of a state; a container with members has `value` null and `size` like `{2}` or `[1]`. */
export function stateLines(state) {
  const lines = [];
  const walk = (value, key, depth) => {
    if (!isContainer(value) || isEmpty(value)) {
      lines.push({ depth, key, value: JSON.stringify(value) });
      return;
    }
    const array = Array.isArray(value);
    lines.push({ depth, key, value: null, size: array ? `[${value.length}]` : `{${Object.keys(value).length}}` });
    for (const [name, member] of Object.entries(value)) walk(member, array ? `[${name}]` : name, depth + 1);
  };
  for (const [name, member] of Object.entries(state)) walk(member, name, 0);
  return lines;
}

/** The path of a member below a path: `.name`, `["name"]` for a name that is not an identifier, or `[index]`. */
function memberPath(path, name, array) {
  if (array) return `${path}[${name}]`;
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return path === "" ? name : `${path}.${name}`;
  return `${path}[${found(name)}]`;
}

/** The leaves of a state as a map from path to the JSON text of the value; an empty container is a leaf. */
function leaves(state) {
  const map = new Map();
  const walk = (value, path) => {
    if (!isContainer(value) || isEmpty(value)) {
      map.set(path, JSON.stringify(value));
      return;
    }
    const array = Array.isArray(value);
    for (const [name, member] of Object.entries(value)) walk(member, memberPath(path, name, array));
  };
  walk(state, "");
  return map;
}

/**
 * The differences `{path, a, b}` between two states: the paths of the first state whose value differs or is absent in the
 * second, then the paths that only the second state has. An absent value is null; the text of a value is JSON.
 */
export function compareStates(first, second) {
  const left = leaves(first);
  const right = leaves(second);
  const differences = [];
  for (const [path, a] of left) {
    // default: a path that the other state file lacks has no value there, which the comparison reports as a difference.
    const b = right.get(path) ?? null;
    if (a !== b) differences.push({ path, a, b });
  }
  for (const [path, b] of right) {
    if (!left.has(path)) differences.push({ path, a: null, b });
  }
  return differences;
}
