package workbench

import (
	"fmt"
	"slices"
	"time"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// endedCallsKept is the number of ended commands of a view whose replies are still recognized as late, as ENDED_CALLS_KEPT of
// packages/plugin-api/calls.js holds it.
const endedCallsKept = 256

// pluginCall is a command that a view has not answered.
type pluginCall struct {
	id, started uint64
	plugin      string
}

// openCallRow is a row of core.plugin.open-calls.
type openCallRow struct {
	Plugin          string `json:"plugin"`
	Count           int    `json:"count"`
	OldestStartedAt uint64 `json:"oldestStartedAt"`
}

// lossRow is a row of core.plugin.losses.
type lossRow struct {
	Plugin      string `json:"plugin"`
	Abandoned   int    `json:"abandoned"`
	LateReplies int    `json:"lateReplies"`
	PeerLost    int    `json:"peerLost"`
}

// viewRow is a row of core.plugin.views.
type viewRow struct {
	Plugin     string `json:"plugin"`
	Surface    string `json:"surface"`
	Responsive bool   `json:"responsive"`
}

// pluginProcesses holds the core statuses of the plugin processes: the open commands in the order of their start, the losses of each plugin
// in the order of their first count, and the responsiveness of each view in the order of its first notice.
type pluginProcesses struct {
	calls  []pluginCall
	losses []*lossRow
	views  []*viewRow
}

func (p *pluginProcesses) openCall(id uint64, plugin string) {
	p.calls = append(p.calls, pluginCall{id: id, started: uint64(time.Now().UnixMilli()), plugin: plugin})
}

func (p *pluginProcesses) closeCall(id uint64) {
	p.calls = slices.DeleteFunc(p.calls, func(call pluginCall) bool { return call.id == id })
}

// openCalls is the open commands of each plugin that has one.
func (p *pluginProcesses) openCalls() []openCallRow {
	rows := []openCallRow{}
	for _, call := range p.calls {
		at := slices.IndexFunc(rows, func(row openCallRow) bool { return row.Plugin == call.plugin })
		if at < 0 {
			rows = append(rows, openCallRow{Plugin: call.plugin, OldestStartedAt: call.started})
			at = len(rows) - 1
		}
		rows[at].Count++
	}
	return rows
}

// loss is the row of plugin, which its first count adds.
func (p *pluginProcesses) loss(plugin string) *lossRow {
	for _, row := range p.losses {
		if row.Plugin == plugin {
			return row
		}
	}
	row := &lossRow{Plugin: plugin}
	p.losses = append(p.losses, row)
	return row
}

func (p *pluginProcesses) lossList() []lossRow {
	rows := make([]lossRow, len(p.losses))
	for i, row := range p.losses {
		rows[i] = *row
	}
	return rows
}

func (p *pluginProcesses) viewList() []viewRow {
	rows := make([]viewRow, len(p.views))
	for i, row := range p.views {
		rows[i] = *row
	}
	return rows
}

func (p *pluginProcesses) forgetView(surface string) {
	p.views = slices.DeleteFunc(p.views, func(row *viewRow) bool { return row.Surface == surface })
}

// viewResponsiveness records the notice of the host about the view of a surface. A notice of another generation than the running view is left.
func (s *Shell) viewResponsiveness(data []any) {
	if len(data) != 1 {
		return
	}
	event, err := decode[struct {
		Surface    string `json:"surface"`
		Plugin     string `json:"plugin"`
		Generation uint64 `json:"generation"`
		Responsive *bool  `json:"responsive"`
	}](data[0])
	if err != nil {
		s.fail(fmt.Errorf("view responsiveness: %w", err))
		return
	}
	view := s.surfaces.views[event.Surface]
	if view == nil || view.generation != event.Generation {
		fields := map[string]any{"plugin": event.Plugin, "surface": event.Surface, "event": "view-responsiveness"}
		s.events.Emit(sok.LevelDebug, "workbench.view.event.cancel", func() map[string]any { return fields }, nil)
		return
	}
	if event.Responsive == nil {
		s.fail(fmt.Errorf("view %s responsive is not a boolean", event.Surface))
		return
	}
	s.options.Invalidate()
	for _, row := range s.processes.views {
		if row.Surface == event.Surface {
			row.Responsive = *event.Responsive
			return
		}
	}
	s.processes.views = append(s.processes.views, &viewRow{Plugin: view.plugin, Surface: event.Surface, Responsive: *event.Responsive})
}

// presentationAbandoned counts a presentation wait that ended without the presentation of the view.
func (s *Shell) presentationAbandoned(data []any) {
	if len(data) != 1 {
		return
	}
	event, err := decode[struct {
		Surface string `json:"surface"`
	}](data[0])
	if err != nil {
		s.fail(fmt.Errorf("view presentation abandoned: %w", err))
		return
	}
	held := s.surfaces.held[event.Surface]
	if held == nil {
		return
	}
	s.processes.loss(held.tab.Plugin).Abandoned++
	s.options.Invalidate()
}
