// The rows of the event files that the debug timeline shows (docs/spec/debug.md#timeline-following): a check compares the counts of a
// shown timeline with the rows of the files themselves.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The rows of the page that shows a timeline (docs/spec/debug.md#timeline). */
export const PAGE_ROWS = 500;

/**
 * A file of the channel other: an event file of the logs folder that is not a debug file, `<process>.jsonl` or a generation
 * `<process>.jsonl.<n>`, where the process is the key that the `tail` of a page names (docs/spec/logging.md#files).
 */
const OTHER_FILE = /^([a-z][a-z0-9]*-.+?)\.jsonl(?:\.[1-9][0-9]*)?$/;

/**
 * The `seq` of each row of the channel other in the logs folder of configDir, by process, in ascending order. A last line that is not
 * finished is not a row yet.
 */
export function channelOtherSeqs(configDir) {
  const logs = join(configDir, "logs");
  const seqs = new Map();
  for (const name of readdirSync(logs).sort()) {
    const match = name.match(OTHER_FILE);
    if (match === null || match[1].endsWith(".debug")) continue;
    const text = readFileSync(join(logs, name), "utf8");
    const complete = text.lastIndexOf("\n") + 1;
    const list = seqs.get(match[1]) ?? [];
    for (const [index, line] of text.slice(0, complete).split("\n").entries()) {
      if (line === "") continue;
      const { seq } = JSON.parse(line);
      if (!Number.isInteger(seq)) throw new Error(`${join(logs, name)}:${index + 1}: the event has no integer seq`);
      list.push(seq);
    }
    seqs.set(match[1], list);
  }
  for (const list of seqs.values()) list.sort((a, b) => a - b);
  return seqs;
}

/**
 * The counts that a timeline of the channel other shows for the rows seqs: `first`, the rows of the page that showed it, which is the
 * newest page of at most pageRows rows up to its start, and `appended`, the rows after the start up to the tail of its last read.
 * A process that the start does not name has no row up to the start, and one that the tail does not name has no row read after it.
 */
export function expectedTimeline(seqs, start, tail, pageRows) {
  let before = 0;
  let appended = 0;
  for (const [process, list] of seqs) {
    const from = start[process] ?? 0;
    const to = tail[process] ?? from;
    if (to < from) throw new Error(`the tail ${to} of ${process} is before the start ${from}`);
    before += list.filter((seq) => seq <= from).length;
    appended += list.filter((seq) => seq > from && seq <= to).length;
  }
  return { first: Math.min(pageRows, before), appended };
}
