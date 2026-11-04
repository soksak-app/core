package workbench

import (
	"encoding/json"
	"fmt"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The view surfaces of a window. A view is a native web view of the host that stands in the slot of a card. The workbench of
// the page places them through record.place of packages/workbench/host.js; this file holds the same order of host calls: the
// composition of each new surface, syncSurfaces with the rectangles of the frame, a frame that shows the native view element,
// and presentSurfaces (docs/spec/native-surfaces.md#view-surfaces).

// surfaceOrder is the order of the host calls of a placement.
const surfaceOrder = "surfaces"

// surfaceNames are the core names that a view holds in its document (packages/plugin-api/surface-document.js).
var surfaceNames = map[string]bool{"core.surface.document": true, "core.surface.input": true, "core.surface.hit": true}

// surfaceDeclaration is the composition of a view that the page of the view reads.
type surfaceDeclaration struct {
	Kind     string            `json:"kind"`
	Regions  []json.RawMessage `json:"regions"`
	Overlays []string          `json:"overlays"`
}

// surfaceMarks are the exposure entries of a plugin by kind.
type surfaceMarks struct {
	Status   []json.RawMessage `json:"status"`
	Commands []json.RawMessage `json:"commands"`
	Dom      []json.RawMessage `json:"dom"`
}

// installedUnit is what the surfaces read of an installed plugin.
type installedUnit struct {
	ID string
	// Composition is the surface composition of plugin.json as it stands there, and nil for a plugin without a view.
	Composition json.RawMessage
	Declaration surfaceDeclaration
	Exposes     surfaceMarks
	Diagnostics json.RawMessage
	Sidecars    []string
	// Settings holds the local name of each setting.
	Settings []string
	// Menu tells whether the plugin declares surface.menu, and Unload holds its surface.unload.
	Menu   bool
	Unload *surfaceUnload
	// Data holds the project data keys that the plugin declares.
	Data map[string]dataDeclaration
}

// surfaceUnload is the declaration surface.unload of a plugin.
type surfaceUnload struct {
	Format   json.RawMessage `json:"format"`
	MaxBytes int             `json:"maxBytes"`
}

// readSurfaceUnits reads the plugins of the document of the installed plugins.
func readSurfaceUnits(document []byte) (map[string]*installedUnit, error) {
	var read struct {
		Error   *string `json:"error"`
		Plugins []struct {
			ID          string          `json:"id"`
			Diagnostics json.RawMessage `json:"diagnostics"`
			Manifest    struct {
				Surface *struct {
					Composition json.RawMessage `json:"composition"`
					Menu        json.RawMessage `json:"menu"`
					Unload      *surfaceUnload  `json:"unload"`
				} `json:"surface"`
				Exposes      json.RawMessage            `json:"exposes"`
				Dependencies map[string]any             `json:"dependencies"`
				Settings     map[string]json.RawMessage `json:"settings"`
				Data         map[string]dataDeclaration `json:"data"`
			} `json:"manifest"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(document, &read); err != nil {
		return nil, fmt.Errorf("installed plugins: %w", err)
	}
	if read.Error != nil {
		return nil, fmt.Errorf("installed plugins: %s", *read.Error)
	}
	units := make(map[string]*installedUnit, len(read.Plugins))
	for _, plugin := range read.Plugins {
		units[plugin.ID] = &installedUnit{ID: plugin.ID, Diagnostics: plugin.Diagnostics}
	}
	for _, plugin := range read.Plugins {
		unit := units[plugin.ID]
		unit.Data = plugin.Manifest.Data
		for local := range plugin.Manifest.Settings {
			unit.Settings = append(unit.Settings, local)
		}
		for name := range plugin.Manifest.Dependencies {
			if units[name] == nil {
				unit.Sidecars = append(unit.Sidecars, name)
			}
		}
		if len(plugin.Manifest.Exposes) > 0 {
			if err := json.Unmarshal(plugin.Manifest.Exposes, &unit.Exposes); err != nil {
				return nil, fmt.Errorf("plugin %s exposes: %w", plugin.ID, err)
			}
		}
		if len(plugin.Diagnostics) > 0 {
			var diagnostics struct {
				Exposes surfaceMarks `json:"exposes"`
			}
			if err := json.Unmarshal(plugin.Diagnostics, &diagnostics); err != nil {
				return nil, fmt.Errorf("plugin %s diagnostics: %w", plugin.ID, err)
			}
			unit.Exposes.Status = append(unit.Exposes.Status, diagnostics.Exposes.Status...)
			unit.Exposes.Commands = append(unit.Exposes.Commands, diagnostics.Exposes.Commands...)
			unit.Exposes.Dom = append(unit.Exposes.Dom, diagnostics.Exposes.Dom...)
		}
		if plugin.Manifest.Surface == nil || len(plugin.Manifest.Surface.Composition) == 0 {
			continue
		}
		if err := json.Unmarshal(plugin.Manifest.Surface.Composition, &unit.Declaration); err != nil {
			return nil, fmt.Errorf("plugin %s composition: %w", plugin.ID, err)
		}
		if unit.Declaration.Kind == "view" {
			unit.Composition = plugin.Manifest.Surface.Composition
		}
		unit.Menu = len(plugin.Manifest.Surface.Menu) > 0
		unit.Unload = plugin.Manifest.Surface.Unload
	}
	return units, nil
}

// heldSurface is a surface that the host holds for this window.
type heldSurface struct {
	// tab is the tab of the surface. The surface of a section has no tab, and this value carries its id and plugin.
	tab     layout.Tab
	box     layout.Rect
	project projectStart
	// composition is the composition of the plugin, or that of the section. section is the start value of a section surface.
	composition, section json.RawMessage
	// declared tells that the host took its composition.
	declared bool
}

// projectStart is the project of the start values of a view.
type projectStart struct {
	ID   string `json:"id"`
	Root string `json:"root"`
}

// surfaceState is the placement state of a window.
type surfaceState struct {
	held  map[string]*heldSurface
	order []string
	// drawn holds the tabs that the current frame seats, with their boxes in window coordinates.
	drawn map[string]layout.Rect
	// placed is the text of the last request, and running tells that a placement has not finished.
	placed  string
	running bool
	views   map[string]*viewState
	reports map[string]*tabReport
	// failed holds the reason of each view that stopped its restarts.
	failed map[string]string
	// command is the id of the last command request to a view.
	command uint64
}

func newSurfaceState() surfaceState {
	return surfaceState{held: map[string]*heldSurface{}, drawn: map[string]layout.Rect{}, placed: "[]",
		views: map[string]*viewState{}, reports: map[string]*tabReport{}, failed: map[string]string{}}
}

// drawSeat draws the slot of a card: the native view of its active tab. box is the slot in window coordinates.
func (s *Shell) drawSeat(c *ui.Context, tab layout.Tab, box layout.Rect) {
	unit := s.units[tab.Plugin]
	switch {
	case unit == nil:
		s.drawPluginPlaceholder(c, tab.Plugin)
		return
	case unit.Composition == nil:
		ui.Text(c, tab.Plugin+" 플러그인에는 화면이 없습니다.").FontSize(12).TextColor(s.palette.Muted)
		return
	}
	if reason, stopped := s.surfaces.failed[tab.ID]; stopped {
		ui.Text(c, reason).FontSize(12).TextColor(s.palette.No)
		return
	}
	s.surfaces.drawn[tab.ID] = box
	if s.surfaces.held[tab.ID] == nil {
		project := s.opened()
		s.surfaces.held[tab.ID] = &heldSurface{tab: tab, box: box, project: projectStart{ID: project.ID, Root: project.Root},
			composition: unit.Composition}
		s.surfaces.order = append(s.surfaces.order, tab.ID)
	}
	if surface, key, ok := s.options.Element(tab.ID); ok {
		ui.NativeView(c, surface, key).Size(float32(box.W), float32(box.H))
	}
}

// drawSectionSeat holds the view of a section of a window sidebar and seats it while the section is open. The view of a folded
// section stays held and hidden, so it keeps its state.
func (s *Shell) drawSectionSeat(c *ui.Context, seat SidebarSeat) {
	if s.units[seat.Plugin] == nil || len(seat.Composition) == 0 {
		return
	}
	if s.surfaces.held[seat.SurfaceID] == nil {
		section, err := json.Marshal(map[string]any{"id": seat.Section, "sidebar": seat.Sidebar, "card": nil})
		if err != nil {
			s.fail(err)
			return
		}
		project := s.opened()
		s.surfaces.held[seat.SurfaceID] = &heldSurface{tab: layout.Tab{ID: seat.SurfaceID, Plugin: seat.Plugin}, box: seat.Box,
			project: projectStart{ID: project.ID, Root: project.Root}, composition: seat.Composition, section: section}
		s.surfaces.order = append(s.surfaces.order, seat.SurfaceID)
	}
	if !seat.Visible {
		return
	}
	s.surfaces.drawn[seat.SurfaceID] = seat.Box
	if surface, key, ok := s.options.Element(seat.SurfaceID); ok {
		ui.NativeView(c, surface, key).Size(float32(seat.Box.W), float32(seat.Box.H))
	}
}

// forgetSurfaces removes the surfaces of closed tabs: the next placement leaves them out, and the host closes their views.
func (s *Shell) forgetSurfaces(tabs []string) {
	for _, id := range tabs {
		if view := s.surfaces.views[id]; view != nil {
			view.end()
		}
		delete(s.surfaces.held, id)
		delete(s.surfaces.failed, id)
		delete(s.surfaces.reports, id)
		delete(s.surfaces.views, id)
	}
	kept := s.surfaces.order[:0]
	for _, id := range s.surfaces.order {
		if s.surfaces.held[id] != nil {
			kept = append(kept, id)
		}
	}
	s.surfaces.order = kept
}

// surfaceDeclarations returns the declarations of the start values of unit: the core names of a surface document and the names
// of the plugin.
func (s *Shell) surfaceDeclarations(unit *installedUnit) (map[string]any, error) {
	marks := map[string]any{}
	for kind, own := range map[string][]json.RawMessage{"status": unit.Exposes.Status, "commands": unit.Exposes.Commands, "dom": unit.Exposes.Dom} {
		entries := []any{}
		for _, entry := range s.options.Declared.exposes[kind] {
			if name, _ := entry["name"].(string); surfaceNames[name] { // silent: the declaration test holds a name on each entry.
				entries = append(entries, entry)
			}
		}
		for _, entry := range own {
			entries = append(entries, entry)
		}
		marks[kind] = entries
	}
	return marks, nil
}

// surfaceRequest returns the request of syncSurfaces for the surfaces that the host holds: a seated surface stands in its box
// and the others stay hidden.
func (s *Shell) surfaceRequest() (map[string]any, error) {
	surfaces := make([]map[string]any, 0, len(s.surfaces.order))
	table := []map[string]any{}
	tables := map[string]int{}
	for _, id := range s.surfaces.order {
		held := s.surfaces.held[id]
		unit := s.units[held.tab.Plugin]
		box, visible := s.surfaces.drawn[id]
		if visible {
			held.box = box
		}
		index, ok := tables[unit.ID]
		if !ok {
			marks, err := s.surfaceDeclarations(unit)
			if err != nil {
				return nil, err
			}
			index = len(table)
			tables[unit.ID] = index
			table = append(table, marks)
		}
		surfaces = append(surfaces, map[string]any{"id": id, "visible": visible, "dim": s.surfaceDimmed(id), "plugin": unit.ID,
			"composition": held.composition, "x": held.box.X, "y": held.box.Y, "w": held.box.W, "h": held.box.H,
			"start": map[string]any{"params": tabMember(held.tab, "params", "null"), "origin": tabMember(held.tab, "origin", `{"directory":null}`),
				"project": held.project, "declarations": index, "diagnostics": rawOrNull(unit.Diagnostics), "section": rawOrNull(held.section)}})
	}
	return map[string]any{"settled": s.held == nil, "surfaces": surfaces, "titlebar": s.metrics.chromeH, "declarations": table}, nil
}

// surfaceDimmed tells whether the setting dims the surface: a card has one surface shown, and the card without focus dims it.
func (s *Shell) surfaceDimmed(id string) bool {
	return s.settings.Value("dim") == true && s.cardOfTab(id) != s.focused
}

// tabMember returns the member name of the tab, or fallback for a tab without it, as a tab without parameters starts with null.
func tabMember(tab layout.Tab, name, fallback string) json.RawMessage {
	if value, ok := tab.Rest[name]; ok {
		return value
	}
	return json.RawMessage(fallback)
}

func rawOrNull(value json.RawMessage) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage("null")
	}
	return value
}

// placeSurfaces places the surfaces when the frame moved one of them. One placement runs at a time, and the frame that
// follows it places what changed meanwhile.
func (s *Shell) placeSurfaces() {
	if s.surfaces.running {
		return
	}
	request, err := s.surfaceRequest()
	if err != nil {
		s.fail(err)
		return
	}
	encoded, err := json.Marshal(request["surfaces"])
	if err != nil {
		s.fail(err)
		return
	}
	if string(encoded) == s.surfaces.placed {
		return
	}
	s.surfaces.placed = string(encoded)
	s.surfaces.running = true
	for _, id := range s.surfaces.order {
		held := s.surfaces.held[id]
		if held.declared {
			continue
		}
		held.declared = true
		unit := s.units[held.tab.Plugin]
		s.calls.CallInOrder(surfaceOrder, "compositionDeclare", map[string]any{"surface": id, "plugin": unit.ID, "composition": held.composition},
			func(_ any, err error) {
				if err != nil {
					s.fail(fmt.Errorf("surface %s: %w", id, err))
				}
			})
	}
	settled := request["settled"]
	s.calls.CallInOrder(surfaceOrder, "syncSurfaces", request, func(value any, err error) {
		if err != nil {
			s.surfaces.running = false
			s.fail(err)
			return
		}
		prepared, err := decode[struct {
			Ticket     json.RawMessage `json:"ticket"`
			Placements json.RawMessage `json:"placements"`
		}](value)
		if err != nil {
			s.surfaces.running = false
			s.fail(err)
			return
		}
		s.options.Invalidate()
		s.calls.CallInOrder(surfaceOrder, "presentSurfaces", map[string]any{"ticket": prepared.Ticket, "placements": prepared.Placements, "settled": settled},
			func(_ any, err error) {
				s.surfaces.running = false
				if err != nil {
					s.fail(err)
				}
				s.options.Invalidate()
			})
	})
}
