import assert from "node:assert/strict";
import { Soksak } from "../dist/index.js";

const idArguments = {
  split: [0], splitToward: [0], close: [0], move: [0, 1], moveTo: [0],
  setSize: [0], setFixed: [0], setData: [0],
  insertAt: [], moveBoundary: [], mergeCoincident: [], tidy: [], resize: [],
};
const createdArgument = { split: 2, splitToward: 2, insertAt: 2 };

function snapshot(grid, normalize) {
  return {
    width: grid.width, height: grid.height,
    lines: { x: grid.lines("x"), y: grid.lines("y") },
    cards: grid.cards.map((card) => ({
      ...card, id: normalize(card.id), rect: grid.rect(card.id),
      canClose: grid.canClose(card.id), canSplitX: grid.canSplit(card.id, "x"), canSplitY: grid.canSplit(card.id, "y"),
    })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
}

/** Compare public behavior; no generated operations or layout oracle is reused. */
export function assertRoleIndependence({ state, options, operations, create = (value, settings) => new Soksak(value, settings) }) {
  const identifiers = new Set(state.cards.map((card) => card.id));
  for (const operation of operations) {
    assert.ok(Object.hasOwn(idArguments, operation.method), `unknown comparison operation: ${operation.method}`);
    for (const index of idArguments[operation.method]) identifiers.add(operation.args[index]);
    const born = operation.args[createdArgument[operation.method]]?.id;
    if (born !== undefined) identifiers.add(born);
  }
  for (const [id, paid] of Object.entries(state.paidBy ?? {})) {
    identifiers.add(id);
    if (paid.to) identifiers.add(paid.to);
  }
  const aliases = new Map([...identifiers].map((id, index) => [id, `renamed-${index}`]));
  const originals = new Map([...aliases].map(([id, alias]) => [alias, id]));
  const indices = state.cards.map((_, index) => index);
  // These small fixtures enumerate every input order, including each pair's
  // relative order. The identity input is run separately as the baseline.
  let orders = [[]];
  for (const index of indices) orders = orders.flatMap((order) =>
    Array.from({ length: order.length + 1 }, (_, at) => [...order.slice(0, at), index, ...order.slice(at)]));
  const mapId = (map, id) => {
    assert.ok(map.has(id), `unmapped card identifier: ${id}`);
    return map.get(id);
  };

  function run(order, renamed) {
    const rename = (id) => renamed ? mapId(aliases, id) : id;
    const normalize = (id) => renamed ? mapId(originals, id) : id;
    const input = structuredClone(state);
    input.cards = order.map((index) => ({ ...input.cards[index], id: rename(input.cards[index].id) }));
    if (input.paidBy) input.paidBy = Object.fromEntries(Object.entries(input.paidBy).map(([id, paid]) => [rename(id), { ...paid, to: paid.to ? rename(paid.to) : "" }]));
    const grid = create(input, structuredClone(options));
    const observations = [{ state: snapshot(grid, normalize) }];
    for (const operation of operations) {
      const args = structuredClone(operation.args);
      for (const index of idArguments[operation.method]) args[index] = rename(args[index]);
      const bornAt = createdArgument[operation.method];
      if (bornAt !== undefined && args[bornAt]?.id !== undefined) args[bornAt].id = rename(args[bornAt].id);
      const result = grid[operation.method](...args);
      observations.push({ result: typeof result === "string" ? normalize(result) : result, state: snapshot(grid, normalize) });
    }
    return observations;
  }

  const baseline = run(indices, false);
  let variants = 0;
  for (const renamed of [false, true]) for (const order of orders) {
    if (!renamed && order.every((value, index) => value === indices[index])) continue;
    const actual = run(order, renamed);
    for (let step = 0; step < baseline.length; step++) {
      assert.deepEqual(actual[step], baseline[step], `role independence: renamed=${renamed} order=${order} transition=${step - 1}`);
    }
    variants++;
  }
  return { variants, initial: baseline[0].state, final: baseline.at(-1).state, outcomes: baseline.slice(1).map((entry) => entry.result) };
}
