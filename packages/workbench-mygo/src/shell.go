package workbench

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"slices"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The shell of the native workbench: the chrome bar, the library, the spaces and the cards of a project. It holds the state of one
// window. Every change runs in a step of the main thread: the binder presses in the step of the frame, a command of the endpoint in
// a step of Post, and an answer of the host in the later step of Calls (docs/spec/hosts.md#workbench).

// tints are the colors of new projects, as packages/workbench/library.js holds them.
var tints = []string{"#ffb36b", "#7fe3b0", "#7db4ff", "#e08bd8", "#f2d16b"}

// ShellOptions is what a shell needs from its window.
type ShellOptions struct {
	// Now is the clock of the window.
	Now      func() time.Time
	Declared *Declarations
	Calls    *Calls
	// Environment is the text of the environment declaration of the application.
	Environment []byte
	// Invalidate asks for a frame.
	Invalidate func()
	// FirstScreen tells the window that the start shows its first screen: the library or the project of the window, or the failure
	// of the start. The window keeps the last frame of the previous workbench until then (docs/spec/native-host.md#page-start).
	FirstScreen func()
	// Backdrop sets the color of the window behind its content, which a surface without a background of its own shows.
	Backdrop func(color string) error
	// Post runs a task as a later step of the main thread.
	Post func(task func())
	// Report writes a failure of the event writer to the application log.
	Report func(line string)
	// Reload starts the workbench of the window again.
	Reload func()
	// Detaching returns the surfaces of the window whose image detach is pending, which a start of the workbench holds.
	Detaching func() []string
	// Project is the project that the address of the window names, and "" without one.
	Project string
	// Located names the project that the window shows from now on, and "" when it shows none.
	Located func(project string)
	// Elements are the elements of the window, which the element requests answer from.
	Elements Elements
	// Element returns the surface host and the key view of the surface id, for its native view element.
	Element func(id string) (surface, key uintptr, ok bool)
	// Installed is the document of the installed plugins.
	Installed []byte
	// Window reads the state of the window that core.window.workbench states.
	Window func() (WindowView, error)
	// Tabs returns the ports of the file commands, the memory saver, the tab stores and the background sessions of the shell. Without it
	// they are not registered.
	Tabs func(shell *Shell) TabPorts
}

// WindowView is the state of a window that core.window.workbench states.
type WindowView struct {
	// Visible is false while the window is minimized or not shown.
	Visible bool
	// Scale is the backing scale, and Width and Height are the content size in points.
	Scale, Width, Height float64
}

// environmentGrid is the grid of a new space of the environment declaration.
type environmentGrid struct {
	Xs    []float64         `json:"xs"`
	Ys    []float64         `json:"ys"`
	Cards []json.RawMessage `json:"cards"`
}

// metrics are the chrome metrics that the shell draws with.
type metrics struct {
	// The library (packages/workbench/library.css) and the project column (.project-column of packages/workbench).
	space1, space2, space3, space4, libraryFooterH, librarySortW, librarySearchW, libraryCardMinW, libraryCardMinWNarrow, libraryNarrowW,
	libraryPreviewH, libraryMark, libraryMarkStroke, previewLineH, previewLineStep, previewLineOpacity, previewSidebarOpacity, libraryAddH,
	libraryFormW, fieldPadY, selectArrowRoom, selectArrowInset, previewBorderMix, previewFillMix, previewInkMix, previewLineW,
	lineHeight, lineHeightTight, projectColumnW, projectColumnGap, projectColumnPad, projectTabH, projectTabPad, projectTabXInset, projectTabAddH,
	barTabRootPad, barTabRootW, barTabRootH, dropMix, dropBorder, tabDraggingOpacity, actStroke, chromeActsGap, brandGap, brandLogoAtBase, chromeH, chromeRowH, spaceGap, spacePad, chromeGap, barGap, barXPad, barXOpacity, barAddText, barAddPad, textControlAtBase, textCaptionAtBase, chipMix, chipHoverMix, chipOnMix, projectTabMix float32
	headH, footH, spaceTabH, actW, actH, actIcon, noticeDot, tabsGap, tabsPad, barTabGap, barTabMaxW, tabMaxW, tabPeekW, tabMinW float32
	// The card head (.chrome of packages/workbench/app.css).
	cardHeadGap, cardHeadPad, cardTabsGap, cardButton, cardIcon, cardActsGap, cardActsPad, cardActHalfOpacity, tabGap, tabPadY, tabPadX, tabXPad, tabXOpacity, iconStroke, disabledOpacity, noticeDotInset, radiusMiddleRatio, radiusSmallRatio, textSmallAtBase, textBase, chipSelMix, insetMix, tabXHoverMix float32
	// The error line (#applicationError of packages/workbench/app.css).
	errorPadY, errorPadX, errorBorder float32
	// debugW is the width of the debug view, and debugH its largest share of the window height.
	debugW, debugH float32
	// The grip of a divider, the dots of a folded side and the lines of the boundaries (.sp-divider, .card-sidebar__grip and .sp-rule of
	// packages/workbench/app.css).
	gripThickness, gripLength, gripMix, gripDot, gripDotSpacing, lineCrossingMix float32
	gripTransition                                                               time.Duration
}

