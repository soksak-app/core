package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The sidebars of a window: the set that each sidebar shows and its choices, as packages/workbench/window-sidebars.js and
// sidebar-sections.js hold them (docs/spec/plugins.md#sections). It holds the selected tab, the folded sections and the dragged
// heights of each sidebar, and the frames of the build.

// SidebarSet is a set of sections.
type SidebarSet struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Sections []string `json:"sections"`
	Layout   string   `json:"layout"`
}

// SidebarLink is a sidebar choice: place shows set, for plugin or for every plugin when plugin is nil.
type SidebarLink struct {
	Place  string  `json:"place"`
	Plugin *string `json:"plugin"`
	Set    string  `json:"set"`
}

// PluginSection is a section that a plugin declares.
type PluginSection struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Composition json.RawMessage `json:"composition"`
	Height      json.RawMessage `json:"height"`
}

// PluginSidebars are the default sidebar sets of a plugin (docs/spec/plugins.md#default-sidebar-sets).
type PluginSidebars struct {
	Sets   []SidebarSet      `json:"sets"`
	Card   map[string]string `json:"card"`
	Window map[string]string `json:"window"`
}

// FocusedSurface is the active tab of the focused card, which a window sidebar of a plugin follows. It is empty without a focus.
type FocusedSurface struct {
	Card, Tab, Plugin string
}

// SidebarChoice is what a sidebar keeps, in the form that a space stores (docs/spec/projects.md#persistence).
type SidebarChoice struct {
	Tab    *string        `json:"tab"`
	Folded []string       `json:"folded"`
	Sizes  map[string]int `json:"sizes,omitempty"`
}

// SidebarsOptions is what the sidebars of a window need.
type SidebarsOptions struct {
	Declared *Declarations
	Registry *Registry
	Binder   *Binder
	// Environment is the text of the environment declaration of the application.
	Environment []byte
	// Installed is the document of the installed plugins.
	Installed []byte
	// Changed runs after a command changed a choice, so the space stores it and a frame shows it.
	Changed func()
	// Seat draws what stands on the seat of a section, whose box is in window coordinates. Without it a seat stays empty.
	Seat func(c *ui.Context, seat SidebarSeat)
}

// section is a section of a loaded plugin.
type section struct {
	PluginSection
	plugin string
	height int
	fill   bool
}

// drawnSidebar is a sidebar of the build.
type drawnSidebar struct {
	frame SidebarFrame
	set   string
	owner FocusedSurface
	rect  layout.Rect
}

// Sidebars are the sidebars of a window.
type Sidebars struct {
	options  SidebarsOptions
	metrics  SidebarMetrics
	sets     []SidebarSet
	links    []SidebarLink
	sections map[string]section
	plugins  map[string]bool
	choices  map[string]*SidebarChoice
	drags    map[string]*SectionDrag
	drawn    []*drawnSidebar
}

// NewSidebars returns the sidebars of a window, with their commands and their status in the registry.
func NewSidebars(options SidebarsOptions) (*Sidebars, error) {
	metrics, err := readSidebarMetrics(options.Declared)
	if err != nil {
		return nil, err
	}
	installed, err := readInstalled(options.Installed)
	if err != nil {
		return nil, err
	}
	s := &Sidebars{options: options, metrics: metrics, sections: map[string]section{}, plugins: map[string]bool{},
		choices: map[string]*SidebarChoice{}, drags: map[string]*SectionDrag{}}
	for _, plugin := range installed {
		s.plugins[plugin.ID] = true
		for _, declared := range plugin.Manifest.Sections {
			loaded, err := loadSection(plugin.ID, declared)
			if err != nil {
				return nil, err
			}
			s.sections[declared.ID] = loaded
		}
	}
	if s.sets, s.links, err = effectiveSidebars(options.Environment, installed); err != nil {
		return nil, err
	}
	if err := s.check(); err != nil {
		return nil, err
	}
	s.register()
	return s, nil
}

func readSidebarMetrics(declared *Declarations) (SidebarMetrics, error) {
	var m SidebarMetrics
	var failed error
	read := func(name string, into *float32) {
		value, ok := declared.Metric(name)
		if !ok {
			failed = fmt.Errorf("the chrome metric %s has no number", name)
		}
		*into = float32(value)
	}
	read("head-h", &m.HeadH)
	read("foot-h", &m.FootH)
	read("section-min-h", &m.SectionMinH)
	read("section-divider", &m.SectionDivider)
	read("section-head-gap", &m.SectionHeadGap)
	read("section-head-pad", &m.SectionHeadPad)
	read("section-head-text", &m.SectionHeadText)
	return m, failed
}

