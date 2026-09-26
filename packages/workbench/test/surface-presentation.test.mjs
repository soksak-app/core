import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { JSDOM } from "jsdom";

test("native preparation cannot present before DOM drawing and presents each ticket once", async () => {
  const dom = new JSDOM('<div id="plane"></div>');
  globalThis.document = dom.window.document;
  const calls = [];
  let fail = null;
  mock.module("@soksak/runtime", { namedExports: { host: {
    on: () => {},
    page: (path) => path,
    call: async (name, request) => {
      calls.push({ name, request });
      if (name === "report") return;
      if (name === fail) { fail = null; throw new Error(`injected ${name} failure`); }
      if (name === "syncSurfaces") return {
        ticket: calls.length,
        placements: [
          { id: "surface", x: 1, y: 2, w: 3, h: 4, visible: true },
          { id: "hidden", x: 0, y: 0, w: 1, h: 1, visible: false },
        ],
      };
      if (name === "presentSurfaces") return request.placements;
      throw new Error(`unexpected host call ${name}`);
    },
  } } });
  const { onSurfacePrepared, surfaces } = await import("../host.js");
  const prepared = [];
  const removePrepared = onSurfacePrepared((placements) => prepared.push(placements.map(({ id }) => id)));
  const record = {
    surfaces: [{
      id: "surface", dim: false, visible: true,
      surface: { module: "surface-module", composition: {
        kind: "hybrid", regions: [{ name: "view", kind: "image" }], overlays: [],
      } },
      applied: { x: 1, y: 2, w: 3, h: 4 },
    }],
    settled: false, drawn: false,
  };
  await surfaces.place(record);
  assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces"]);
  assert.deepEqual(prepared, [["surface", "hidden"]],
    "native surface authorization must follow completed preparation");
  const latePrepared = [];
  const removeLatePrepared = onSurfacePrepared((placements) => latePrepared.push(placements.map(({ id }) => id)));
  assert.deepEqual(latePrepared, [["surface", "hidden"]],
    "a module that starts after preparation must receive the current authorization state");
  await surfaces.place({ ...record, drawn: true });
  await surfaces.place({ ...record, drawn: true });
  assert.deepEqual(calls.map((c) => c.name), ["syncSurfaces", "presentSurfaces"]);
  assert.equal(calls[1].request.ticket, 1);
  assert.equal(calls[1].request.placements[0].visible, true,
    "presentation must receive the visibility declared by preparation");
  assert.equal(calls[1].request.placements[1].visible, false,
    "presentation must retain hidden surfaces instead of reviving them");
  assert.equal(calls[1].request.waitForPresentation, true,
    "image composition presentation must retain the DOM and raster barrier");
  for (const stage of ["syncSurfaces", "presentSurfaces"]) {
    calls.length = 0;
    fail = stage;
    const changed = { ...record, settled: stage === "syncSurfaces" };
    if (stage === "syncSurfaces") {
      await assert.rejects(surfaces.place(changed), /injected syncSurfaces failure/);
    } else {
      await surfaces.place(changed);
      await assert.rejects(surfaces.place({ ...changed, drawn: true }), /injected presentSurfaces failure/);
    }
    calls.length = 0;
    await surfaces.place(changed);
    await surfaces.place({ ...changed, drawn: true });
    assert.deepEqual(calls.map((call) => call.name), ["syncSurfaces", "presentSurfaces"],
      `${stage} rejection must not be reused for the next request at the same geometry`);
  }
  removeLatePrepared();
  removePrepared();
  dom.window.close();
});