func readMetrics(declared *Declarations) (metrics, error) {
	var m metrics
	var failed error
	read := func(name string, into *float32) {
		value, ok := declared.Metric(name)
		if !ok {
			failed = fmt.Errorf("the chrome metric %s has no number", name)
		}
		*into = float32(value)
	}
	for name, into := range map[string]*float32{"space-1": &m.space1, "space-2": &m.space2, "space-3": &m.space3, "space-4": &m.space4,
		"library-footer-h": &m.libraryFooterH, "library-sort-w": &m.librarySortW, "library-search-w": &m.librarySearchW,
		"library-card-min-w": &m.libraryCardMinW, "library-card-min-w-narrow": &m.libraryCardMinWNarrow, "library-narrow-w": &m.libraryNarrowW,
		"library-preview-h": &m.libraryPreviewH, "library-mark": &m.libraryMark, "library-mark-stroke": &m.libraryMarkStroke,
		"preview-line-h": &m.previewLineH, "preview-line-step": &m.previewLineStep, "preview-line-opacity": &m.previewLineOpacity,
		"preview-sidebar-opacity": &m.previewSidebarOpacity, "library-add-h": &m.libraryAddH, "library-form-w": &m.libraryFormW,
		"field-pad-y": &m.fieldPadY, "select-arrow-room": &m.selectArrowRoom, "select-arrow-inset": &m.selectArrowInset} {
		read(name, into)
	}
	read("line-height", &m.lineHeight)
	read("line-height-tight", &m.lineHeightTight)
	read("bar-tab-root-pad", &m.barTabRootPad)
	read("bar-tab-root-w", &m.barTabRootW)
	read("bar-tab-root-h", &m.barTabRootH)
	read("project-column-w", &m.projectColumnW)
	read("project-column-gap", &m.projectColumnGap)
	read("project-column-pad", &m.projectColumnPad)
	read("project-tab-h", &m.projectTabH)
	read("project-tab-pad", &m.projectTabPad)
	read("project-tab-x-inset", &m.projectTabXInset)
	read("project-tab-add-h", &m.projectTabAddH)
	read("drop-border", &m.dropBorder)
	read("tab-dragging-opacity", &m.tabDraggingOpacity)
	read("act-stroke", &m.actStroke)
	read("chrome-acts-gap", &m.chromeActsGap)
	read("brand-gap", &m.brandGap)
	read("brand-logo-at-base", &m.brandLogoAtBase)
	read("chrome-h", &m.chromeH)
	read("chrome-row-h", &m.chromeRowH)
	read("space-tabs-gap", &m.spaceGap)
	read("space-3", &m.spacePad)
	read("space-2", &m.chromeGap)
	read("bar-tab-gap", &m.barGap)
	read("bar-tab-x-pad", &m.barXPad)
	read("bar-tab-x-opacity", &m.barXOpacity)
	read("bar-tab-add-text", &m.barAddText)
	read("bar-tab-add-pad", &m.barAddPad)
	read("text-control-at-base", &m.textControlAtBase)
	read("text-caption-at-base", &m.textCaptionAtBase)
	read("dbg-card-w", &m.debugW)
	share, ok := declared.HeightMetric("set-card-max-h")
	if !ok {
		failed = errors.New("the chrome metric set-card-max-h has no share of the height")
	}
	m.debugH = float32(share)
	read("head-h", &m.headH)
	read("foot-h", &m.footH)
	read("space-tab-h", &m.spaceTabH)
	read("act-w", &m.actW)
	read("notice-dot", &m.noticeDot)
	read("act-h", &m.actH)
	read("act-icon", &m.actIcon)
	read("tabs-gap", &m.tabsGap)
	read("tabs-pad", &m.tabsPad)
	read("bar-tab-gap", &m.barTabGap)
	read("bar-tab-max-w", &m.barTabMaxW)
	read("tab-max-w", &m.tabMaxW)
	read("tab-peek-w", &m.tabPeekW)
	read("tab-min-w", &m.tabMinW)
	read("card-head-gap", &m.cardHeadGap)
	read("card-head-pad", &m.cardHeadPad)
	read("card-tabs-gap", &m.cardTabsGap)
	read("card-button", &m.cardButton)
	read("card-icon", &m.cardIcon)
	read("card-acts-gap", &m.cardActsGap)
	read("card-acts-pad", &m.cardActsPad)
	read("card-act-half-opacity", &m.cardActHalfOpacity)
	read("tab-gap", &m.tabGap)
	read("tab-pad-y", &m.tabPadY)
	read("tab-pad-x", &m.tabPadX)
	read("tab-x-pad", &m.tabXPad)
	read("tab-x-opacity", &m.tabXOpacity)
	read("icon-stroke", &m.iconStroke)
	read("error-pad-y", &m.errorPadY)
	read("error-pad-x", &m.errorPadX)
	read("error-border", &m.errorBorder)
	read("disabled-opacity", &m.disabledOpacity)
	read("notice-dot-inset", &m.noticeDotInset)
	read("r-xs-ratio", &m.radiusSmallRatio)
	read("r-sm-ratio", &m.radiusMiddleRatio)
	read("text-small-at-base", &m.textSmallAtBase)
	read("text-base", &m.textBase)
	mix := func(name string, into *float32) {
		value, ok := declared.Share(name)
		if !ok {
			failed = fmt.Errorf("the chrome metric %s has no share", name)
		}
		*into = float32(value)
	}
	mix("chip-sel-mix", &m.chipSelMix)
	mix("preview-border-mix", &m.previewBorderMix)
	mix("preview-fill-mix", &m.previewFillMix)
	mix("preview-ink-mix", &m.previewInkMix)
	mix("preview-line-w", &m.previewLineW)
	mix("drop-mix", &m.dropMix)
	mix("chip-mix", &m.chipMix)
	mix("chip-hover-mix", &m.chipHoverMix)
	mix("chip-on-mix", &m.chipOnMix)
	mix("project-tab-mix", &m.projectTabMix)
	mix("inset-mix", &m.insetMix)
	mix("tab-x-hover-mix", &m.tabXHoverMix)
	mix("sp-grip-mix", &m.gripMix)
	mix("sp-line-crossing-mix", &m.lineCrossingMix)
	read("sp-grip-thickness", &m.gripThickness)
	read("sp-grip-length", &m.gripLength)
	read("grip-dot", &m.gripDot)
	read("grip-dot-spacing", &m.gripDotSpacing)
	seconds, ok := declared.Seconds("grip-transition")
	if !ok {
		failed = errors.New("the chrome metric grip-transition has no time")
	}
	m.gripTransition = time.Duration(seconds * float64(time.Second))
	return m, failed
}

