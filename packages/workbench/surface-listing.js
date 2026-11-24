// The core.surfaces entries of the mounted views that the compositor record does not hold (docs/spec/exposure.md#plugin-processes).
import { stateCards } from "./layout-tree.js";

/**
 * The kind of a surface, the sidebar of a section surface and the dialog of a dialog surface, as core.surfaces reports them
 * (docs/spec/plugins.md#sections, docs/spec/plugins.md#dialogs): a descriptor with a section is a section surface of that sidebar, a
 * descriptor with a dialog is the dialog surface {name, opener}, and any other is a tab surface with sidebar and dialog null.
 */
export function surfaceKindOf(descriptor) {
  // default: a tab descriptor has no section and no dialog.
  const section = descriptor.section ?? null;
  // default: a tab or a section descriptor has no dialog.
  const dialog = descriptor.dialog ?? null;
  if (dialog !== null) return { kind: "dialog", sidebar: null, dialog: { name: dialog.name, opener: dialog.opener } };
  return section === null ? { kind: "tab", sidebar: null, dialog: null } : { kind: "section", sidebar: section.sidebar, dialog: null };
}

/**
 * Returns the entries of the mounted views whose surface is not in the seated record. Only a view composition is a retained
 * view; a mount of another composition is not listed. A retained view has no placement, so visible is false and dim, declared
 * and applied are null. Each mount carries the exposes, composition, state, kind and sidebar that core.surfaces reports for it.
 */
export function retainedSurfaceEntries(mounts, seatedIds) {
  if (!Array.isArray(mounts) || !(seatedIds instanceof Set)) {
    throw new TypeError("retained surfaces require the mounted views and the set of seated surface ids");
  }
  return mounts.filter((mount) => mount.composition === "view" && !seatedIds.has(mount.surface)).map((mount) => ({
    surface: mount.surface, plugin: mount.plugin, visible: false, dim: null, declared: null, applied: null,
    exposes: mount.exposes, status: mount.status, placeholder: null, composition: mount.composition, state: mount.state,
    kind: mount.kind, sidebar: mount.sidebar,
  }));
}

/**
 * Returns each tab of the stored layouts of the spaces of projects with its card and the holder that names its space and project,
 * as { tab, card, holder }. skip(project, space) leaves out a space whose layout the current plane holds.
 */
export function storedSpaceTabs(projects, skip) {
  const out = [];
  for (const project of projects) {
    for (const space of project.spaces) {
      if (skip(project, space)) continue;
      for (const card of stateCards(space.layout.state)) {
        // default: a stored card without data holds no tabs (stateCards of layout-tree.js names data optional).
        for (const tab of card.data?.tabs ?? []) out.push({ tab, card, holder: `the stored layout of space ${space.id}, project ${project.id}` });
      }
    }
  }
  return out;
}
