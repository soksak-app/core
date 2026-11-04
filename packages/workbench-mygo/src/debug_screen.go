package workbench

import (
	"fmt"
	"slices"
	"time"

	"github.com/egoist/mygo/ui"
)

// The debug view (docs/spec/debug.md): a dialog that lists the files of the logs folder and shows a file, a state file or the
// timeline of the event files. It draws the values of `core.debug`, and the shell runs its commands.

const (
	debugName        = "디버그"
	debugErrorPlace  = "debug"
	selectionWarning = "저장한 파일에는 입력한 글자가 들어 있을 수 있다."
	debugMonoFont    = "monospace"
)

// DebugShown is the file that the view shows. Kind is `text` or `image`, and Image is set for an image.
type DebugShown struct {
	Path      string
	Size      int64
	Truncated bool
	Kind      string
	Text      string
	Image     ui.ImageSource
}

// DebugStateView is the state file that the view shows: its tree lines, the state file it is compared with or empty, the
// differences, and the state files of the list that it can be compared with.
type DebugStateView struct {
	Path        string
	Lines       []string
	With        string
	Differences []DebugDifference
	Compare     []string
}

// DebugFilter is the filter of the timeline, whose members are the parameters of `core.debug.timeline.filter`.
type DebugFilter struct {
	Channel, Level, Layer                    string
	Text, Class, Event, EventPrefix, Surface string
	Session, Cid, Run, From, To              string
}

// DebugRow is a row of the timeline: its text line, with two spaces before a row that is only context.
type DebugRow struct {
	Line     string
	Context  bool
	Selected bool
}

// DebugTimeline is the shown timeline. Drafts holds the text of a filter field that has not been submitted, by its filter
// member, and lives across builds, so the shell keeps it with the timeline.
type DebugTimeline struct {
	Filter    DebugFilter
	Rows      []DebugRow
	Older     bool
	Following bool
	Omitted   int
	Drafts    map[string]string
}

// DebugOperation is the running or last operation. Writing is set with Written and Total for a save of the logs folder.
type DebugOperation struct {
	Action  string
	Path    string
	State   string
	Written int64
	Total   int64
	Writing bool
}

// DebugView is what the debug view draws. At most one of Viewing, Timeline and State is set, and without one the view shows
// the list.
type DebugView struct {
	// CardWidth is the chrome metric `dbg-card-w` of workbench.json, and CardMaxHeight is `set-card-max-h` of the window height.
	CardWidth     float32
	CardMaxHeight float32
	Entries       []DebugEntry
	Viewing       *DebugShown
	Timeline      *DebugTimeline
	State         *DebugStateView
	Operation     *DebugOperation
	Failure       *string
}

func sizeText(size int64) string {
	switch {
	case size < 1024:
		return fmt.Sprintf("%d B", size)
	case size < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(size)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(size)/1024/1024)
}

// timeText is a modification time in milliseconds since the epoch as local text.
func timeText(modified int64) string { return time.UnixMilli(modified).Format(time.DateTime) }

func megabytes(size int64) string { return fmt.Sprintf("%.1f", float64(size)/1024/1024) }

// DrawDebugView draws the scrim and the card of the view.
func DrawDebugView(c *ui.Context, names *ElementNames, view DebugView, shown *ShownErrors, run RunCommand) {
	theme := c.Theme()
	ui.Box(c.Key(names.Next("core.debug.scrim"))).Fill().Center().Role(ui.RoleGroup).Label(debugName).Children(func() {
		ui.Column(c.Key(names.Next("core.debug.card"))).Width(view.CardWidth).MaxHeight(view.CardMaxHeight).Background(theme.Background).Border(1, theme.Border).
			Role(ui.RoleDialog).Label(debugName).Children(func() {
			ui.Row(c).FillWidth().AlignItems(ui.Center).Padding(8, 16).Children(func() {
				ui.Text(c, debugName).Grow(1)
				if ui.Button(c.Key(names.Next("core.debug.close")), "닫는다").Clicked() {
					run("core.debug.close", map[string]any{})
				}
			})
			ui.Scroll(c).Grow(1).FillWidth().Children(func() {
				ui.Column(c).FillWidth().Gap(8).Padding(0, 16, 16, 16).Children(func() { drawDebugPane(c, names, view, shown, run) })
			})
		})
	})
}