// projectRecord is a stored project with the members that the shell shows.
type projectRecord struct {
	layout.Project
	Title, Root, Color, Identity string
	Pinned                       bool
	LastOpened                   float64
	// Settings holds the overrides of the project, which a project that is not shown still has.
	Settings map[string]any
}

// member reads the member key of a stored project into value. A project without the member keeps the zero value.
func member[T any](members map[string]json.RawMessage, key string, value *T) error {
	raw, ok := members[key]
	if !ok {
		return nil
	}
	if err := json.Unmarshal(raw, value); err != nil {
		return fmt.Errorf("stored project member %s: %w", key, err)
	}
	return nil
}

func readProject(raw json.RawMessage) (projectRecord, error) {
	var record projectRecord
	if err := json.Unmarshal(raw, &record.Project); err != nil {
		return record, err
	}
	return record, errors.Join(member(record.Rest, "title", &record.Title), member(record.Rest, "root", &record.Root),
		member(record.Rest, "color", &record.Color), member(record.Rest, "identity", &record.Identity),
		member(record.Rest, "pinned", &record.Pinned), member(record.Rest, "lastOpened", &record.LastOpened),
		member(record.Rest, "settings", &record.Settings))
}

// Shell is the workbench of one window.
type Shell struct {
	// cardReads holds the decoded data of the cards, and railRead the last rail outline.
	cardReads map[string]cardRead
	railRead  railRead
	options   ShellOptions
	// drawn tells that a frame of this start of the workbench drew the shell.
	drawn    bool
	metrics  metrics
	palette  Palette
	registry *Registry
	binder   *Binder
	keys     *Shortcuts
	calls    *Calls
	requests *Requests
	errors   *ShownErrors
	sidebars *Sidebars
	// operated holds the side of each axis of each card that was operated last, for the time the plane stands.
	operated map[string]map[string]layout.Side
	grip     *heldGrip
	events   *Events
	grid     environmentGrid
	focus    string

	browsing bool
	projects []projectRecord
	active   string
	// windowProjects are the projects that the window opened: their hidden tabs stay surfaces of the window (docs/spec/plugins.md#memory-saver).
	windowProjects map[string]bool
	// otherOpen are the projects that the store last named as owned by a window.
	otherOpen map[string]bool
	// savedGeometry is the geometry that this window last stored for each project.
	savedGeometry map[string]json.RawMessage
	plane         *layout.Grid
	focused       string
	// columnsChanged tells that the next frame matches the columns of the window sidebars to the settings.
	columnsChanged bool
	// fullscreen is the card that covers the plane, or "" while the cards stand in their arrangement.
	fullscreen string
	// strips holds the scroll of the tab strip of each card.
	strips map[string]*stripPlace
	// heads holds the fit of the head that the last frame drew for each card.
	heads map[string]layout.HeadFit
	// tabsNamed is how many tabs the shown layout has named; a new tab takes the next number.
	tabsNamed int
	// renaming is the rename of a project or a space in progress.
	renaming *rename
	// doublePressed is the tab whose second press of a double click has not been released.
	doublePressed renameTarget
	// dragging is the drag of a tab in progress.
	dragging *tabDrag
	// workBanner is the height of the error line over the row of the spaces in the last drawing.
	workBanner float32
	// controlsWidth is the width that the window keeps for its own buttons.
	controlsWidth float32
	held          *heldDivider
	drag          *boundaryDrag
	library       libraryState
	tabs          *shellTabs
	installed     []InstalledPlugin

	settings       *SettingsStore
	settingsWindow settingsWindow
	debugView      debugViewState
	// Diagnostic listing input belongs to this shell lifetime, not the live log store.
	debugFixtureEntries []DebugEntry
	debugFixtureActive  bool
	menuLanguage        string
	plugins             []LoadedPlugin
	// refused holds the ids of the installed plugins whose manifest the window refused.
	refused map[string]bool
	// settingsActor is the command of the settings change that runs.
	settingsActor string

	picker picker
	icons  map[string]*ui.SVG
	// backgroundTold is the value that the host last received of the background of a dialog.
	backgroundTold bool
	// windowSidebars holds the widths of the fixed sidebars of the shown space, which outlive their columns.
	windowSidebars map[string]layout.WindowSidebar

	units         map[string]*installedUnit
	processes     pluginProcesses
	contributions *Contributions
	// lastDrop is the status core.drop, and notices the state of the notification center.
	lastDrop *dropRecord
	notices  *systemNotices
	surfaces surfaceState

	pluginOperations *PluginOperations
	appUpdates       *AppUpdates
	starter          pluginStarter

	text *TextSize
	// planeSpace is the id of the space that the plane was last made of.
	planeSpace string
	// exposedFocus is the keyboard focus of the window, which the first responder and the views report.
	exposedFocus *Focus
	// keyboard is what the workbench asked of the host about the keyboard.
	keyboard keyboardState
	// frameRequests counts the frames that the shell asked for, so a command reads whether its run asked for one. A part of the
	// shell may ask from another goroutine.
	frameRequests atomic.Int64
	pointer       *PointerSequence
	verification  *Verification
	// verifying tells that the step that gives a watcher the verification waits to run, and building that a frame builds.
	verifying, building bool
	// A View build shares one native window observation, including its error.
	// The fields are cleared at both boundaries and never serve outside View.
	frameWindowRead    bool
	frameWindow        WindowView
	frameWindowFailure error
	// diagnostics holds the policy and the trace switch that the host received last, and the requests of the switch that wait.
	diagnostics struct {
		policy, trace string
		switches      []traceSwitch
	}
	// drawnSize is the size of the window that the last frame drew, which tells a frame that the window was resized.
	drawnSize [2]float32
	// started is set once the host took the first state of the shell, changed once plugins changed before that, and reloading while the
	// shell saves before a reload. They belong to the main thread.
	started, changed, reloading bool
}