// readInstalled reads the document of the installed plugins, which holds an error when the install state cannot be read.
func readInstalled(document []byte) ([]InstalledPlugin, error) {
	var read struct {
		Plugins []InstalledPlugin `json:"plugins"`
		Error   string            `json:"error"`
	}
	if err := json.Unmarshal(document, &read); err != nil {
		return nil, fmt.Errorf("installed plugins: %w", err)
	}
	if read.Error != "" {
		return nil, errors.New(read.Error)
	}
	return read.Plugins, nil
}

func loadSection(plugin string, declared PluginSection) (section, error) {
	loaded := section{PluginSection: declared, plugin: plugin}
	var word string
	if err := json.Unmarshal(declared.Height, &word); err == nil && word == "fill" {
		loaded.fill = true
		return loaded, nil
	}
	if err := json.Unmarshal(declared.Height, &loaded.height); err != nil || loaded.height <= 0 {
		return loaded, fmt.Errorf(`plugin %s: section %s height must be "fill" or a positive integer`, plugin, declared.ID)
	}
	return loaded, nil
}

// effectiveSidebars returns the sets and the links: an explicit environment `sidebars` replaces both lists of the normalized
// defaults of the plugins (docs/spec/plugins.md#default-sidebar-sets).
func effectiveSidebars(environment []byte, installed []InstalledPlugin) ([]SidebarSet, []SidebarLink, error) {
	var declared struct {
		Sidebars *struct {
			Sets  []SidebarSet  `json:"sets"`
			Links []SidebarLink `json:"links"`
		} `json:"sidebars"`
	}
	if err := json.Unmarshal(environment, &declared); err != nil {
		return nil, nil, fmt.Errorf("environment declaration: %w", err)
	}
	if declared.Sidebars != nil {
		return declared.Sidebars.Sets, declared.Sidebars.Links, nil
	}
	var sets []SidebarSet
	var links []SidebarLink
	for _, plugin := range installed {
		defaults := plugin.Manifest.Sidebars
		if defaults == nil {
			continue
		}
		for _, set := range defaults.Sets {
			set.ID = plugin.ID + "." + set.ID
			sets = append(sets, set)
		}
		id := plugin.ID
		for _, side := range []string{"top", "bottom", "left", "right"} {
			if set, ok := defaults.Card[side]; ok {
				links = append(links, SidebarLink{Place: "card-" + side, Plugin: &id, Set: id + "." + set})
			}
			if set, ok := defaults.Window[side]; ok {
				links = append(links, SidebarLink{Place: "window-" + side, Plugin: &id, Set: id + "." + set})
			}
		}
	}
	return sets, links, nil
}

// check refuses a set that has no known layout and a link to a set that is gone.
func (s *Sidebars) check() error {
	for _, set := range s.sets {
		if set.Layout != "list" && set.Layout != "tabs" {
			return fmt.Errorf("set %s layout must be list or tabs", set.ID)
		}
	}
	for _, link := range s.links {
		if s.set(link.Set) == nil {
			return fmt.Errorf("link points at a set that is gone: %s", link.Set)
		}
	}
	return nil
}

func (s *Sidebars) set(id string) *SidebarSet {
	for i := range s.sets {
		if s.sets[i].ID == id {
			return &s.sets[i]
		}
	}
	return nil
}

// windowSet returns the set that the fixed sidebar of side shows and the plugin whose override chose it. The link of the focused
// plugin goes before the general choice, and a plugin that is not loaded chooses no content (docs/spec/plugins.md).
func (s *Sidebars) windowSet(side string, focused FocusedSurface) (*SidebarSet, string) {
	if s.plugins[focused.Plugin] {
		for _, link := range s.links {
			if link.Place == "window-"+side && link.Plugin != nil && *link.Plugin == focused.Plugin {
				return s.set(link.Set), focused.Plugin
			}
		}
	}
	for _, link := range s.links {
		if link.Place == side && link.Plugin == nil {
			return s.set(link.Set), ""
		}
	}
	return nil, ""
}

func (s *Sidebars) choice(sidebar string) *SidebarChoice {
	choice := s.choices[sidebar]
	if choice == nil {
		choice = &SidebarChoice{Folded: []string{}}
		s.choices[sidebar] = choice
	}
	return choice
}

// Begin starts the sidebars of a build. A sidebar that the build does not draw is not drawn.
func (s *Sidebars) Begin() { s.drawn = nil }

// Holds reports whether the card id is a fixed sidebar of the window.
func (s *Sidebars) Holds(id string) bool { return id == "left" || id == "right" }

