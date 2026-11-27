// The verifier of the layouts that agents build from a request (docs/spec/cases/agent-layout/requests.json, F959-1). It judges the card
// frames that `core.grid` reports against the predicates of one request, and returns one failure text for each predicate that the
// layout breaks. Two rects are equal in a predicate when their sides differ by at most one point, the precision of the frames.
const EPSILON = 1;
const near = (a, b) => Math.abs(a - b) <= EPSILON;

/** The cards grouped into rows by their top edge, each row sorted by its left edge. */
function rowsOf(cards) {
  const rows = [];
  for (const card of [...cards].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((candidate) => near(candidate.y, card.y));
    if (row) row.cards.push(card);
    else rows.push({ y: card.y, cards: [card] });
  }
  return rows;
}

const checks = {
  row({ count, equal }, cards) {
    const rows = rowsOf(cards);
    if (rows.length !== 1 || cards.length !== count) {
      return `the layout holds ${cards.length} cards in ${rows.length} rows, want ${count} cards in one row`;
    }
    if (equal) {
      const widths = cards.map((card) => card.w);
      if (Math.max(...widths) - Math.min(...widths) > EPSILON) {
        return `the cards of the row have widths ${JSON.stringify(widths)}, want equal widths`;
      }
    }
    return null;
  },
  grid({ rows, columns }, cards) {
    const lines = rowsOf(cards);
    if (lines.length !== rows) return `the layout holds ${lines.length} rows, want ${rows}`;
    const first = lines[0].cards.map((card) => card.x);
    for (const line of lines) {
      if (line.cards.length !== columns) return `a row holds ${line.cards.length} cards, want ${columns}`;
      const xs = line.cards.map((card) => card.x);
      if (xs.some((x, i) => !near(x, first[i]))) {
        return `the columns of the rows are not aligned: ${JSON.stringify(xs)} against ${JSON.stringify(first)}`;
      }
    }
    return null;
  },
  plugins({ cards: count, distinct }, cards) {
    if (cards.length !== count) return `the layout holds ${cards.length} cards, want ${count}`;
    const plugins = new Set(cards.flatMap((card) => card.tabs.map((tab) => tab.plugin)));
    if (plugins.size < distinct) return `the cards show ${plugins.size} plugins, want ${distinct}`;
    return null;
  },
  groups({ count }, cards) {
    // A group card holds at least two cards, because a group of one card is not a group (docs/spec/groups.md).
    const members = new Map();
    for (const card of cards) if (card.parent !== null) members.set(card.parent, (members.get(card.parent) ?? 0) + 1);
    if (members.size !== count) return `the layout holds ${members.size} groups, want ${count}`;
    for (const [group, held] of members) {
      if (held < 2) return `group ${group} holds ${held} card, want at least 2`;
    }
    return null;
  },
};

/** The failures of a layout of cards against the predicates of one request; an empty list means the layout meets them all. */
export function judge(cards, predicates) {
  const failures = [];
  for (const predicate of predicates) {
    const check = checks[predicate.kind];
    if (!check) throw new Error(`unknown predicate kind ${predicate.kind}`);
    const failure = check(predicate, cards);
    if (failure !== null) failures.push(`${predicate.kind}: ${failure}`);
  }
  return failures;
}