// NewShell returns the shell of a window, with its commands in the registry.
func NewShell(options ShellOptions) (*Shell, error) {
	read, err := readMetrics(options.Declared)
	if err != nil {
		return nil, err
	}
	palette, err := options.Declared.DefaultPalette()
	if err != nil {
		return nil, err
	}
	steps, err := TextSteps()
	if err != nil {
		return nil, err
	}
	var environment struct {
		pluginStarter
		Workspace struct {
			Focus string          `json:"focus"`
			Grid  environmentGrid `json:"grid"`
		} `json:"workspace"`
	}
	if err := json.Unmarshal(options.Environment, &environment); err != nil {
		return nil, fmt.Errorf("environment declaration: %w", err)
	}
	s := &Shell{windowProjects: map[string]bool{}, savedGeometry: map[string]json.RawMessage{}, cardReads: map[string]cardRead{}, options: options, metrics: read, palette: palette, registry: NewRegistry(options.Declared), calls: options.Calls,
		grid: environment.Workspace.Grid, focus: environment.Workspace.Focus, browsing: true, library: newLibraryState(), strips: map[string]*stripPlace{}, icons: map[string]*ui.SVG{}, heads: map[string]layout.HeadFit{}}
	// Every frame that the shell asks for passes this count: a command answers after the frame that its run asked for.
	invalidate := options.Invalidate
	s.options.Invalidate = func() {
		s.frameRequests.Add(1)
		invalidate()
	}
	s.text = NewTextSize(shellText{s}, steps)
	s.exposedFocus = NewFocus(options.Declared, func() { s.options.Invalidate() })
	s.verification = NewVerification()
	s.events = NewEvents(EventsOptions{Calls: s.calls, Post: options.Post, Report: options.Report, Now: time.Now,
		After: func(delay time.Duration, task func()) { time.AfterFunc(delay, task) }})
	s.calls.Observe(s.events.Call)
	s.registry.Record(s.events.Command)
	s.registry.Follow(s.followCommand)
	s.errors = NewShownErrors(s.events.Error)
	s.binder = NewBinder(s.registry, func(_ string, err error) { s.fail(err) })
	s.pointer = NewPointerSequence(options.Elements, func() { s.options.Invalidate() }, s.fail)
	s.pointer.released = s.keyboardPressed
	s.binder.Attach(s.pointer, s.exposedFocus)
	s.starter = environment.pluginStarter
	s.pluginOperations = NewPluginOperations(s.calls, s.events.BeginOperation, func() []LoadedPlugin { return s.plugins }, func() map[string]bool { return s.refused }, s.options.Invalidate)
	s.appUpdates = NewAppUpdates(s.calls, s.events.BeginOperation, s.pluginOperations.State, s.options.Invalidate)
	s.registry.Elements(options.Elements)
	// An installation that cannot be read has no installed plugin, and the window shows why (docs/spec/installation.md#serving-installed-plugins).
	installed, refused, err := acceptInstalled(options.Installed)
	s.refused = refused
	if err != nil {
		s.fail(err)
	}
	if s.installed, err = readInstalled(installed); err != nil {
		s.fail(err)
		installed = []byte(`{"plugins":[]}`)
	}
	if s.units, err = readSurfaceUnits(installed); err != nil {
		return nil, err
	}
	s.contributions = NewContributions()
	if err := s.contributions.Install(s.installed); err != nil {
		return nil, err
	}
	s.surfaces = newSurfaceState()
	s.notices = newSystemNotices()
	s.registry.Status("core.drop", func() any { return s.lastDrop })
	s.registry.Status("core.notifications", func() any {
		return notificationStatus{Authorization: s.notices.authorization, Error: s.notices.failure, Posted: slices.Clone(s.notices.accepted)}
	})
	s.requests = NewRequests(s.registry, s.calls, options.Post, s.events.Error)
	s.linkSurfaces()
	s.registry.Status("core.workbench.error", func() any {
		if text, ok := s.errors.Text(workbenchErrorPlace); ok {
			return &text
		}
		return (*string)(nil)
	})
	s.sidebars, err = NewSidebars(SidebarsOptions{Declared: options.Declared, Registry: s.registry, Binder: s.binder,
		Look:        func() (float32, float32) { return s.palette.BorderWidth, s.textCaption() },
		Environment: options.Environment, Installed: installed, Changed: s.settle, Seat: s.drawSectionSeat,
		Progress: s.sectionProgress, Rail: func() ui.Color { return s.palette.Rail }})
	if err != nil {
		return nil, err
	}
	s.settingsWindow = newSettingsWindow()
	var definitions []SettingDefinition
	if s.plugins, definitions, err = readLoadedPlugins(installed, options.Environment); err != nil {
		return nil, err
	}
	if s.settings, err = NewSettingsStore(definitions, s.settingsSave); err != nil {
		return nil, err
	}
	if err = s.settings.SidebarDefaults(s.sidebars.Declared()); err != nil {
		return nil, err
	}
	for _, plugin := range s.plugins {
		s.settings.Loaded(plugin)
	}
	s.register()
	s.registerStatuses()
	if options.Tabs != nil {
		s.connectTabs(options.Tabs(s))
	}
	s.keys, err = NewShortcuts(options.Declared.Shortcuts, s.shortcutConditions(), func(command string) error {
		_, err := s.registry.Run(command, nil)
		return err
	}, func(_ string, err error) { s.fail(err) })
	if err != nil {
		return nil, err
	}
	return s, nil
}