// Frame returns the frame of the fixed sidebar place in the space, and records the sidebar in the build.
func (s *Sidebars) Frame(place, space string, focused FocusedSurface) (SidebarFrame, error) {
	if !s.Holds(place) {
		return SidebarFrame{}, fmt.Errorf("unknown window sidebar %s", place)
	}
	status := "왼쪽 창 사이드바"
	if place == "right" {
		status = "오른쪽 창 사이드바"
	}
	frame := SidebarFrame{Sidebar: place, Space: space, Orientation: "vertical", Side: place, Status: status}
	set, plugin := s.windowSet(place, focused)
	if plugin != "" {
		frame.Status += " · " + plugin
	}
	if set == nil {
		return frame, nil
	}
	owner := FocusedSurface{}
	if plugin != "" {
		owner = focused
	}
	s.fill(&frame, set)
	s.drawn = append(s.drawn, &drawnSidebar{frame: frame, set: set.ID, owner: owner})
	return frame, nil
}

// fill gives the frame the loaded sections of set and the choices of its sidebar. The sections of a plugin that is not loaded remain
// in the set but are not drawn (docs/spec/plugins.md).
func (s *Sidebars) fill(frame *SidebarFrame, set *SidebarSet) {
	choice := s.choice(frame.Sidebar)
	frame.Layout = set.Layout
	for _, id := range set.Sections {
		loaded, ok := s.sections[id]
		if !ok {
			continue
		}
		drawn := SidebarSection{ID: id, Name: loaded.Name, Plugin: loaded.plugin, Height: loaded.height, Fill: loaded.fill,
			Folded: set.Layout == "list" && slices.Contains(choice.Folded, id), Composition: loaded.Composition}
		if size, ok := choice.Sizes[id]; ok {
			drawn.Size = &size
		}
		frame.Sections = append(frame.Sections, drawn)
	}
	if set.Layout != "tabs" {
		return
	}
	held := func(section SidebarSection) bool { return choice.Tab != nil && section.ID == *choice.Tab }
	if !slices.ContainsFunc(frame.Sections, held) {
		choice.Tab = nil
		if len(frame.Sections) > 0 {
			first := frame.Sections[0].ID
			choice.Tab = &first
		}
	}
	if choice.Tab != nil {
		frame.Tab = *choice.Tab
	}
}

// Draw draws the frame at box, in window coordinates.
func (s *Sidebars) Draw(c *ui.Context, frame SidebarFrame, box layout.Rect) {
	for _, drawn := range s.drawn {
		if drawn.frame.Sidebar == frame.Sidebar {
			drawn.rect = box
		}
	}
	drag := s.drags[frame.Sidebar]
	if drag == nil {
		drag = &SectionDrag{}
		s.drags[frame.Sidebar] = drag
	}
	DrawSidebar(c, s.options.Binder, drag, frame, s.metrics, float32(box.W), float32(box.H), func(c *ui.Context, seat SidebarSeat) {
		if s.options.Seat == nil {
			return
		}
		if seat.Visible {
			seat.Box.X += box.X
			seat.Box.Y += box.Y
		}
		s.options.Seat(c, seat)
	})
}

// held returns the drawn sidebar that holds the section.
func (s *Sidebars) held(sidebar, id string) (*drawnSidebar, error) {
	for _, drawn := range s.drawn {
		if drawn.frame.Sidebar != sidebar {
			continue
		}
		if !slices.ContainsFunc(drawn.frame.Sections, func(section SidebarSection) bool { return section.ID == id }) {
			return nil, fmt.Errorf("sidebar %s has no section %s", sidebar, id)
		}
		return drawn, nil
	}
	return nil, fmt.Errorf("no sidebar %s is drawn", sidebar)
}

// selectSection selects one section of a sidebar with the tabs layout.
func (s *Sidebars) selectSection(value sectionParam) error {
	drawn, err := s.held(value.Sidebar, value.Section)
	if err != nil {
		return err
	}
	if drawn.frame.Layout != "tabs" {
		return fmt.Errorf("sidebar %s does not use the tabs layout", value.Sidebar)
	}
	s.choice(value.Sidebar).Tab = &value.Section
	return nil
}

// foldSection folds or opens one section of a sidebar with the list layout.
func (s *Sidebars) foldSection(value sectionParam) error {
	drawn, err := s.held(value.Sidebar, value.Section)
	if err != nil {
		return err
	}
	if drawn.frame.Layout != "list" {
		return fmt.Errorf("sidebar %s does not use the list layout", value.Sidebar)
	}
	choice := s.choice(value.Sidebar)
	if at := slices.Index(choice.Folded, value.Section); at >= 0 {
		choice.Folded = slices.Delete(choice.Folded, at, at+1)
	} else {
		choice.Folded = append(choice.Folded, value.Section)
	}
	return nil
}

func validSectionHeight(height int) bool {
	return height >= sectionHeightMin && height <= sectionHeightMax
}

