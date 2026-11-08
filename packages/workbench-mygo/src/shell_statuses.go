package workbench

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The statuses of the shell, as packages/workbench/core-exposure.js reads them from the drawn page.

// gridStatus is the value of the status core.grid.
type gridStatus struct {
	Fullscreen *string              `json:"fullscreen"`
	Width      float64              `json:"width"`
	Height     float64              `json:"height"`
	Gap        float64              `json:"gap"`
	Plane      layout.Point         `json:"plane"`
	Lines      map[string][]float64 `json:"lines"`
	Cards      []gridCardStatus     `json:"cards"`
}

// gridCardStatus is a card of core.grid.
type gridCardStatus struct {
	Fullscreen bool                                    `json:"fullscreen"`
	ID         string                                  `json:"id"`
	X          float64                                 `json:"x"`
	Y          float64                                 `json:"y"`
	W          float64                                 `json:"w"`
	H          float64                                 `json:"h"`
	C0         int                                     `json:"c0"`
	C1         int                                     `json:"c1"`
	R0         int                                     `json:"r0"`
	R1         int                                     `json:"r1"`
	Fixed      bool                                    `json:"fixed"`
	Width      *float64                                `json:"width"`
	Focused    bool                                    `json:"focused"`
	Pane       *int                                    `json:"pane"`
	Tabs       []gridTabStatus                         `json:"tabs"`
	Status     string                                  `json:"status"`
	Active     *string                                 `json:"active"`
	Acts       map[string]any                          `json:"acts"`
	Sidebars   map[layout.Side]layout.PresentedSidebar `json:"sidebars"`
}

// gridTabStatus is a tab of a card of core.grid.
type gridTabStatus struct {
	ID       string  `json:"id"`
	Plugin   string  `json:"plugin"`
	Title    string  `json:"title"`
	Label    *string `json:"label"`
	Notice   *string `json:"notice"`
	Footer   *string `json:"footer"`
	Modified bool    `json:"modified"`
	Error    *string `json:"error"`
}

// cardTool is a tool of a card head of core.grid.
type cardTool struct {
	Enabled bool   `json:"enabled"`
	Hidden  bool   `json:"hidden"`
	Title   string `json:"title"`
}

// railStatus is the value of the status core.rail.
type railStatus struct {
	Path      string       `json:"path"`
	Groups    []railGroup  `json:"groups"`
	FocusMark *layout.Rect `json:"focusMark"`
}

// railLine is the distances of the rail outline.
type railLine struct{ pad, inset, radius float64 }

// railRead is the rail outline with the values it was computed from.
type railRead struct {
	rects   []layout.Rect
	line    railLine
	outline layout.Outline
}

// railGroup is the outline that binds a focused card with the window sidebars of its plugin.
type railGroup struct {
	layout.Outline
	Card     string        `json:"card"`
	Sidebars []string      `json:"sidebars"`
	Rects    []layout.Rect `json:"rects"`
}

// surfaceStatus is an entry of the status core.surfaces.
type surfaceStatus struct {
	Surface     string       `json:"surface"`
	Plugin      string       `json:"plugin"`
	Visible     bool         `json:"visible"`
	Dim         bool         `json:"dim"`
	Declared    *layout.Rect `json:"declared"`
	Applied     *layout.Rect `json:"applied"`
	Exposes     []string     `json:"exposes"`
	Status      any          `json:"status"`
	Placeholder *string      `json:"placeholder"`
	Composition *string      `json:"composition"`
	Kind        string       `json:"kind"`
	Sidebar     *string      `json:"sidebar"`
	State       string       `json:"state"`
}

// placeholderStatus is an entry of the status core.surfaces for a tab of a plugin that the window did not load: it has no surface,
// so it reports only its plugin, that it is visible and the reason of its placeholder.
type placeholderStatus struct {
	Surface     string  `json:"surface"`
	Plugin      string  `json:"plugin"`
	Visible     bool    `json:"visible"`
	Placeholder string  `json:"placeholder"`
	Composition *string `json:"composition"`
	Kind        string  `json:"kind"`
	Sidebar     *string `json:"sidebar"`
}

