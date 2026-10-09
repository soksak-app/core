// The versions and ranges of docs/spec/installation.md.

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The numeric parts of `x.y.z`; a version of another form is an error. */
function parts(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`version ${version} must be x.y.z with numeric parts and no leading zeros`);
  return match.slice(1).map(Number);
}

/** Compares two versions by number. */
export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** Whether `range` contains `version`; a range of a form that the specification does not list is an error. */
export function satisfies(range, version) {
  const at = (floor, ceiling) => compareVersions(version, floor) >= 0 && (ceiling === null || compareVersions(version, ceiling) < 0);
  if (range === "*") return true;
  if (VERSION.test(range)) return compareVersions(version, range) === 0;
  if (range.startsWith("^") && VERSION.test(range.slice(1))) {
    const [major, minor, patch] = parts(range.slice(1));
    const ceiling = major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
    return at(range.slice(1), ceiling);
  }
  if (range.startsWith("~") && VERSION.test(range.slice(1))) {
    const [major, minor] = parts(range.slice(1));
    return at(range.slice(1), `${major}.${minor + 1}.0`);
  }
  const bounded = /^>=(\S+)(?: <(\S+))?$/.exec(range);
  if (bounded && VERSION.test(bounded[1]) && bounded[2] === undefined) return at(bounded[1], null);
  if (bounded && VERSION.test(bounded[1]) && VERSION.test(bounded[2])) return at(bounded[1], bounded[2]);
  throw new Error(`range ${range} is not one of *, x.y.z, ^x.y.z, ~x.y.z, >=x.y.z and >=x.y.z <a.b.c`);
}
