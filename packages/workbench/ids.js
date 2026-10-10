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

/** Generates and returns one identifier. */
export function issueId(kind) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  const buf = new Uint8Array(LEN);
  crypto.getRandomValues(buf);
  let body = "";
  for (const b of buf) body += ALPHABET[b % 32];
  return prefix + body;
}