// optionalText returns the status member of a text that a surface may not have reported.
func optionalText(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// planeOrigin is the origin of the plane in the window.
func (s *Shell) planeOrigin() layout.Point {
	inset := s.stageInset()
	return layout.Point{X: float64(s.projectColumnWidth() + inset), Y: float64(s.chromeHeight() + s.workBanner + s.spaceRowHeight() + inset)}
}

// projectStatus returns the stored record of a project with its open state.
func (s *Shell) projectStatus(record projectRecord) (map[string]any, error) {
	text, err := json.Marshal(record.Project)
	if err != nil {
		return nil, err
	}
	var status map[string]any
	if err := json.Unmarshal(text, &status); err != nil {
		return nil, err
	}
	status["open"] = s.isOpen(record.ID)
	return status, nil
}

// cardStatusText is the text that the status line of a card shows: the footer that the active tab reported.
func (s *Shell) cardStatusText(data *layout.CardData) string {
	if data == nil || data.ActiveTab() == nil {
		return ""
	}
	if report := s.surfaces.reports[data.ActiveTab().ID]; report != nil {
		return report.Footer
	}
	return ""
}

// cardRect is the rectangle of a card on the plane: the whole plane for a fullscreen card.
func (s *Shell) cardRect(id string) (layout.Rect, bool) {
	if s.fullscreen == id {
		return layout.Rect{W: s.plane.Width(), H: s.plane.Height()}, true
	}
	return s.plane.Rect(id)
}

// cardActs is the state of the tools of the head that the last frame drew for a card, and nil for a card without a head.
func (s *Shell) cardActs(id string) map[string]any {
	fit, ok := s.heads[id]
	if !ok {
		return nil
	}
	acts := map[string]any{"fit": fit.Fit, "tools": fit.Tools}
	for _, tool := range s.headTools(id) {
		acts[tool.Status] = cardTool{Enabled: tool.Enabled, Hidden: fit.Tools != "bar", Title: tool.Title}
	}
	return acts
}

// linePositions is where the lines of an axis stand in the plane, the positions that core.boundary.move takes.
func linePositions(plane *layout.Grid, axis layout.Axis) []float64 {
	lines := plane.Lines(axis)
	for line := range lines {
		lines[line] = plane.BoundaryPos(axis, line)
	}
	return lines
}

// gridState returns the value of core.grid, or nil without a plane.
func (s *Shell) gridState() (any, error) {
	if s.plane == nil {
		return nil, nil
	}
	status := gridStatus{Width: s.plane.Width(), Height: s.plane.Height(), Gap: s.plane.Gap(), Plane: s.planeOrigin(),
		Lines: map[string][]float64{"x": linePositions(s.plane, "x"), "y": linePositions(s.plane, "y")}, Cards: []gridCardStatus{}}
	if s.fullscreen != "" {
		status.Fullscreen = &s.fullscreen
	}
	pane := 0
	for _, card := range s.plane.Cards() {
		rect, ok := s.cardRect(card.ID)
		if !ok {
			continue
		}
		data, err := layout.DecodeCardData(card.Data)
		if err != nil {
			return nil, fmt.Errorf("card %s: %w", card.ID, err)
		}
		entry := gridCardStatus{Fullscreen: card.ID == s.fullscreen, ID: card.ID, X: rect.X, Y: rect.Y, W: rect.W, H: rect.H,
			C0: card.C0, C1: card.C1, R0: card.R0, R1: card.R1, Fixed: card.Fixed, Width: card.Width, Focused: card.ID == s.focused,
			Tabs: []gridTabStatus{}, Status: s.cardStatusText(data), Acts: s.cardActs(card.ID), Sidebars: map[layout.Side]layout.PresentedSidebar{}}
		if data != nil {
			if entry.Sidebars, err = s.presentCard(card.ID, data, rect); err != nil {
				return nil, fmt.Errorf("card %s: %w", card.ID, err)
			}
		}
		if entry.Acts != nil {
			index := pane
			entry.Pane = &index
			pane++
		}
		if data != nil {
			for _, tab := range data.TabList() {
				entry.Tabs = append(entry.Tabs, s.gridTab(tab))
			}
			if active := data.ActiveTab(); active != nil {
				entry.Active = &active.ID
			}
		}
		status.Cards = append(status.Cards, entry)
	}
	return status, nil
}

// gridTab returns the entry of a tab with what its view reported.
func (s *Shell) gridTab(tab layout.Tab) gridTabStatus {
	entry := gridTabStatus{ID: tab.ID, Plugin: tab.Plugin, Title: tab.Title}
	if report := s.surfaces.reports[tab.ID]; report != nil {
		entry.Label, entry.Footer, entry.Error = optionalText(report.Title), optionalText(report.Footer), optionalText(report.Error)
		entry.Notice, entry.Modified = optionalText(s.tabNoticeText(tab.ID)), report.Modified
	}
	return entry
}

// layoutState returns the value of core.layout: the saved form of the space, or nil without a plane.
func (s *Shell) layoutState() (any, error) {
	project := s.opened()
	if s.plane == nil || project == nil {
		return nil, nil
	}
	if err := s.keepPlane(project); err != nil {
		return nil, err
	}
	space, err := layout.SpaceIn(&project.Project, project.ActiveSpaceID)
	if err != nil {
		return nil, err
	}
	var kept map[string]json.RawMessage
	if err := json.Unmarshal(space.Layout, &kept); err != nil {
		return nil, err
	}
	return kept, nil
}

// railGroups returns the outline of the focused card with the window sidebars that the plugin of its tab chose.
func (s *Shell) railGroups() []railGroup {
	groups := []railGroup{}
	if s.plane == nil || s.browsing || s.fullscreen != "" {
		return groups
	}
	focused := s.focusedSurface()
	var sidebars []string
	for _, side := range []string{"left", "right"} {
		if _, plugin := s.sidebars.windowSet(side, focused); plugin != "" {
			if _, ok := s.plane.Card(side); ok {
				sidebars = append(sidebars, side)
			}
		}
	}
	if len(sidebars) == 0 {
		return groups
	}
	rects := make([]layout.Rect, 0, len(sidebars)+1)
	for _, id := range append([]string{s.focused}, sidebars...) {
		if rect, ok := s.plane.Rect(id); ok && rect.W > 0 && rect.H > 0 {
			rects = append(rects, rect)
		}
	}
	if len(rects) != len(sidebars)+1 {
		return groups
	}
	pad, inset := s.plane.Gap()/2, float64(s.palette.BorderWidth)/2
	radius := float64(s.palette.Radius)
	if radius != 0 {
		radius += pad - inset
	}
	line := railLine{pad: pad, inset: inset, radius: radius}
	if !slices.Equal(rects, s.railRead.rects) || line != s.railRead.line {
		s.railRead = railRead{rects: rects, line: line,
			outline: layout.ComputeOutline(rects, layout.OutlineOptions{Pad: &pad, Inset: &inset, Radius: &radius})}
	}
	return append(groups, railGroup{Outline: s.railRead.outline, Card: s.focused, Sidebars: sidebars, Rects: rects})
}

// focusMark returns the rectangle of the focus corners around the slot of the focused card, or nil while the setting shows no corners.
func (s *Shell) focusMark() *layout.Rect {
	if s.plane == nil || s.browsing || s.settings.Value("focusInd") != "corner" {
		return nil
	}
	card, ok := s.plane.Card(s.focused)
	if !ok {
		return nil
	}
	data, err := s.readCard(card)
	if err != nil || data == nil || data.ActiveTab() == nil {
		return nil
	}
	rect, ok := s.cardRect(s.focused)
	if !ok {
		return nil
	}
	const out = 1 // The chrome metric focus-mark-t.
	edge := float64(s.palette.BorderWidth)
	shrunkHead, shrunkFoot := cardRows(float32(rect.H-2*edge), s.metrics.headH, s.metrics.footH)
	head, foot := float64(shrunkHead), float64(shrunkFoot)
	return &layout.Rect{X: rect.X + edge - out, Y: rect.Y + edge + head - out, W: rect.W - 2*edge + 2*out, H: rect.H - 2*edge - head - foot + 2*out}
}

// drawRail draws the rail outline and the focus corners over the cards of the stage. inset is the origin of the plane in the stage.
func (s *Shell) drawRail(p *ui.Painter, stage ui.Rect, inset float32) {
	at := func(x, y float64) (float32, float32) {
		return stage.X + inset + float32(x), stage.Y + inset + float32(y)
	}
	for _, group := range s.railGroups() {
		var path ui.Path
		for _, step := range OutlineDrawSteps(group.Outline) {
			x, y := at(step.X, step.Y)
			switch step.Op {
			case DrawMove:
				path.MoveTo(x, y)
			case DrawLine:
				path.LineTo(x, y)
			case DrawCube:
				c1x, c1y := at(step.C1X, step.C1Y)
				c2x, c2y := at(step.C2X, step.C2Y)
				path.CubeTo(c1x, c1y, c2x, c2y, x, y)
			case DrawClose:
				path.Close()
			}
		}
		p.StrokePath(&path, s.palette.BorderWidth, s.palette.Rail)
	}
	mark := s.focusMark()
	if mark == nil {
		return
	}
	const length, thick = 14, 1 // The chrome metrics focus-mark-len and focus-mark-t.
	left, top := at(mark.X, mark.Y)
	right, bottom := left+float32(mark.W), top+float32(mark.H)
	for _, corner := range []ui.Rect{{X: left, Y: top, W: length, H: thick}, {X: left, Y: top, W: thick, H: length},
		{X: right - length, Y: top, W: length, H: thick}, {X: right - thick, Y: top, W: thick, H: length},
		{X: left, Y: bottom - thick, W: length, H: thick}, {X: left, Y: bottom - length, W: thick, H: length},
		{X: right - length, Y: bottom - thick, W: length, H: thick}, {X: right - thick, Y: bottom - length, W: thick, H: length}} {
		p.Fill(corner, s.palette.Focus, 0)
	}
}

// railState returns the value of core.rail, or nil without a plane.
func (s *Shell) railState() any {
	if s.plane == nil {
		return nil
	}
	status := railStatus{Groups: s.railGroups(), FocusMark: s.focusMark()}
	for i, group := range status.Groups {
		if i > 0 {
			status.Path += " "
		}
		status.Path += group.Path
	}
	return status
}

// surfacesState returns the value of core.surfaces: each surface that the host holds, in the order the host took them, then the
// unloaded sections and the placeholder tabs of the plane.
func (s *Shell) surfacesState() ([]any, error) {
	placeholders, err := s.placeholderRows()
	if err != nil {
		return nil, err
	}
	status := make([]any, 0, len(s.surfaces.order)+len(placeholders))
	for _, id := range s.surfaces.order {
		held := s.surfaces.held[id]
		unit := s.units[held.tab.Plugin]
		box, visible := s.surfaces.drawn[id]
		if !visible {
			box = held.box
		}
		entry := surfaceStatus{Surface: id, Plugin: unit.ID, Visible: visible, Dim: s.surfaceDimmed(id), Declared: &box, Exposes: s.registry.EntriesOf(id),
			Status: s.surfacePhase(id), Composition: optionalText(unit.Declaration.Kind), Kind: "tab", State: s.surfaceMemoryState(id)}
		if applied, ok := s.surfaces.applied[id]; ok && visible {
			entry.Applied = &applied
		}
		if held.section != nil {
			// Sections have their own validated view composition, independent
			// of whether their plugin declares a tab surface.
			entry.Composition = optionalText("view")
			entry.Kind = "section"
			entry.Sidebar = &held.section.Sidebar
		}
		status = append(status, entry)
	}
	for _, row := range s.unloadedSections() {
		status = append(status, row)
	}
	for _, row := range placeholders {
		status = append(status, row)
	}
	return status, nil
}

// unloadedSections returns the rows of the sections whose surfaces the memory saver unloaded: a section keeps its seat, so it stays in the
// list without a view.
func (s *Shell) unloadedSections() []surfaceStatus {
	var rows []surfaceStatus
	for _, seat := range s.seatsInOrder() {
		if s.surfaces.held[seat.SurfaceID] != nil || s.tabs == nil || !s.tabs.saver.Unloaded(seat.SurfaceID) {
			continue
		}
		rows = append(rows, surfaceStatus{Surface: seat.SurfaceID, Plugin: seat.Plugin, Declared: &layout.Rect{}, Exposes: s.registry.EntriesOf(seat.SurfaceID),
			Status: s.surfacePhase(seat.SurfaceID), Composition: optionalText("view"), Kind: "section", Sidebar: &seat.Sidebar, State: "unloaded"})
	}
	return rows
}

// surfaceMemoryState returns the state of a surface in the memory saver. A surface that the memory saver does not hold is loaded.
func (s *Shell) surfaceMemoryState(id string) string {
	if s.tabs != nil && s.tabs.saver != nil {
		if state := s.tabs.saver.State(id); state != "" {
			return state
		}
	}
	return "loaded"
}

// surfaceProgress is the phase of a surface with the reason of an error: its reported failure, or ready once the document of the
// view answered.
func (s *Shell) surfaceProgress(id string) (phase, reason string) {
	if reason, stopped := s.surfaces.stopped(id); stopped {
		return "error", reason
	}
	if report := s.surfaces.reports[id]; report != nil && report.Error != "" {
		return "error", report.Error
	}
	if s.surfaces.views[id] != nil {
		return "ready", ""
	}
	return "loading", ""
}

// surfacePhase is the page status of a surface.
func (s *Shell) surfacePhase(id string) map[string]any {
	phase, reason := s.surfaceProgress(id)
	if phase == "error" {
		return map[string]any{"phase": phase, "reason": reason}
	}
	return map[string]any{"phase": phase}
}

// sectionProgress is the state of a section surface in core.sidebars. A section is mounted once its view answered, and a view that
// stopped is no longer mounted. A section without a surface has no phase.
func (s *Shell) sectionProgress(id string) SectionProgress {
	if s.surfaces.held[id] == nil {
		return SectionProgress{}
	}
	phase, reason := s.surfaceProgress(id)
	_, stopped := s.surfaces.stopped(id)
	return SectionProgress{Mounted: s.surfaces.views[id] != nil && !stopped, Phase: &phase, Error: nullable(reason)}
}

// registerStatuses adds the statuses of the shell.
func (s *Shell) registerStatuses() {
	s.registry.Status("core.plugin.open-calls", func() any { return s.processes.openCalls() })
	s.registry.Status("core.plugin.losses", func() any { return s.processes.lossList() })
	s.registry.Status("core.plugin.views", func() any { return s.processes.viewList() })
	s.registry.Status("core.verify", s.verifyStatus)
	s.registry.Status("core.projects", func() any {
		status := make([]map[string]any, 0, len(s.projects))
		for _, project := range s.projects {
			entry, err := s.projectStatus(project)
			if err != nil {
				s.fail(err)
				continue
			}
			status = append(status, entry)
		}
		return status
	})
	s.registry.Status("core.project", func() any {
		project := s.opened()
		if project == nil || s.browsing {
			return nil
		}
		entry, err := s.projectStatus(*project)
		if err != nil {
			s.fail(err)
			return nil
		}
		return entry
	})
	s.registry.Status("core.layout", func() any {
		value, err := s.layoutState()
		if err != nil {
			s.fail(err)
			return nil
		}
		return value
	})
	s.registry.Status("core.grid", func() any {
		value, err := s.gridState()
		if err != nil {
			s.fail(err)
			return nil
		}
		return value
	})
	s.registry.Status("core.surfaces", func() any {
		value, err := s.surfacesState()
		if err != nil {
			s.fail(err)
			return nil
		}
		return value
	})
	s.registry.Status("core.chrome", func() any {
		return map[string]any{"controlsWidth": math.Max(0, float64(s.controlsWidth)), "projectTabs": s.projectTabsPlace()}
	})
	s.registry.Status("core.rail", func() any { return s.railState() })
	s.registry.Status("core.window.workbench", func() any {
		window, err := s.windowView()
		if err != nil {
			s.failWindowRead(err)
			return nil
		}
		ready, visibility := "interactive", "hidden"
		if s.drawn {
			ready = "complete"
		}
		if window.Visible {
			visibility = "visible"
		}
		return map[string]any{"start": s.events.Start(), "startedAt": float64(s.events.StartedAt().UnixMilli()), "readyState": ready,
			"visibility": visibility, "scheme": s.settings.Scheme(), "background": s.dialogOpen(),
			"scale": window.Scale, "width": window.Width, "height": window.Height}
	})
	s.registry.Status("core.workbench.audit", func() any {
		tree, err := s.options.Elements.ElementTree()
		if err != nil {
			s.fail(err)
			return nil
		}
		return map[string]any{"unbound": Audit(tree)}
	})
	var declaration struct {
		Themes json.RawMessage `json:"themes"`
	}
	if err := json.Unmarshal(workbenchFile, &declaration); err != nil {
		s.fail(fmt.Errorf("workbench.json: %w", err))
		return
	}
	s.registry.Status("core.themes", func() any { return declaration.Themes })
}
