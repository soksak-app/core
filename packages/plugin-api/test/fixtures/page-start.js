// The page module of a view that reads its start values when it loads, as a plugin page does. A view opened without start values
// has no window.sokSurface, so the load of this module is refused.
export const declarations = window.sokSurface.declarations;
