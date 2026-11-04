package workbench

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"slices"
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
	Declared *Declarations
	Calls    *Calls
	// Environment is the text of the environment declaration of the application.
	Environment []byte
	// Invalidate asks for a frame.
	Invalidate func()
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
	chromeH, headH, footH, spaceTabH, actW, actH, actIcon, noticeDot, tabsGap, tabsPad, barTabGap, barTabMaxW, tabMaxW, tabPeekW, tabMinW float32
	// debugW is the width of the debug view, and debugH its largest share of the window height.
	debugW, debugH float32
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
	read("chrome-row-h", &m.chromeH)
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
	return m, failed
}

// projectRecord is a stored project with the members that the shell shows.
type projectRecord struct {
	layout.Project
	Title, Root, Color, Identity string
	Pinned                       bool
	LastOpened                   float64
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
		member(record.Rest, "pinned", &record.Pinned), member(record.Rest, "lastOpened", &record.LastOpened))
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
	plane    *layout.Grid
	focused  string
	// fullscreen is the card that covers the plane, or "" while the cards stand in their arrangement.
	fullscreen string
	// heads holds the fit of the head that the last frame drew for each card.
	heads map[string]layout.HeadFit
	// controlsWidth is the width that the window keeps for its own buttons.
	controlsWidth float32
	held          *heldDivider
	library       libraryState
	tabs          *shellTabs
	installed     []InstalledPlugin

	settings       *SettingsStore
	settingsWindow settingsWindow
	debugView      debugViewState
	commonSettings map[string]any
	menuLanguage   string
	plugins        []LoadedPlugin
	// refused holds the ids of the installed plugins whose manifest the window refused.
	refused map[string]bool

	picker picker
	icons  map[string]*ui.SVG

	units         map[string]*installedUnit
	contributions *Contributions
	// lastDrop is the status core.drop, and notices the state of the notification center.
	lastDrop *dropRecord
	notices  *systemNotices
	surfaces surfaceState

	pluginOperations *PluginOperations
	appUpdates       *AppUpdates
	starter          pluginStarter

	page string

	text *TextSize
	// keyboard is the keyboard focus of the window, which the first responder and the views report.
	keyboard *Focus
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
	s := &Shell{cardReads: map[string]cardRead{}, options: options, metrics: read, palette: palette, registry: NewRegistry(options.Declared), calls: options.Calls,
		grid: environment.Workspace.Grid, focus: environment.Workspace.Focus, browsing: true, library: newLibraryState(), icons: map[string]*ui.SVG{}, heads: map[string]layout.HeadFit{}}
	s.text = NewTextSize(shellText{s}, steps)
	s.keyboard = NewFocus(options.Declared, func() { s.options.Invalidate() })
	s.events = NewEvents(EventsOptions{Calls: s.calls, Post: options.Post, Report: options.Report, Now: time.Now,
		After: func(delay time.Duration, task func()) { time.AfterFunc(delay, task) }})
	s.calls.Observe(s.events.Call)
	s.registry.Record(s.events.Command)
	s.errors = NewShownErrors(s.events.Error)
	s.binder = NewBinder(s.registry, func(_ string, err error) { s.fail(err) })
	s.starter = environment.pluginStarter
	s.pluginOperations = NewPluginOperations(s.calls, func() []LoadedPlugin { return s.plugins }, func() map[string]bool { return s.refused }, options.Invalidate)
	s.appUpdates = NewAppUpdates(s.calls, s.pluginOperations.State, options.Invalidate)
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
	s.page = issueID("wbn-", func(string) bool { return false })
	s.requests = NewRequests(s.registry, s.calls, options.Post, s.events.Error)
	s.linkSurfaces()
	s.registry.Status("core.workbench.error", func() any {
		if text, ok := s.errors.Text(workbenchErrorPlace); ok {
			return &text
		}
		return (*string)(nil)
	})
	s.sidebars, err = NewSidebars(SidebarsOptions{Declared: options.Declared, Registry: s.registry, Binder: s.binder,
		Environment: options.Environment, Installed: installed, Changed: s.settle, Seat: s.drawSectionSeat,
		Mounted: func(id string) bool { return s.surfaces.held[id] != nil }, Rail: func() ui.Color { return s.palette.Rail }})
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
	for _, plugin := range s.plugins {
		s.settings.Loaded(plugin.ID)
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

// shortcutConditions holds the condition of each workbench row of the shortcut table, by the text of its when. A place that the shell
// does not draw yet never holds.
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
				return
			}
			if err := s.adopt(value); err != nil {
				s.fail(err)
				return
			}
			s.openTabs(func() {
				s.showRequested(func() {
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
	s.activateThen(s.options.Project, func() {
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
	s.commonSettings = snapshot.Common
	return s.beginSettings()
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

// project returns the stored project id.
func (s *Shell) project(id string) *projectRecord {
	for i := range s.projects {
		if s.projects[i].ID == id {
			return &s.projects[i]
		}
	}
	return nil
}

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

// View draws the workbench of the window.
func (s *Shell) View(c *ui.Context) {
	s.keyboard.Frame(c)
	s.sidebars.Begin()
	clear(s.surfaces.drawn)
	clear(s.picker.drawn)
	clear(s.heads)
	clear(s.surfaces.seated)
	s.surfaces.planeDrawn = false
	width, height := c.Size()
	theme := *c.Theme()
	theme.Background = s.palette.Bg
	theme.Text = s.palette.Fg
	theme.TextMuted = s.palette.Muted
	theme.Border = s.palette.Edge
	theme.Danger = s.palette.No
	theme.FontSize = theme.Rem(1) * float32(s.text.Frame())
	c.SetTheme(&theme)
	s.keys.Declare(c)
	ui.Column(c).Size(width, height).Background(s.palette.Bg).TextColor(s.palette.Fg).Clip().Children(func() {
		s.drawChrome(c, width)
		if s.browsing || s.opened() == nil {
			s.drawLibrary(c, width, height-s.chromeHeight())
		} else {
			s.drawWork(c, width, height-s.chromeHeight())
		}
	})
	s.drawPicker(c, width, height)
	s.drawSettings(c, width, height)
	s.drawDebug(c)
	s.forgetUnseated()
	s.placeSurfaces()
	s.clearVisibleNotices()
	s.drawn = true
	s.pushStatuses()
}
