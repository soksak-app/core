package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

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
var surfaceNames = map[string]bool{"core.surface.document": true, "core.surface.input": true, "core.surface.hit": true, "core.surface.clock": true}

// surfaceDeclaration is the composition of a view that the page of the view reads.
type surfaceDeclaration struct {
	Kind     string            `json:"kind"`
	Regions  []json.RawMessage `json:"regions"`
	Overlays []string          `json:"overlays"`
}

// Exposes are the exposure entries of a plugin by kind.
type Exposes struct {
	Status   []json.RawMessage `json:"status"`
	Commands []json.RawMessage `json:"commands"`
	Element  []json.RawMessage `json:"element"`
}

// installedUnit is what the surfaces read of an installed plugin.
type installedUnit struct {
	ID string
	// Composition is the surface composition of plugin.json as it stands there, and nil for a plugin without a view.
	Composition json.RawMessage
	Declaration surfaceDeclaration
	Exposes     Exposes
	Diagnostics json.RawMessage
	Sidecars    []string
	// Settings holds the local name of each setting.
	Settings []string
	// Menu tells whether the plugin declares surface.menu, and Unload holds its surface.unload.
	Menu   bool
	Unload *surfaceUnload
	// Data holds the project data keys that the plugin declares.
	Data map[string]dataDeclaration
	// Drop is the command that surface.drop names, and empty for a plugin that takes no files.
	Drop string
	// Opens holds the extensions of surface.opens, and Background the background declaration, or nil.
	Opens      []string
	Background *BackgroundDeclaration
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
					Drop        string          `json:"drop"`
					Opens       struct {
						Extensions []string `json:"extensions"`
					} `json:"opens"`
				} `json:"surface"`
				Background   *BackgroundDeclaration     `json:"background"`
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
		unit.Background = plugin.Manifest.Background
		if plugin.Manifest.Surface != nil {
			unit.Opens = plugin.Manifest.Surface.Opens.Extensions
		}
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
				Exposes Exposes `json:"exposes"`
			}
			if err := json.Unmarshal(plugin.Diagnostics, &diagnostics); err != nil {
				return nil, fmt.Errorf("plugin %s diagnostics: %w", plugin.ID, err)
			}
			unit.Exposes.Status = append(unit.Exposes.Status, diagnostics.Exposes.Status...)
			unit.Exposes.Commands = append(unit.Exposes.Commands, diagnostics.Exposes.Commands...)
			unit.Exposes.Element = append(unit.Exposes.Element, diagnostics.Exposes.Element...)
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
		unit.Drop = plugin.Manifest.Surface.Drop
	}
	return units, nil
}

// heldSurface is a surface that the host holds for this window.
type heldSurface struct {
	// tab is the tab of the surface. A section surface has a tab of its id and its plugin only.
	tab         layout.Tab
	composition json.RawMessage
	box         layout.Rect
	project     projectStart
	// owner is the project whose layout holds the surface.
	owner string
	// section is the start value of a section surface, and nil for the surface of a tab.
	section *sectionStart
	// unload is the declaration of unload of a section surface.
	unload *surfaceUnload
	// declared tells that the host took its composition, and hosted that a placement that held it finished, so the host holds its
	// view.
	declared bool
	hosted   bool
}

// sectionStart is the start value section of a section surface. A section of a window sidebar has no card.
type sectionStart struct {
	ID      string  `json:"id"`
	Sidebar string  `json:"sidebar"`
	Card    *string `json:"card"`
}

// projectStart is the project of the start values of a view.
type projectStart struct {
	ID   string `json:"id"`
	Root string `json:"root"`
}

