// The core.surfaces entries of the mounted views that the compositor record does not hold (docs/spec/exposure.md#core-statuses).

/**
 * The kind of a surface and the sidebar of a section surface, as core.surfaces reports them (docs/spec/plugins.md#sections): a
 * descriptor with a section is a section surface of that sidebar, and any other is a tab surface with sidebar null.
 */
export function surfaceKindOf(descriptor) {
  // default: a tab descriptor has no section.
  const section = descriptor.section ?? null;
  return section === null ? { kind: "tab", sidebar: null } : { kind: "section", sidebar: section.sidebar };
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