// shortcutConditions holds the condition of each workbench row of the shortcut table, by the text of its when. A row whose place
// takes its key with its own handler never holds, as the field and the layer of the page take theirs, and that handler runs the
// command of the row: the rename field takes Enter with its submit and Escape with its input handler (drawRenameField), and the
// popover of the picker layer takes Escape and runs core.picker.close (drawPicker). The focused element and an overlay receive a
// key ahead of the shortcuts of the window, so a binding of those rows would be a second handler of the key. This shell shows no
// native modal menu, because it draws the picker itself and keeps the keyboard, and it always runs with the chrome of a host.
func (s *Shell) shortcutConditions() map[string]func() bool {
	never := func() bool { return false }
	library := func() bool { return s.browsing || s.opened() == nil }
	return map[string]func() bool{
		"No host chrome (browser build)":                     never,
		"A card has the focus":                               func() bool { return !library() && s.focused != "" },
		"The library is shown":                               library,
		"The tab rename field has focus":                     never,
		"A library form field has focus":                     func() bool { return library() && s.library.formMode != "" },
		"A picker layer is open":                             never,
		"A native modal menu is open and has keyboard focus": never,
	}
}

// Registry is the registry of the window, which the exposure of the window answers from.
func (s *Shell) Registry() *Registry { return s.registry }