func drawDebugPane(c *ui.Context, names *ElementNames, view DebugView, shown *ShownErrors, run RunCommand) {
	ui.Text(c, "애플리케이션의 모든 진단 파일이다. 결함을 알릴 때 모두 저장한 파일을 함께 보낸다.").Wrap().TextColor(c.Theme().TextMuted)
	drawDebugActions(c, names, view, run)
	if view.Failure != nil {
		shown.Show(debugErrorPlace, *view.Failure, "")
		DrawError(c, shown, debugErrorPlace)
	} else {
		shown.Hide(debugErrorPlace)
	}
	switch {
	case view.Viewing != nil:
		drawDebugFile(c, names, *view.Viewing, run)
	case view.Timeline != nil:
		drawDebugTimeline(c, names, *view.Timeline, run)
	case view.State != nil:
		drawDebugState(c, names, *view.State, run)
	default:
		drawDebugList(c, names, view.Entries, run)
	}
}

func drawDebugActions(c *ui.Context, names *ElementNames, view DebugView, run RunCommand) {
	operation := view.Operation
	saving := operation != nil && operation.Action == "save-all" && operation.State == "running"
	ui.Row(c).Gap(8).Children(func() {
		if ui.Button(c.Key(names.Next("core.debug.save-all")), "모두 저장").Disabled(saving).Clicked() {
			run("core.debug.save-all", map[string]any{})
		}
		if ui.Button(c.Key(names.Next("core.debug.timeline")), "타임라인").Clicked() {
			run("core.debug.timeline", map[string]any{})
		}
	})
	if saving && operation.Writing {
		ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Progress(c.Key(names.Next("core.debug.progress")), float64(operation.Written)/float64(max(1, operation.Total))).Grow(1)
			ui.Text(c, megabytes(operation.Written)+" / "+megabytes(operation.Total)+" MB")
		})
	}
}

func drawDebugList(c *ui.Context, names *ElementNames, entries []DebugEntry, run RunCommand) {
	theme := c.Theme()
	states := DebugStateFiles(entries)
	command := func(element ui.Element, name, path string) {
		if element.Clicked() {
			run(name, map[string]any{"path": path})
		}
	}
	for _, file := range entries {
		ui.Row(c.Key(names.Next("core.debug.file"))).FillWidth().Gap(8).AlignItems(ui.Center).Role(ui.RoleRow).Label(file.Path).Children(func() {
			ui.Text(c, file.Path).Grow(1).NoWrap().Ellipsis("…")
			ui.Text(c, sizeText(file.Size)+" · "+timeText(file.Modified)).TextColor(theme.TextMuted)
			if slices.Contains(states, file.Path) {
				command(ui.Button(c.Key(names.Next("core.debug.state")), "상태"), "core.debug.state", file.Path)
			}
			command(ui.Button(c.Key(names.Next("core.debug.view")), "보기"), "core.debug.view", file.Path)
			command(ui.Button(c.Key(names.Next("core.debug.save")), "저장"), "core.debug.save", file.Path)
		})
	}
}

func drawDebugFile(c *ui.Context, names *ElementNames, file DebugShown, run RunCommand) {
	theme := c.Theme()
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		if ui.Button(c.Key(names.Next("core.debug.list")), "목록").Clicked() {
			run("core.debug.list", map[string]any{})
		}
		ui.Text(c, file.Path+" · "+sizeText(file.Size)).Grow(1).NoWrap().Ellipsis("…")
		if file.Truncated {
			ui.Text(c, "앞부분 생략").TextColor(theme.TextMuted)
		}
	})
	if file.Kind == "image" {
		ui.Image(c.Key(names.Next("core.debug.image")), file.Image).Role(ui.RoleImage).Label(file.Path)
		return
	}
	ui.Text(c, file.Text).Key(names.Next("core.debug.text")).Label(file.Text).Wrap().Selectable().Font(debugMonoFont)
}

