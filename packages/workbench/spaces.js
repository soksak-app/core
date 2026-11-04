// The spaces of a stored project record (docs/spec/projects.md#persistence): the functions that read and change the spaces, the
// active space and the space counter of one record. They do not touch the plane or the store; projects.js checks and keeps the
// layouts around them. The Go layout model of packages/workbench-mygo meets the same cases (docs/spec/cases/layout/spaces.json).

/** The space id of project. An id that is not a space of project is an error. */
export function spaceIn(project, id) {
  const space = project.spaces.find((s) => s.id === id);
  if (!space) throw new Error(`Unknown space: ${id}`);
  return space;
}

/** Adds a space with id and layout after the others, names it by the next value of the counter, makes it active and returns it. */
export function appendSpace(project, id, layout) {
  const space = { id, title: `SPACE${++project.named}`, layout };
  project.spaces.push(space);
  project.activeSpaceId = space.id;
  return space;
}

/**
 * What closing the space id does: its index `at`, and `next`, the space that becomes active when id is the active space, or null when
 * the active space stays. It is null when id is the only space, which is not closed. An unknown id is an error.
 */
export function closingSpace(project, id) {
  if (project.spaces.length === 1) return null;
  const at = project.spaces.findIndex((s) => s.id === id);
  if (at < 0) throw new Error(`Unknown space: ${id}`);
  const rest = project.spaces.filter((s) => s.id !== id);
  return { at, next: id === project.activeSpaceId ? rest[Math.min(at, rest.length - 1)] : null };
}

/** Closes the space id as closingSpace describes and returns it, or null when it is the only space. */
export function removeSpace(project, id) {
  const closing = closingSpace(project, id);
  if (!closing) return null;
  const [removed] = project.spaces.splice(closing.at, 1);
  if (closing.next) project.activeSpaceId = closing.next.id;
  return removed;
}

/** Renames the space id. An unknown id is an error. */
export function renameSpace(project, id, title) {
  spaceIn(project, id).title = title;
}

/** The tab ids of the layouts of all spaces of project, in the order of the spaces, their cards and their tabs. */
export function spaceTabIds(project) {
  // default: a seat card has null data, so it has no tabs.
  return project.spaces.flatMap((space) => space.layout.state.cards.flatMap((card) => (card.data?.tabs ?? []).map((tab) => tab.id)));
}
