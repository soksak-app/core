// The composition kind of a surface, as core.surfaces reports it (docs/spec/plugins.md#view-surfaces).

/** Returns the kind of the composition of a surface declaration, or null when there is no declaration. */
export function compositionKindOf(declaration) {
  return declaration?.composition?.kind ?? null;
}