// surfaceState is the placement state of a window.
type surfaceState struct {
	// withdrawing tells that a wait for the surfaces runs to withdraw the error of a failed placement, and closed that the window ended.
	withdrawing bool
	closed      bool
	// layoutFault tells that the next placement fails once (diagnostics.layout.fail).
	layoutFault bool
	held        map[string]*heldSurface
	order       []string
	// drawn holds the tabs that the current frame seats, with their boxes in window coordinates.
	drawn map[string]layout.Rect
	// seated holds the seats of the section surfaces of the sidebars of the current frame, drawnPlane is the plane that the frame drew,
	// and drawnLibrary tells that the frame drew the library instead.
	seated map[string]SidebarSeat
	// behindDialog are the native views of the frame that wait to draw over the blurred workbench.
	behindDialog []viewBehindDialog
	drawnPlane   *layout.Grid
	drawnLibrary bool
	// dataWrites counts the writes of project data of each project that the store has not answered.
	dataWrites map[string]int
	// placed is the lines of the last request, and running tells that a placement has not finished.
	placed  []surfaceLine
	running bool
	// going tells that the last placement belongs to a run.
	going   bool
	views   map[string]*viewState
	reports map[string]*tabReport
	// failed holds the reason of each view that stopped its restarts.
	failed map[string]string
	// command is the id of the last command request to a view.
	command uint64
	// commits holds the answers of the commits that wait for a placement, and placing those of the placement that runs.
	commits, placing []func(err error)
	// documents holds the names of the document regions that each surface attached and has not detached.
	documents map[string]map[string]bool
	// detaching holds the surfaces whose image detach was pending when the workbench started, and detachFailed the failure of each
	// one whose detach failed. Neither is placed nor opens a background session (docs/spec/sidecars.md).
	detaching    map[string]bool
	detachFailed map[string]string
	// sessions holds the stored session that the next attaches of a tab restore.
	sessions map[string]*storedSession
	// latest is the record of the last placement, answered the record of the last placement that the host answered, and sequence
	// the number of the last record.
	latest, answered *VerifyRecord
	// placedAt is when the last placement started.
	placedAt time.Time
	sequence int
	// applied holds where the host applied each visible surface, in window coordinates.
	applied map[string]layout.Rect
	// controls is the area of the window buttons that the host answered, and failure the error of the last placement.
	controls *layout.Rect
	failure  *string
}

// holdDetaching holds the surfaces that the host names at the start of the workbench.
func (s *surfaceState) holdDetaching(surfaces []string) {
	for _, id := range surfaces {
		s.detaching[id] = true
	}
}

// detachHeld tells whether the image detach of the surface id is pending or failed.
func (s *surfaceState) detachHeld(id string) bool {
	_, failed := s.detachFailed[id]
	return s.detaching[id] || failed
}

// stopped returns the reason that keeps the surface id down: its view stopped its restarts, or its image detach failed.
func (s *surfaceState) stopped(id string) (string, bool) {
	if reason, failed := s.failed[id]; failed {
		return reason, true
	}
	reason, failed := s.detachFailed[id]
	return reason, failed
}

// imageDetachEnded applies the event image-detach-ended. An end of a surface that the start did not hold belongs to no surface of
// this workbench.
func (s *Shell) imageDetachEnded(data []any) {
	if len(data) != 1 {
		s.fail(fmt.Errorf("invalid image-detach-ended event: %v", data))
		return
	}
	ended, err := decode[struct {
		Surface string  `json:"surface"`
		Error   *string `json:"error"`
	}](data[0])
	if err != nil || ended.Surface == "" || (ended.Error != nil && *ended.Error == "") {
		s.fail(fmt.Errorf("invalid image-detach-ended event: %v", data[0]))
		return
	}
	if !s.surfaces.detaching[ended.Surface] {
		return
	}
	delete(s.surfaces.detaching, ended.Surface)
	if ended.Error != nil {
		s.surfaces.detachFailed[ended.Surface] = *ended.Error
	}
	s.tabsSettled()
	s.options.Invalidate()
}

// storedSession is the stored session of a tab while its regions attach: the interactionState of each region that has not restored it.
type storedSession struct {
	states  map[string]string
	history bool
	read    bool
	waiting []func()
}

