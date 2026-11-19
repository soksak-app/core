export { Soksak, checkState } from './soksak.js';
export type {
  Axis,
  Card,
  CardInit,
  Divider,
  Fill,
  FillOrder,
  Paid,
  Rect,
  Rule,
  Side,
  SnapMode,
  SoksakOptions,
  SoksakState,
  Zone,
  ZoneHit,
  ZoneOptions,
} from './soksak.js';

export { contains, outline, roundedPath, unionLoops } from './outline.js';
export type { Outline, OutlineOptions, Point } from './outline.js';

export { SoksakView } from './dom.js';
export type { ChangeReason, ViewOptions } from './dom.js';

/** The view names what it draws; the host sets the colours. */
export { installTheme, themeCSS, themeTokens } from './theme.js';
export type { ThemeMetrics, ThemeOptions, ThemePalette } from './theme.js';

/** The span of a card, which is all `isSlicing` needs to answer. */
export type { Span } from './slicing.js';

/** The slicing tree of an arrangement, which `balance()` reads. */
export { sliceTree } from './balance.js';
export type { Slice } from './balance.js';
