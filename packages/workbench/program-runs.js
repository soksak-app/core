// The program runs of a view (docs/spec/native-surfaces.md#program-runs). The page passes the view call runtime.program.run to the host
// command programRun, and the cancel of an open run to the host command programCancel. The host reads the programs of a surface from
// its sync request, so a run of a name that the declaration lacks is refused by the host.

/**
 * The member of a view surface in the sync request that declares its programs: {programs} when the plugin declares them, and nothing
 * for a surface without a view or without programs (docs/spec/plugins.md#pluginjson).
 */
export function programsOfSurface(surface) {
  if (surface?.composition?.kind !== "view" || !surface.programs) return {};
  return { programs: surface.programs };
}

/**
 * The program runs of the view surface, where send(name, payload) sends a host command of the surface and resolves with its answer.
 * run(id, name, args) sends programRun and resolves with its answer. A run is open from its request until its answer or its cancel;
 * cancel(id) sends programCancel for an open run and sends nothing for a call that is not an open run.
 */
export function createProgramRuns(surface, send) {
  const open = new Set();
  return {
    run(id, name, args) {
      open.add(id);
      return send("programRun", { surface, id, name, args }).finally(() => open.delete(id));
    },
    isOpen: (id) => open.has(id),
    cancel(id) {
      if (!open.delete(id)) return Promise.resolve(null);
      return send("programCancel", { surface, id });
    },
  };
}