func newSurfaceState() surfaceState {
	return surfaceState{held: map[string]*heldSurface{}, drawn: map[string]layout.Rect{}, applied: map[string]layout.Rect{}, seated: map[string]SidebarSeat{},
		views: map[string]*viewState{}, reports: map[string]*tabReport{}, failed: map[string]string{}, documents: map[string]map[string]bool{},
		detaching: map[string]bool{}, detachFailed: map[string]string{}, sessions: map[string]*storedSession{}, dataWrites: map[string]int{}}
}

// drawSeat draws the slot of a card: the native view of its active tab. box is the slot in window coordinates.
func (s *Shell) drawSeat(c *ui.Context, tab layout.Tab, box layout.Rect) {
	unit := s.units[tab.Plugin]
	switch {
	case unit == nil:
		s.drawPluginPlaceholder(c, tab.Plugin)
		return
	case unit.Composition == nil:
		ui.Text(c, tab.Plugin+" 플러그인에는 화면이 없습니다.").FontSize(s.textBody()).TextColor(s.palette.Muted)
		return
	}
	// A surface whose image detach is pending is not placed, so the host creates no view for it.
	if s.surfaces.detaching[tab.ID] {
		return
	}
	if reason, stopped := s.surfaces.stopped(tab.ID); stopped {
		ui.Text(c, reason).FontSize(s.textBody()).TextColor(s.palette.No)
		return
	}
	s.standSurface(c, &heldSurface{tab: tab, composition: unit.Composition, box: box}, box)
}

// drawSectionSeat draws the body of a section: the native view of its section surface. A seat that is not visible keeps its surface
// hidden, and a section that was never visible has none.
func (s *Shell) drawSectionSeat(c *ui.Context, seat SidebarSeat) {
	s.surfaces.seated[seat.SurfaceID] = seat
	if reason, stopped := s.surfaces.failed[seat.SurfaceID]; stopped {
		if seat.Visible {
			ui.Text(c, reason).FontSize(s.textBody()).TextColor(s.palette.No)
		}
		return
	}
	start := &sectionStart{ID: seat.Section, Sidebar: seat.Sidebar}
	if card, _, ok := strings.Cut(seat.Sidebar, ":"); ok {
		start.Card = &card
	}
	surface := &heldSurface{tab: layout.Tab{ID: seat.SurfaceID, Plugin: seat.Plugin}, composition: seat.Composition, box: seat.Box, section: start, unload: seat.Unload}
	// Every section of a set has its surface: a folded section and a section of an unselected tab keep it hidden. A hidden section that
	// the memory saver unloaded has none until it is shown (docs/spec/plugins.md#memory-saver).
	if !seat.Visible {
		if s.tabs == nil || !s.tabs.saver.Unloaded(seat.SurfaceID) {
			s.holdSurface(surface)
		}
		return
	}
	s.standSurface(c, surface, seat.Box)
}

// holdSurface makes the host hold a new surface from the next placement.
func (s *Shell) holdSurface(surface *heldSurface) {
	id := surface.tab.ID
	if s.surfaces.held[id] != nil {
		return
	}
	project := s.opened()
	surface.project = projectStart{ID: project.ID, Root: project.Root}
	// A surface drawn in the plane belongs to the shown project, and a hidden one names the project of its layout.
	if surface.owner == "" {
		surface.owner = project.ID
	}
	s.surfaces.held[id] = surface
	s.surfaces.order = append(s.surfaces.order, id)
}

// standSurface seats a surface in the frame at box, in window coordinates, and draws its native view. The host holds a new surface
// from the next placement.
func (s *Shell) standSurface(c *ui.Context, surface *heldSurface, box layout.Rect) {
	id := surface.tab.ID
	s.surfaces.drawn[id] = box
	s.holdSurface(surface)
	ui.Box(c.Key(SurfaceSlot{ID: id})).FillWidth().FillHeight().Role(ui.RoleGroup).Children(func() {
		if view, key, ok := s.options.Element(id); ok {
			// The framework rounds each edge of a native view to the nearest device pixel, as it does for an edge that it paints, so a
			// view and the lines beside it share their device pixels at any place of the plane.
			width, height := float32(box.W), float32(box.H)
			if s.dialogOpen() {
				// A hole paints only outside a blurred element, so the view stands over the blurred workbench in the same place.
				ui.Spacer(c).Size(width, height)
				s.surfaces.behindDialog = append(s.surfaces.behindDialog, viewBehindDialog{view, key, box, width, height})
				return
			}
			ui.NativeView(c, view, key).Size(width, height).ObserveInput(func(ev ui.InputEvent) {
				// A press reaches the content here while the host holds the views of a placement out of the pointer.
				if ev.Kind == ui.InputPointerDown {
					s.pressSurface(id)
				}
			})
		}
	})
}