// Start tells the host that the workbench of the window starts, reads the workspace and tells the host that the window takes events.
func (s *Shell) Start() {
	s.surfaces.holdDetaching(s.options.Detaching())
	s.events.Begin(func() {
		s.calls.CallInOrder("workspace", "workspace", map[string]string{"kind": "snapshot"}, func(value any, err error) {
			if err != nil {
				s.fail(err)
				s.options.FirstScreen()
				return
			}
			if err := s.adopt(value); err != nil {
				s.fail(err)
				s.options.FirstScreen()
				return
			}
			s.openTabs(func() {
				s.showRequested(func() {
					s.options.FirstScreen()
					s.calls.Call("windowReady", nil, func(_ any, err error) {
						if err != nil {
							s.fail(err)
						}
						s.options.Invalidate()
						s.startNotices(func() {
							s.startPlugins(func(installed bool) {
								s.started = true
								// After the application restarts or the window fails, the sessions of surfaces in no layout end.
								s.retainSessions()
								if s.changed || installed {
									s.pluginsChanged()
								}
							})
						})
					})
				})
			})
		})
	})
}

// showRequested shows the project that the address of the window names and then runs done. A window whose project is gone, or
// whose project cannot be opened, starts at the library.
func (s *Shell) showRequested(done func()) {
	if s.options.Project == "" {
		done()
		return
	}
	if s.project(s.options.Project) == nil {
		s.options.Located("")
		done()
		return
	}
	s.activateThen(s.options.Project, func(err error) {
		s.failed(err)
		if s.active == "" {
			s.options.Located("")
		}
		done()
	})
}

