package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

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
	// Unload holds the declaration that lets the memory saver unload the section surface.
	Unload *surfaceUnload `json:"unload"`
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
	// Look returns the width of a line and the size of a caption at the settings of the window.
	Look     func() (float32, float32)
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
	// Progress returns the state of the section surface id.
	Progress func(id string) SectionProgress
	// Rail returns the rail color of the current theme.
	Rail func() ui.Color
}

// SectionProgress is the state of a section surface that core.sidebars reports.
type SectionProgress struct {
	Mounted bool
	Phase   *string
	Error   *string
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
	divider  float64
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
	divider, ok := options.Declared.Metric("divider")
	if !ok {
		return nil, errors.New("the chrome metric divider has no number")
	}
	s := &Sidebars{options: options, metrics: metrics, divider: divider, sections: map[string]section{}, plugins: map[string]bool{},
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
	read("section-head-weight", &m.SectionHeadWeight)
	read("line-height", &m.SectionHeadLine)
	m.SectionHeadFont = declared.ChromeValue("ui-font")
	read("section-tab-mark", &m.SectionTabMark)
	read("sidebar-status-gap", &m.StatusGap)
	read("space-2", &m.StatusPad)
	read("fold-button", &m.FoldButton)
	read("card-icon", &m.FoldIcon)
	read("icon-stroke", &m.IconStroke)
	read("r-xs-ratio", &m.FoldRadiusRatio)
	share := func(name string, into *float32) {
		value, ok := declared.Share(name)
		if !ok {
			failed = fmt.Errorf("the chrome metric %s has no share", name)
		}
		*into = float32(value)
	}
	share("inset-mix", &m.FoldHoverMix)
	share("section-head-mix", &m.SectionHeadMix)
	share("section-head-hover-mix", &m.SectionHeadHoverMix)
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

// Declared returns the sets and the links that the environment and the installed plugins declare, which are the defaults of the
// settings until a person changes them.
func (s *Sidebars) Declared() ([]SidebarSet, []SidebarLink) { return s.sets, s.links }

// Adopt takes the sets and the links of the settings, which the next frame shows. The settings checked them before they took them,
// and they keep a link of a plugin that is not loaded to a set that only that plugin declared.
func (s *Sidebars) Adopt(sets []SidebarSet, links []SidebarLink) {
	s.sets, s.links = sets, links
}

// check refuses declared sets and links that break the rules of validateSidebars of @soksak/plugin-api, as the page refuses the
// sidebars of environment.json.
func (s *Sidebars) check() error {
	sets, err := decode[any](s.sets)
	if err != nil {
		return fmt.Errorf("environment.json: %w", err)
	}
	links, err := decode[any](s.links)
	if err != nil {
		return fmt.Errorf("environment.json: %w", err)
	}
	return validateSidebars(orEmptyList(sets), orEmptyList(links), "environment.json", nil)
}

// orEmptyList is value, or an empty list when value is the nil of a list that holds nothing.
func orEmptyList(value any) any {
	if value == nil {
		return []any{}
	}
	return value
}

func (s *Sidebars) set(id string) *SidebarSet {
	for i := range s.sets {
		if s.sets[i].ID == id {
			return &s.sets[i]
		}
	}
	return nil
}

// Sides returns the sides that have a fixed sidebar: those that a link of the window chooses content for.
func (s *Sidebars) Sides() []string {
	sides := []string{}
	for _, side := range []string{"left", "right"} {
		if slices.ContainsFunc(s.links, func(link SidebarLink) bool { return link.Place == side || link.Place == "window-"+side }) {
			sides = append(sides, side)
		}
	}
	return sides
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

// linkedCard returns the id of the set that the link of plugin gives the side of a card, or nil without such a link.
func (s *Sidebars) linkedCard(side, plugin string) *string {
	return linkedCardOf(s.links, side, plugin)
}

// linkedCardOf returns the set of links for the side of a card with a tab of plugin, or nil without a link.
func linkedCardOf(links []SidebarLink, side, plugin string) *string {
	for i := range links {
		if links[i].Place == "card-"+side && links[i].Plugin != nil && *links[i].Plugin == plugin {
			return &links[i].Set
		}
	}
	return nil
}

// setDocuments returns the sets by id, as the choices of a card read them.
func (s *Sidebars) setDocuments() (map[string]json.RawMessage, error) {
	documents := make(map[string]json.RawMessage, len(s.sets))
	for _, set := range s.sets {
		encoded, err := json.Marshal(set)
		if err != nil {
			return nil, err
		}
		documents[set.ID] = encoded
	}
	return documents, nil
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

// CardFrame returns the frame of the side of a card that shows set, and records the sidebar in the build. owner is the card with
// its active tab, the surface that the sections of the sidebar follow.
func (s *Sidebars) CardFrame(set *SidebarSet, space, side string, owner FocusedSurface) SidebarFrame {
	orientation := "vertical"
	if side == "top" || side == "bottom" {
		orientation = "horizontal"
	}
	frame := SidebarFrame{Sidebar: owner.Card + ":" + side, Space: space, Orientation: orientation,
		Status: layout.SideName(side) + " 사이드바 · " + set.Title}
	s.fill(&frame, set)
	s.drawn = append(s.drawn, &drawnSidebar{frame: frame, set: set.ID, owner: owner})
	return frame
}

// Hide keeps the section surfaces of a folded sidebar known, which are not visible.
func (s *Sidebars) Hide(c *ui.Context, frame SidebarFrame) {
	if s.options.Seat == nil {
		return
	}
	for _, seat := range SidebarSeats(frame) {
		seat.Visible = false
		s.options.Seat(c, seat)
	}
}

// windowSurfaces returns the ids of the section surfaces of the fixed sidebars of the space: every set of sets that a link of links gives
// them, whichever plugin has the focus.
func (s *Sidebars) windowSurfaces(space string, sets []SidebarSet, links []SidebarLink) []string {
	var surfaces []string
	for _, place := range []string{"left", "right"} {
		seen := map[string]bool{}
		for _, link := range links {
			if (link.Place == place || link.Place == "window-"+place) && !seen[link.Set] {
				seen[link.Set] = true
				surfaces = append(surfaces, s.setSurfaces(space, place, link.Set, sets)...)
			}
		}
	}
	return surfaces
}

// setSurfaces returns the ids of the section surfaces of the set of sets on the sidebar of the space. A set that is gone or a section that
// no plugin that is loaded declares has no surface.
func (s *Sidebars) setSurfaces(space, sidebar, id string, sets []SidebarSet) []string {
	var surfaces []string
	for i := range sets {
		if sets[i].ID != id {
			continue
		}
		for _, section := range sets[i].Sections {
			if loaded, ok := s.sections[section]; ok && len(loaded.Composition) > 0 {
				surfaces = append(surfaces, space+"/"+sidebar+"/"+section)
			}
		}
	}
	return surfaces
}

// surfacePlugin returns the plugin that declares the section of a surface that setSurfaces returned, whose id is
// `<space id>/<sidebar id>/<section id>` (docs/spec/plugins.md#sections).
func (s *Sidebars) surfacePlugin(surface string) string {
	return s.sections[surface[strings.LastIndex(surface, "/")+1:]].plugin
}

// fill gives the frame the loaded sections of set and the choices of its sidebar. The sections of a plugin that is not loaded remain
// in the set but are not drawn (docs/spec/plugins.md).
func (s *Sidebars) fill(frame *SidebarFrame, set *SidebarSet) {
	choice := s.choice(frame.Sidebar)
	frame.Layout, frame.Set = set.Layout, set.ID
	for _, id := range set.Sections {
		loaded, ok := s.sections[id]
		if !ok {
			continue
		}
		drawn := SidebarSection{ID: id, Name: loaded.Name, Plugin: loaded.plugin, Height: loaded.height, Fill: loaded.fill, Unload: loaded.Unload,
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
	if s.options.Rail != nil {
		frame.Rail = s.options.Rail()
	}
	metrics := s.metrics
	metrics.BorderWidth, metrics.StatusText = s.options.Look()
	DrawSidebar(c, s.options.Binder, drag, frame, metrics, float32(box.W), float32(box.H), func(c *ui.Context, seat SidebarSeat) {
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

// sectionStatus is a section in core.sidebars.
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

// nullable is nil for the empty text.
func nullable(text string) *string {
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
		surface := nullable(drawn.owner.Tab)
		for i, section := range frame.Sections {
			var height any = section.Height
			if section.Fill {
				height = "fill"
			}
			id := seatOf(frame, section).SurfaceID
			var progress SectionProgress
			if s.options.Progress != nil {
				progress = s.options.Progress(id)
			}
			sections[i] = sectionStatus{ID: section.ID, Name: section.Name, Folded: section.Folded, SurfaceID: id, Surface: surface, Height: height,
				Size: section.Size, Mounted: progress.Mounted, Phase: progress.Phase, Error: progress.Error}
		}
		placement, plugin := "window", nullable(drawn.owner.Plugin)
		if frame.Side == "" {
			placement, plugin = "card", nil // The context of a card sidebar has no plugin and no side of a window sidebar.
		}
		sidebars = append(sidebars, sidebarStatus{Sidebar: frame.Sidebar, Set: drawn.set, Layout: frame.Layout, Orientation: frame.Orientation,
			Tab: nullable(frame.Tab), Card: nullable(drawn.owner.Card), Surface: surface, Placement: placement, Plugin: plugin,
			Side: nullable(frame.Side), Rect: sidebarRect{drawn.rect.X, drawn.rect.Y, drawn.rect.W, drawn.rect.H}, Sections: sections})
	}
	return sidebars
}