func drawDebugLine(c *ui.Context, name ElementName, line string) {
	ui.Text(c, line).Key(name).Label(line).Wrap().Selectable().Font(debugMonoFont)
}

func drawDebugState(c *ui.Context, names *ElementNames, state DebugStateView, run RunCommand) {
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		if ui.Button(c.Key(names.Next("core.debug.state.list")), "목록").Clicked() {
			run("core.debug.list", map[string]any{})
		}
		ui.Text(c, state.Path).Grow(1).NoWrap().Ellipsis("…")
	})
	const without = "비교 안 함"
	with := state.With
	if with == "" {
		with = without
	}
	ui.Box(c.Key(names.Next("core.debug.state.with"))).Role(ui.RoleGroup).Label("비교할 상태 파일").Children(func() {
		if ui.Select(c, &with, append([]string{without}, state.Compare...)).Label("비교할 상태 파일").Changed() {
			chosen := with
			if chosen == without {
				chosen = ""
			}
			run("core.debug.state.compare", map[string]any{"with": chosen})
		}
	})
	ui.Column(c.Key(names.Next("core.debug.state.differences"))).FillWidth().Role(ui.RoleGroup).Label("차이").Children(func() {
		for _, difference := range state.Differences {
			drawDebugLine(c, names.Next("core.debug.state.difference"), differenceLine(difference))
		}
	})
	ui.Column(c.Key(names.Next("core.debug.state.tree"))).FillWidth().Role(ui.RoleGroup).Label("상태").Children(func() {
		for _, line := range state.Lines {
			drawDebugLine(c, names.Next("core.debug.state.line"), line)
		}
	})
}

func differenceLine(difference DebugDifference) string {
	value := func(text *string) string {
		if text == nil {
			return "(없음)"
		}
		return *text
	}
	return fmt.Sprintf("%s: %s -> %s", difference.Path, value(difference.A), value(difference.B))
}

func drawDebugTimeline(c *ui.Context, names *ElementNames, timeline DebugTimeline, run RunCommand) {
	theme := c.Theme()
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		if ui.Button(c.Key(names.Next("core.debug.timeline.list")), "목록").Clicked() {
			run("core.debug.list", map[string]any{})
		}
		label := "따라가기 다시 시작"
		if timeline.Following {
			label = "따라가기 멈춤"
		}
		if ui.Button(c.Key(names.Next("core.debug.timeline.follow")), label).Clicked() {
			run("core.debug.timeline.follow", map[string]any{"on": !timeline.Following})
		}
		if timeline.Older && ui.Button(c.Key(names.Next("core.debug.timeline.older")), "이전 행").Clicked() {
			run("core.debug.timeline.older", map[string]any{})
		}
		if timeline.Omitted > 0 {
			line := fmt.Sprintf("앞쪽 %d행은 보관하지 않음", timeline.Omitted)
			ui.Text(c, line).Key(names.Next("core.debug.timeline.omitted")).Label(line).TextColor(theme.TextMuted)
		}
	})
	drawTimelineFilters(c, names, timeline, run)
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		if ui.Button(c.Key(names.Next("core.debug.timeline.save")), "선택한 행 저장").Clicked() {
			run("core.debug.timeline.save", map[string]any{})
		}
		ui.Text(c, selectionWarning).Key(names.Next("core.debug.timeline.warning")).Label(selectionWarning).TextColor(theme.TextMuted)
	})
	ui.Column(c.Key(names.Next("core.debug.timeline.rows"))).FillWidth().Role(ui.RoleGroup).Label("타임라인").Children(func() {
		for index, row := range timeline.Rows {
			drawTimelineRow(c, names, index, row, run)
		}
	})
}