// adopt takes the projects of a workspace snapshot.
func (s *Shell) adopt(value any) error {
	snapshot, err := decode[struct {
		Projects      []json.RawMessage `json:"projects"`
		Open          []string          `json:"open"`
		ProjectsError *string           `json:"projectsError"`
		Common        map[string]any    `json:"common"`
	}](value)
	if err != nil {
		return err
	}
	if snapshot.ProjectsError != nil {
		return fmt.Errorf("%s", *snapshot.ProjectsError)
	}
	projects := make([]projectRecord, 0, len(snapshot.Projects))
	for _, raw := range snapshot.Projects {
		record, err := readProject(raw)
		if err != nil {
			return err
		}
		projects = append(projects, record)
	}
	s.projects = projects
	s.takeOpen(snapshot.Open)
	return s.beginSettings(snapshot.Common)
}

// decode reads the answer of a host call, which is the value of the handler or its JSON text.
func decode[T any](value any) (T, error) {
	var out T
	encoded, err := json.Marshal(value)
	if err != nil {
		return out, err
	}
	return out, json.Unmarshal(encoded, &out)
}

// fail shows err in the place of the screen and asks for a frame.
func (s *Shell) fail(err error) {
	s.errors.Show(workbenchErrorPlace, err.Error(), "")
	s.options.Invalidate()
}

// failed shows err as fail does, and nothing without an error: the end of an operation whose caller has no answer to carry it.
func (s *Shell) failed(err error) {
	if err != nil {
		s.fail(err)
	}
}

// project returns the stored project id.
func (s *Shell) project(id string) *projectRecord {
	for i := range s.projects {
		if s.projects[i].ID == id {
			return &s.projects[i]
		}
	}
	return nil
}

// takeOpen takes the projects that a workspace snapshot names as owned by a window.
func (s *Shell) takeOpen(ids []string) {
	s.otherOpen = make(map[string]bool, len(ids))
	for _, id := range ids {
		s.otherOpen[id] = true
	}
}

// isOpen tells whether a window holds the project id, this window or another, as projects.isOpen does.
func (s *Shell) isOpen(id string) bool { return s.windowProjects[id] || s.otherOpen[id] }

// opened returns the project that the window shows, or nil.
func (s *Shell) opened() *projectRecord { return s.project(s.active) }

// issueID returns a new id of the form of packages/workbench/ids.js: three letters and six base32 characters.
func issueID(prefix string, taken func(id string) bool) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567"
	for {
		random := make([]byte, 6)
		if _, err := rand.Read(random); err != nil {
			panic(err) // crypto/rand.Read ends the program itself on a platform that fails.
		}
		id := []byte(prefix)
		for _, value := range random {
			id = append(id, alphabet[int(value)%len(alphabet)])
		}
		if !taken(string(id)) {
			return string(id)
		}
	}
}

func (s *Shell) newProjectID() string {
	return issueID("prj-", func(id string) bool { return s.project(id) != nil })
}

func (s *Shell) newSpaceID() string {
	return issueID("spc-", func(id string) bool {
		for _, project := range s.projects {
			for _, space := range project.Spaces {
				if space.ID == id {
					return true
				}
			}
		}
		return false
	})
}

