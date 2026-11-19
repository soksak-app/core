// The colors of a group card (docs/spec/groups.md#drawing). The shared cases of docs/spec/cases/group-look.json state them, and Palette
// GroupLook of packages/workbench-mygo meets the same cases, so both workbenches draw a group card in the same colors.

/**
 * The colors of a group card whose members stand on level, from the tokens of its theme and mode (colors) and whether the cards share
 * one line (seam): line is the line under its header, edge with a gap and rule at the seam, as under the head of a content card.
 */
export function groupLook(colors, level, { seam }) {
  return { line: seam ? colors.rule : colors.edge };
}