func drawTimelineRow(c *ui.Context, names *ElementNames, index int, row DebugRow, run RunCommand) {
	theme := c.Theme()
	ui.Row(c).FillWidth().Gap(8).Children(func() {
		mark, label := "○", "행 선택"
		if row.Selected {
			mark, label = "●", "행 선택 해제"
		}
		if ui.Button(c.Key(names.Next("core.debug.timeline.select")), mark).Label(label).Clicked() {
			run("core.debug.timeline.select", map[string]any{"row": index, "selected": !row.Selected})
		}
		if ui.Button(c.Key(names.Next("core.debug.timeline.context")), "주변").Label("행 주변 보기").Clicked() {
			run("core.debug.timeline.context", map[string]any{"row": index})
		}
		line := ui.Text(c, row.Line).Key(names.Next("core.debug.timeline.row")).Label(row.Line).Grow(1).Wrap().Selectable().Font(debugMonoFont)
		if row.Context {
			line.TextColor(theme.TextMuted)
		}
		if row.Selected {
			line.Bold()
		}
	})
}

func drawTimelineFilters(c *ui.Context, names *ElementNames, timeline DebugTimeline, run RunCommand) {
	filter := timeline.Filter
	ui.Row(c).FillWidth().Gap(8).Wrap().Children(func() {
		drawFilterSelect(c, names, "channel", "channel", "channel", filter.Channel, []string{"other", "debug", "all"}, run)
		drawFilterSelect(c, names, "level", "level", "가장 낮은 level", filter.Level, []string{"error", "warn", "info", "debug", "trace"}, run)
		drawFilterSelect(c, names, "layer", "layer", "layer", filter.Layer,
			[]string{"all", "native", "host", "workbench", "page", "plugin", "sidecar", "sok"}, run)
		for _, field := range []struct{ member, name, label, value string }{
			{"text", "text", "찾을 글자", filter.Text},
			{"class", "class", "class", filter.Class},
			{"event", "event", "event 이름", filter.Event},
			{"event_prefix", "event-prefix", "event 이름의 앞부분", filter.EventPrefix},
			{"surface", "surface", "surface", filter.Surface},
			{"session", "session", "session", filter.Session},
			{"cid", "cid", "correlation identifier", filter.Cid},
			{"run", "run", "run 식별자", filter.Run},
			{"from", "from", "시작 시각 (UTC)", filter.From},
			{"to", "to", "끝 시각 (UTC)", filter.To},
		} {
			drawFilterField(c, names, timeline, field.member, field.name, field.label, field.value, run)
		}
	})
}

func drawFilterSelect(c *ui.Context, names *ElementNames, member, name, label, value string, options []string, run RunCommand) {
	ui.Box(c.Key(names.Next("core.debug.timeline." + name))).Role(ui.RoleGroup).Label(label).Children(func() {
		if ui.Select(c, &value, options).Label(label).Changed() {
			run("core.debug.timeline.filter", map[string]any{member: value})
		}
	})
}

// drawFilterField draws a text field of a filter member. It runs the filter when the field submits or loses the focus, as
// the change of an input does, so a query does not run for each key.
func drawFilterField(c *ui.Context, names *ElementNames, timeline DebugTimeline, member, name, label, value string, run RunCommand) {
	ui.Box(c.Key(names.Next("core.debug.timeline." + name))).Grow(1).Role(ui.RoleGroup).Label(label).Children(func() {
		text, drafted := timeline.Drafts[member]
		if !drafted {
			text = value
		}
		field := ui.TextInput(c, &text).Placeholder(label).Label(label).FillWidth()
		if field.Changed() {
			timeline.Drafts[member] = text
			drafted = true
		}
		if drafted && (field.Submitted() || !field.Focused()) {
			delete(timeline.Drafts, member)
			run("core.debug.timeline.filter", map[string]any{member: text})
		}
	})
}
