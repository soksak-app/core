// Applies settings in the order defaults, common values, project overrides.

export function effectiveSettings(defaults, common, project) {
  const values = { ...defaults, ...common, ...project };
  // default: projectOpening has only a common value, and it is the default when it has not been stored.
  values.projectOpening = common.projectOpening ?? defaults.projectOpening;
  return values;
}