// viewBehindDialog is a native view that the frame draws over the blurred workbench while a dialog is open.
type viewBehindDialog struct {
	view, key     uintptr
	box           layout.Rect
	width, height float32
}

// drawViewsBehindDialog draws the native views that the blurred workbench holds, each over its place.
func (s *Shell) drawViewsBehindDialog(c *ui.Context) {
	for _, behind := range s.surfaces.behindDialog {
		ui.NativeView(c, behind.view, behind.key).Absolute().Left(float32(behind.box.X)).Top(float32(behind.box.Y)).Size(behind.width, behind.height)
	}
	s.surfaces.behindDialog = s.surfaces.behindDialog[:0]
}

// pressSurface is a press on the card that holds a surface: the card of its tab or of its section, or the card of the window
// sidebar of its section. The press makes that card the scope of the text size and focuses it. A window sidebar takes no focus.
func (s *Shell) pressSurface(surface string) {
	if s.plane == nil {
		return
	}
	var sectionCard string
	if held := s.surfaces.held[surface]; held != nil && held.section != nil {
		sectionCard = held.section.Sidebar
		if held.section.Card != nil {
			sectionCard = *held.section.Card
		}
	}
	for _, card := range s.plane.Cards() {
		if card.ID != sectionCard && !s.cardHoldsTab(card.ID, surface) {
			continue
		}
		s.pressPlace(CardScope(card.ID))
		if !isPlace(card.ID) && s.focused != card.ID {
			s.focusCard(card.ID)
		}
		return
	}
}

// cardHoldsTab reports whether the card holds the tab.
func (s *Shell) cardHoldsTab(card, tab string) bool {
	held, err := s.cardData(card)
	if err != nil || held == nil {
		return false
	}
	for _, item := range held.TabList() {
		if item.ID == tab {
			return true
		}
	}
	return false
}

// forgetUnseated forgets the section surfaces that no sidebar of the frame holds: a section lives while a drawn set holds it. A frame
// of the library holds none, as the page empties its plane for the library; a frame that drew neither the plane nor the library tells
// nothing.
func (s *Shell) forgetUnseated() {
	if s.surfaces.drawnPlane == nil && !s.surfaces.drawnLibrary {
		return
	}
	var gone []string
	for _, id := range s.surfaces.order {
		if _, seated := s.surfaces.seated[id]; s.surfaces.held[id].section != nil && !seated {
			gone = append(gone, id)
		}
	}
	s.forgetSurfaces(gone)
}

// forgetSurfaces removes the surfaces of closed tabs: the next placement leaves them out, and the host closes their views.
func (s *Shell) forgetSurfaces(tabs []string) {
	for _, id := range tabs {
		if view := s.surfaces.views[id]; view != nil {
			if len(view.requests) > 0 {
				s.processes.loss(view.plugin).PeerLost += len(view.requests)
			}
			view.end()
		}
		s.processes.forgetView(id)
		delete(s.surfaces.held, id)
		delete(s.surfaces.failed, id)
		delete(s.surfaces.reports, id)
		delete(s.surfaces.views, id)
		delete(s.surfaces.documents, id)
		delete(s.surfaces.detaching, id)
		delete(s.surfaces.detachFailed, id)
	}
	s.syncNotices()
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
	for kind, own := range map[string][]json.RawMessage{"status": unit.Exposes.Status, "commands": unit.Exposes.Commands, "element": unit.Exposes.Element} {
		entries := []any{}
		for _, entry := range s.options.Declared.surface[kind] {
			entries = append(entries, entry)
		}
		for _, entry := range own {
			entries = append(entries, entry)
		}
		marks[kind] = entries
	}
	return marks, nil
}

