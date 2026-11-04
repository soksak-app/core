package workbench

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"path"

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
	// Report writes a line of a shown error to the application log.
	Report func(line string)
	// Seat draws what stands in the slot of a card. Without it the slot stays empty.
	Seat Seat
}

// Seat draws the surface of the active tab of a card in the box of the slot, in window coordinates.
type Seat func(c *ui.Context, card string, tab layout.Tab, box layout.Rect)

// environmentGrid is the grid of a new space of the environment declaration.
type environmentGrid struct {
	Xs    []float64         `json:"xs"`
	Ys    []float64         `json:"ys"`
	Cards []json.RawMessage `json:"cards"`
}

// metrics are the chrome metrics that the shell draws with.
type metrics struct {
	chromeH, headH, footH, spaceTabH, actW, actH, actIcon, tabsGap, tabsPad, barTabGap, barTabMaxW, tabPeekW, tabMinW float32
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
	read("head-h", &m.headH)
	read("foot-h", &m.footH)
	read("space-tab-h", &m.spaceTabH)
	read("act-w", &m.actW)
	read("act-h", &m.actH)
	read("act-icon", &m.actIcon)
	read("tabs-gap", &m.tabsGap)
	read("tabs-pad", &m.tabsPad)
	read("bar-tab-gap", &m.barTabGap)
	read("bar-tab-max-w", &m.barTabMaxW)
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
	options  ShellOptions
	metrics  metrics
	palette  Palette
	registry *Registry
	binder   *Binder
	calls    *Calls
	requests *Requests
	errors   *ShownErrors
	grid     environmentGrid
	focus    string

	browsing bool
	projects []projectRecord
	active   string
	plane    *layout.Grid
	focused  string
	held     *heldDivider
	library  libraryState
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
	var environment struct {
		Workspace struct {
			Focus string          `json:"focus"`
			Grid  environmentGrid `json:"grid"`
		} `json:"workspace"`
	}
	if err := json.Unmarshal(options.Environment, &environment); err != nil {
		return nil, fmt.Errorf("environment declaration: %w", err)
	}
	s := &Shell{options: options, metrics: read, palette: palette, registry: NewRegistry(options.Declared), calls: options.Calls,
		grid: environment.Workspace.Grid, focus: environment.Workspace.Focus, browsing: true, library: newLibraryState()}
	s.errors = NewShownErrors(options.Report)
	s.binder = NewBinder(s.registry, func(_ string, err error) { s.fail(err) })
	s.requests = NewRequests(s.registry, s.calls, options.Post, options.Report)
	s.register()
	return s, nil
}

// Registry is the registry of the window, which the exposure of the window answers from.
func (s *Shell) Registry() *Registry { return s.registry }

// Start reads the workspace and tells the host that the window takes events.
func (s *Shell) Start() {
	s.calls.CallInOrder("workspace", "workspace", map[string]string{"kind": "snapshot"}, func(value any, err error) {
		if err != nil {
			s.fail(err)
			return
		}
		if err := s.adopt(value); err != nil {
			s.fail(err)
			return
		}
		s.calls.Call("windowReady", nil, func(_ any, err error) {
			if err != nil {
				s.fail(err)
			}
			s.options.Invalidate()
		})
	})
}

// adopt takes the projects of a workspace snapshot.
func (s *Shell) adopt(value any) error {
	snapshot, err := decode[struct {
		Projects      []json.RawMessage `json:"projects"`
		ProjectsError *string           `json:"projectsError"`
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
	return nil
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
		return s.planeHasTab(id)
	})
}

// baseName is the title of a new project of the folder root.
func baseName(root string) string { return path.Base(root) }

// View draws the workbench of the window.
func (s *Shell) View(c *ui.Context) {
	width, height := c.Size()
	theme := *c.Theme()
	theme.Background = s.palette.Bg
	theme.Text = s.palette.Fg
	theme.TextMuted = s.palette.Muted
	theme.Border = s.palette.Edge
	theme.Danger = s.palette.No
	c.SetTheme(&theme)
	ui.Column(c).Size(width, height).Background(s.palette.Bg).TextColor(s.palette.Fg).Clip().Children(func() {
		s.drawChrome(c, width)
		if s.browsing || s.opened() == nil {
			s.drawLibrary(c, width, height-s.metrics.chromeH)
			return
		}
		s.drawWork(c, width, height-s.metrics.chromeH)
	})
}
