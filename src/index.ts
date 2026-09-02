export { Soksak } from './soksak.js';
export type {
  Axis,
  Card,
  CardInit,
  Divider,
  Fill,
  FillOrder,
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

/** The span of a card, which is all `isSlicing` needs to answer. */
export type { Span } from './slicing.js';
