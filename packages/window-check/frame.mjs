// The frame files of a recording.
//
// A frame is one still of a recording, written as frame-<index>.bgra; stills.jsonl tells each still (stills.mjs).
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The frames of one folder in the order of their stills. */
export function frames(directory) {
  // A frame is named by the four-digit index of its still in the recording (0 to 4095); a still that wrote no frame leaves a
  // gap in the names, which stills.jsonl explains (docs/spec/endpoint.md).
  const number = (name) => {
    const match = /^frame-(\d{4})\.bgra$/.exec(name);
    if (!match) throw new Error(`recording ${directory} has an unexpected frame file ${name}`);
    return Number(match[1]);
  };
  return readdirSync(directory)
    .filter((name) => name.endsWith(".bgra"))
    .map((name) => ({ name, index: number(name) }))
    .sort((a, b) => a.index - b.index)
    .map(({ name }) => join(directory, name));
}
