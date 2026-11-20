// The colors of a group card (docs/spec/groups.md#drawing). The shared cases of docs/spec/cases/group-look.json state them, and Palette
// GroupLook of packages/workbench-mygo meets the same cases, so both workbenches draw a group card in the same colors.

const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

/** The color hex mixed into base by share, each channel rounded. */
const mixed = (hex, base, share) => {
  const [a, b] = [rgb(hex), rgb(base)];
  return `#${a.map((c, i) => Math.round(c * share + b[i] * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
};

/**
 * The colors of a group card whose members stand on level, from the tokens of its theme and mode (colors), whether the cards share one
 * line (seam) and the chrome value group-fill-fade (fade): head is the color of its header, card, as the head of a content card; line
 * is the line under its header, edge with a gap and rule at the seam, as under the head of a content card; body is the area inside its
 * frame around its members, bg mixed into card by fade to the power of level, so each nesting level stands one step nearer to card.
 */
export function groupLook(colors, level, { seam, fade }) {
  return { head: colors.card, line: seam ? colors.rule : colors.edge, body: mixed(colors.bg, colors.card, fade ** level) };
}