// sizeSection sets the dragged height of one section of a sidebar with the list layout.
func (s *Sidebars) sizeSection(value sectionSizeParam) error {
	drawn, err := s.held(value.Sidebar, value.Section)
	if err != nil {
		return err
	}
	if drawn.frame.Layout != "list" {
		return fmt.Errorf("sidebar %s does not use the list layout", value.Sidebar)
	}
	if !validSectionHeight(value.Height) {
		return fmt.Errorf("section height must be an integer from %d to %d, got %d", sectionHeightMin, sectionHeightMax, value.Height)
	}
	choice := s.choice(value.Sidebar)
	if choice.Sizes == nil {
		choice.Sizes = map[string]int{}
	}
	choice.Sizes[value.Section] = value.Height
	return nil
}

// sectionCommand registers a command that changes a choice.
func sectionCommand[T any](s *Sidebars, name string, run func(value T) error) {
	s.options.Registry.Command(name, func(raw json.RawMessage) (any, error) {
		var value T
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if err := run(value); err != nil {
			return nil, err
		}
		if s.options.Changed != nil {
			s.options.Changed()
		}
		return nil, nil
	})
}

func (s *Sidebars) register() {
	sectionCommand(s, "core.sidebar.section.select", s.selectSection)
	sectionCommand(s, "core.sidebar.section.fold", s.foldSection)
	sectionCommand(s, "core.sidebar.section.size", s.sizeSection)
	s.options.Registry.Status("core.sidebars", func() any { return s.status() })
}

// Stored returns the choices that a space stores.
func (s *Sidebars) Stored() map[string]SidebarChoice {
	stored := make(map[string]SidebarChoice, len(s.choices))
	for sidebar, choice := range s.choices {
		stored[sidebar] = *choice
	}
	return stored
}

// Restore replaces the choices with the stored choices of a space. raw is empty for a space that stores none.
func (s *Sidebars) Restore(raw json.RawMessage) error {
	restored := map[string]*SidebarChoice{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &restored); err != nil {
			return fmt.Errorf("stored sidebars: %w", err)
		}
	}
	for sidebar, choice := range restored {
		if choice.Folded == nil {
			choice.Folded = []string{}
		}
		for id, height := range choice.Sizes {
			if !validSectionHeight(height) {
				return fmt.Errorf("sidebar %s stores an invalid size of %s: %d", sidebar, id, height)
			}
		}
	}
	s.choices = restored
	return nil
}

// sidebarRect is the rectangle of a sidebar in core.sidebars.
type sidebarRect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// sectionStatus is a section in core.sidebars. A section surface reports mounted, phase and error once its surface stands.
type sectionStatus struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Folded    bool    `json:"folded"`
	SurfaceID string  `json:"surfaceId"`
	Surface   *string `json:"surface"`
	Height    any     `json:"height"`
	Size      *int    `json:"size"`
	Mounted   bool    `json:"mounted"`
	Phase     *string `json:"phase"`
	Error     *string `json:"error"`
	Clipped   bool    `json:"clipped"`
}

// sidebarStatus is a sidebar in core.sidebars.
type sidebarStatus struct {
	Sidebar     string          `json:"sidebar"`
	Set         string          `json:"set"`
	Layout      string          `json:"layout"`
	Orientation string          `json:"orientation"`
	Tab         *string         `json:"tab"`
	Card        *string         `json:"card"`
	Surface     *string         `json:"surface"`
	Placement   string          `json:"placement"`
	Plugin      *string         `json:"plugin"`
	Side        *string         `json:"side"`
	Rect        sidebarRect     `json:"rect"`
	Sections    []sectionStatus `json:"sections"`
}

// present is nil for the empty text.
func present(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// status is the value of core.sidebars: the drawn sidebars in document order.
func (s *Sidebars) status() []sidebarStatus {
	sidebars := make([]sidebarStatus, 0, len(s.drawn))
	for _, drawn := range s.drawn {
		frame := drawn.frame
		sections := make([]sectionStatus, len(frame.Sections))
		surface := present(drawn.owner.Tab)
		for i, section := range frame.Sections {
			var height any = section.Height
			if section.Fill {
				height = "fill"
			}
			sections[i] = sectionStatus{ID: section.ID, Name: section.Name, Folded: section.Folded,
				SurfaceID: seatOf(frame, section).SurfaceID, Surface: surface, Height: height, Size: section.Size}
		}
		sidebars = append(sidebars, sidebarStatus{Sidebar: frame.Sidebar, Set: drawn.set, Layout: frame.Layout, Orientation: frame.Orientation,
			Tab: present(frame.Tab), Card: present(drawn.owner.Card), Surface: surface, Placement: "window", Plugin: present(drawn.owner.Plugin),
			Side: present(frame.Side), Rect: sidebarRect{drawn.rect.X, drawn.rect.Y, drawn.rect.W, drawn.rect.H}, Sections: sections})
	}
	return sidebars
}