// surfaceLine is what the placement of one surface depends on: its box of the frame, and the surface and the unit of its plugin,
// which are replaced and never changed. It compares with ==, so a value added here counts.
type surfaceLine struct {
	held    *heldSurface
	unit    *installedUnit
	visible bool
	dim     bool
	box     layout.Rect
}

// surfaceLines moves each surface that the frame seats to its box, and returns the lines of the surfaces.
func (s *Shell) surfaceLines() []surfaceLine {
	lines := make([]surfaceLine, 0, len(s.surfaces.order))
	for _, id := range s.surfaces.order {
		held := s.surfaces.held[id]
		box, visible := s.surfaces.drawn[id]
		if visible {
			held.box = box
		}
		lines = append(lines, surfaceLine{held: held, unit: s.units[held.tab.Plugin], visible: visible, dim: visible && s.surfaceDimmed(id), box: held.box})
	}
	return lines
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
		_, visible := s.surfaces.drawn[id]
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
		surfaces = append(surfaces, map[string]any{"id": id, "visible": visible, "dim": visible && s.surfaceDimmed(id), "plugin": unit.ID,
			"composition": held.composition, "x": held.box.X, "y": held.box.Y, "w": held.box.W, "h": held.box.H,
			"start": map[string]any{"params": tabMember(held.tab, "params", "null"), "origin": tabMember(held.tab, "origin", `{"directory":null}`),
				"project": held.project, "declarations": index, "diagnostics": rawOrNull(unit.Diagnostics), "section": held.section}})
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

// placementSource is the source of the error of a placement that failed, which the presentation of every surface after a later
// placement withdraws.
const placementSource = "placement"

// presentedRetry is the time before the wait for the surfaces asks again after an answer that they have not presented.
const presentedRetry = time.Second

// withdrawWhenPresented withdraws the error of a failed placement once every surface has presented. The failure names a surface that
// did not present, which the placement of another change does not end. A placement that fails during the wait keeps its failure, and
// the placement after it asks again. The record of the failure stays in the log.
func (s *Shell) withdrawWhenPresented() {
	if s.surfaces.withdrawing || s.surfaces.closed || !s.errors.ShownFrom(workbenchErrorPlace, placementSource) {
		return
	}
	s.surfaces.withdrawing = true
	s.calls.Call("waitPresented", nil, func(_ any, err error) {
		s.surfaces.withdrawing = false
		if s.surfaces.failure != nil {
			return
		}
		if err != nil {
			time.AfterFunc(presentedRetry, func() { s.options.Post(s.withdrawWhenPresented) })
			return
		}
		if s.errors.HideFrom(workbenchErrorPlace, placementSource) {
			s.options.Invalidate()
		}
	})
}

// placeSurfaces places the surfaces when the frame moved one of them. One placement runs at a time, and the frame that
// follows it places what changed meanwhile.
func (s *Shell) placeSurfaces() {
	if s.surfaces.running {
		return
	}
	lines := s.surfaceLines()
	// The host ends a run on a settled placement, so the end of a run places also when its last move placed these lines.
	runEnds := s.surfaces.going && s.held == nil
	if slices.Equal(lines, s.surfaces.placed) && !runEnds {
		s.afterKeyboard(s.surfaces.commits)
		s.surfaces.commits = nil
		return
	}
	if s.surfaces.layoutFault {
		// The placement fails without a change, so the next frame places the lines again, also when the window came back to
		// the lines of the last placement.
		s.surfaces.layoutFault = false
		s.surfaces.placing, s.surfaces.commits = s.surfaces.commits, nil
		s.surfaces.placed = nil
		s.placed(errors.New("surface presentation failed: " + layoutFaultText))
		s.options.Invalidate()
		return
	}
	request, err := s.surfaceRequest()
	if err != nil {
		s.fail(err)
		return
	}
	s.surfaces.placed = lines
	s.surfaces.running = true
	settledNow, _ := request["settled"].(bool) // silent: surfaceRequest writes settled as a bool.
	s.followRun(!settledNow)
	record := s.surfaceRecord(lines, settledNow)
	s.surfaces.latest = record
	s.surfaces.placedAt = s.options.Now()
	s.surfaces.placing, s.surfaces.commits = s.surfaces.commits, nil
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
	requested := slices.Clone(s.surfaces.order)
	s.calls.CallInOrder(surfaceOrder, "syncSurfaces", request, func(value any, err error) {
		if err != nil {
			s.placed(err)
			return
		}
		prepared, err := decode[struct {
			Ticket     json.RawMessage `json:"ticket"`
			Placements json.RawMessage `json:"placements"`
			Chrome     json.RawMessage `json:"chrome"`
		}](value)
		if err == nil {
			err = s.followChrome(prepared.Chrome)
		}
		if err != nil {
			s.placed(err)
			return
		}
		s.calls.CallInOrder(surfaceOrder, "presentSurfaces", map[string]any{"ticket": prepared.Ticket, "placements": prepared.Placements, "settled": settled},
			func(answer any, err error) {
				if err == nil {
					err = s.seatRecord(record, answer)
				}
				if err == nil {
					for _, id := range requested {
						if held := s.surfaces.held[id]; held != nil {
							held.hosted = true
						}
					}
				}
				s.placed(err)
				s.options.Invalidate()
			})
	})
}

// followRun tells each view the start of a run: an update that continues, such as a divider drag. The view asks for one frame, so
// the first size of the run waits for the display like every later size (docs/spec/native-surfaces.md#views).
func (s *Shell) followRun(going bool) {
	if going == s.surfaces.going {
		return
	}
	s.surfaces.going = going
	if !going {
		return
	}
	for surface, view := range s.surfaces.views {
		s.pushView(surface, view, "run-start", map[string]any{})
	}
}

// placed ends a placement.
func (s *Shell) placed(err error) {
	s.surfaces.running = false
	var failure *string
	if err != nil {
		s.errors.ShowFrom(workbenchErrorPlace, placementSource, err.Error(), "")
		s.options.Invalidate()
		text := err.Error()
		failure = &text
	}
	s.surfaces.failure = failure
	if err == nil {
		s.withdrawWhenPresented()
	}
	s.verifyLater()
	placing := s.surfaces.placing
	s.surfaces.placing = nil
	if err != nil {
		s.answerCommits(placing, err)
		return
	}
	s.afterKeyboard(placing)
	s.followKeyboard(false)
	s.endRestores()
}

// endRestores ends the restore of each restoring tab whose surface the host placed.
func (s *Shell) endRestores() {
	if s.tabs == nil {
		return
	}
	for _, id := range s.surfaces.order {
		if s.tabs.saver.State(id) != "restoring" {
			continue
		}
		s.storedSessionOf(id, func(session *storedSession) {
			if s.tabs.saver.State(id) == "restoring" {
				if err := s.tabs.saver.Restored(id, session.history); err != nil {
					s.fail(err)
				}
			}
		})
	}
}

func (s *Shell) answerCommits(commits []func(err error), err error) {
	for _, answer := range commits {
		answer(err)
	}
}

// commitSurfaces leaves the surfaces of the unloaded tabs out of the next placement, and answers after the host replied to it. A frame
// runs the placement.
func (s *Shell) commitSurfaces(answer func(err error)) {
	unloaded := s.tabs.saver.Place(s.surfaces.order).Unload
	s.forgetSurfaces(unloaded)
	// An unloaded tab keeps its label, which the report of its view held.
	for _, tab := range unloaded {
		if label := s.tabs.states.Label(tab); label != nil {
			s.report(tab).Title = *label
		}
	}
	s.afterPlacement(answer)
}

// afterPlacement answers after the host replied to the next placement and to the keyboard call that follows it. A frame runs
// the placement.
func (s *Shell) afterPlacement(answer func(err error)) {
	s.surfaces.commits = append(s.surfaces.commits, answer)
	s.options.Invalidate()
}
