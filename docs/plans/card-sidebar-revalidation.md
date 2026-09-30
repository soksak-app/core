# Card sidebar implementation and revalidation plan

Status: accepted direction; implementation and application acceptance remain pending. The canonical task checklist is [features](../features.md). This proposal describes pending work; incorporated contracts belong in the specifications.

## Required model

A card contains content and optional top, bottom, left, and right sidebars. Each sidebar displays an ordered set of sections. Plugins provide sections, default sets, and default side assignments. Core owns the fixed four-side layout, sizing, folding, persistence, native placement, and input. There is no arbitrary user-defined card grid. Top and bottom span the content area's width; left and right flank the center. Absent sides reserve no space, and content fills the remainder.

An explicit per-card set survives active-tab plugin changes. Without an explicit assignment, the active plugin supplies the default. Folding or resizing a default-derived sidebar stores layout state independently and does not create an explicit set assignment. Clearing an explicit assignment reveals the default.

Optional plugin `sidebars` declarations contain sets and a `card` mapping from the four sides to default set IDs. Local IDs become `<plugin>.<local>`. Sets may compose other installed plugins' declared sections through manifests. Normalize defaults into environment sets and links before applying existing application, global, and project whole-list overrides. Resolution must not restore defaults removed by an override.

A section's `module` is either one shared module string or an object containing both `horizontal` and `vertical` module paths. Core selects horizontal for top/bottom and vertical for left/right and window sidebars. Context and reported state include orientation. An orientation change disposes the old implementation before mounting the new one. Invalid or missing declarations fail explicitly; there is no fallback. Retain list and tabs layouts, with arrangement and remaining-space allocation owned by core.

Use one command family: `core.card.sidebar.set`, `core.card.sidebar.toggle`, and `core.card.sidebar.size`, each with a side. Remove separate panel and inset-left paths. Expose effective set, size, collapsed state, orientation, and measurable geometry for each side.

Remove focus-dependent external flow/pin positioning and special rail identities. Retain rail only as the border for a plugin-declared window left/right sidebar and its associated card: draw one outer border when adjacent and separate borders when detached. Stable window sidebars must not change position, width, or visibility merely because focus or the active tab changes. Reject obsolete settings and IDs without compatibility paths. Document the association and adjacency criterion in the canonical specification; border grouping must not move or resize either participant.

## Execution order

1. Preserve and separate existing uncommitted patches. Register distinct native-registry lifetime, Wails fixture-readiness, and compositor-placement findings in the canonical checklist. Preserve original failures; the current compositor test's undeclared `inset` input must be replaced with the actual observation contract.
2. Resolve the native registry lifetime defect with an owning pre-fix Red, the same Green, and newly split terminal observation on both rebuilt hosts. Diagnose Wails readiness independently rather than attributing it to this defect.
3. Implement V5-117-1: canonical card sidebars, plugin defaults, independent layout state, unified commands, and removal of focus-dependent external positioning, and adjacent/detached rail borders. Revalidate V5-116-4 linked-side operations against this final model.
4. Implement V5-117-2: paired orientation declarations, validation, staging, selection, lifecycle, context, and actual rendered output.
5. Complete V5-115-1 geometry and full recorded gestures, V5-116-5 contracts and composition combinations, and V5-114-1 real-event address-focus revalidation. Activation-tier checks retain the existing approval requirement.

## Acceptance evidence

Owning tests must cover defaults, explicit precedence, tab changes, independent persisted fold/size state, invalid-input state preservation, both module forms, staging rejection, lifecycle disposal, and cross-plugin section composition through declared boundaries.

Rebuild both hosts and identify the tested binaries and sidecars. Observe complete gestures at the requested 60 fps and derive machine-checkable sidebar, DOM slot, and native geometry assertions. Missing frames or input fail acceptance. Focus and tab changes must leave window-sidebar geometry unchanged; configuration changes are tested separately. Measure adjacent and detached border bounds without changing participant geometry. Real-event focus checks assert zero browser-address focus transitions and the target native responder. Remove check recordings after inspection.

Earlier commits and structural checks do not establish application success. Preserve every first failure and distinguish native-unit success from observed application acceptance. Pending evidence remains unresolved. Update specifications, matching translations, checklist evidence, and changelog to the implementation actually tested.