func (s *Shell) newTabID() string {
	return issueID("tab-", func(id string) bool {
		for _, project := range s.projects {
			// silent: a space whose layout cannot be read has no tab id that a new id could repeat in the shown plane.
			ids, _ := layout.SpaceTabIDs(&project.Project)
			for _, known := range ids {
				if known == id {
					return true
				}
			}
		}
		return s.planeHasTab(id) || s.surfaces.detachHeld(id)
	})
}

// baseName is the title of a new project of the folder root.
func baseName(root string) string { return path.Base(root) }

// windowView observes the public window port once within a View build. Outside
// that build every caller observes current state; an error is never a fallback.
func (s *Shell) windowView() (WindowView, error) {
	if !s.building {
		return s.options.Window()
	}
	if !s.frameWindowRead {
		s.frameWindow, s.frameWindowFailure = s.options.Window()
		s.frameWindowRead = true
	}
	return s.frameWindow, s.frameWindowFailure
}

// traceSize stores the action marker of a window that changed its size (docs/spec/performance-trace.md#producers), as the resize
// listener of packages/workbench/core-exposure.js does: the first frame sets the size, which is no resize.
func (s *Shell) traceSize(width, height float32) {
	size := [2]float32{width, height}
	if size == s.drawnSize {
		return
	}
	if s.drawnSize != ([2]float32{}) {
		s.events.Trace("action", func() map[string]any { return map[string]any{"kind": "resize", "width": width, "height": height} })
	}
	s.drawnSize = size
}

// View draws the workbench of the window.
func (s *Shell) View(c *ui.Context) {
	s.frameWindowRead = false
	s.frameWindow = WindowView{}
	s.frameWindowFailure = nil
	s.building = true
	defer func() {
		s.building = false
		s.frameWindowRead = false
		s.frameWindow = WindowView{}
		s.frameWindowFailure = nil
	}()
	s.exposedFocus.Frame(c)
	s.sidebars.Begin()
	clear(s.surfaces.drawn)
	s.surfaces.shown = s.surfaces.shown[:0]
	clear(s.picker.drawn)
	clear(s.heads)
	clear(s.surfaces.seated)
	s.surfaces.drawnPlane, s.surfaces.drawnLibrary = nil, false
	width, height := c.Size()
	s.traceSize(width, height)
	theme := *c.Theme()
	theme.Background = s.palette.Bg
	theme.Text = s.palette.Fg
	theme.TextMuted = s.palette.Muted
	theme.Border = s.palette.Edge
	theme.Danger = s.palette.No
	theme.FontSize = theme.Rem(1) * float32(s.text.Frame())
	theme.Font = s.fontFamily()
	// The outline of button:focus-visible of the page: inside the edge, in the focus color.
	outline := s.options.Declared.ChromeNumber("focus-outline", "px")
	theme.Focus, theme.FocusRingWidth, theme.FocusRingOffset = s.palette.Focus, float32(outline), -float32(outline)
	c.SetTheme(&theme)
	s.keys.Declare(c)
	// Korean breaks at the spaces, as body of packages/workbench/app.css says. It is inherited, except by an overlay, whose root takes it.
	root := s.binder.Watched(ui.Column(c).Size(width, height).Background(s.palette.Bg).TextColor(s.palette.Fg).KeepAll().Clip())
	if s.dialogOpen() {
		// Kept: the workbench behind the dialog changes nothing while the dialog scrolls or types, so its blurred layer is drawn
		// again only when it changes, and a frame of the dialog redraws the dialog alone.
		root.Blur(s.dialogBlur()).Cache()
	}
	root.Children(func() {
		s.drawChrome(c, width)
		if s.browsing || s.opened() == nil {
			s.drawLibrary(c, width, height-s.chromeHeight())
		} else {
			s.drawWorkArea(c, width, height-s.chromeHeight())
		}
	})
	s.drawViewsBehindDialog(c)
	s.drawPicker(c, width, height)
	s.drawSettings(c, width, height)
	s.drawDebug(c)
	s.tellBackground()
	s.forgetUnseated()
	s.observeSections()
	s.holdHiddenTabs()
	s.followKeyboard(true)
	s.placeSurfaces()
	s.followKeyboard(false)
	s.clearVisibleNotices()
	s.drawn = true
	s.pushStatuses()
	s.verifyLater()
}
