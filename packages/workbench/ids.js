// Identifier generation.
//
// The form is `<three letters>-<six base32 characters>`. One or two letters make kinds overlap: `s-` applies to
// space, split, and session alike.
//
// No counter is used. A counter returns to 1 at every restart, and the same value
// is assigned to a different target.
//
// An id is an address, and the natural key decides the identity. Whether a project is a duplicate
// is decided by root, not by id.

/** 0 and 1 are excluded. Characters that can be confused with o and l are not generated. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LEN = 6;

const PREFIX = {
  project: "prj-",
  space: "spc-",
  tab: "tab-",
};

/**
 * Generates and returns one identifier of `kind` for which `taken(id)` is false. Random ids of 30 bits can repeat, and
 * an id that another target already holds would address both, so a taken id is drawn again.
 */
export function issueId(kind, taken) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  if (typeof taken !== "function") throw new TypeError(`issueId(${kind}) needs a check of the taken ids, not ${taken}`);
  const buf = new Uint8Array(LEN);
  for (;;) {
    crypto.getRandomValues(buf);
    let body = "";
    for (const b of buf) body += ALPHABET[b % 32];
    if (!taken(prefix + body)) return prefix + body;
  }
}
