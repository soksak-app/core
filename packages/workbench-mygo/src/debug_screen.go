package workbench

import (
	"fmt"
	"slices"
	"strconv"
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
	Channel     string `json:"channel"`
	Level       string `json:"level"`
	Layer       string `json:"layer"`
	Text        string `json:"text"`
	Class       string `json:"class"`
	Event       string `json:"event"`
	EventPrefix string `json:"event_prefix"`
	Surface     string `json:"surface"`
	Session     string `json:"session"`
	Cid         string `json:"cid"`
	Run         string `json:"run"`
	From        string `json:"from"`
	To          string `json:"to"`
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
	// Scroll receives the scroll position of the shown content.
	Scroll *ui.ScrollState
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
func DrawDebugView(c *ui.Context, binder *Binder, view DebugView, shown *ShownErrors) {
	theme := c.Theme()
	ui.Box(binder.Name(c, "core.debug.scrim", "")).Absolute().Left(0).Top(0).Right(0).Bottom(0).Center().Modal().Role(ui.RoleGroup).Label(debugName).Children(func() {
		ui.Column(binder.Name(c, "core.debug.card", "")).Width(view.CardWidth).MaxHeight(view.CardMaxHeight).Background(theme.Background).Border(1, theme.Border).
			Role(ui.RoleDialog).Label(debugName).Children(func() {
			ui.Row(c).FillWidth().AlignItems(ui.Center).Padding(8, 16).Children(func() {
				ui.Text(c, debugName).Grow(1)
				binder.Button(c, "core.debug.close", "core.debug.close", "", "닫는다", nil)
			})
			pane := ui.Scroll(c).Grow(1).FillWidth()
			if view.Scroll != nil {
				pane = pane.TrackScroll(view.Scroll)
			}
			pane.Children(func() {
				ui.Column(c).FillWidth().Gap(8).Padding(0, 16, 16, 16).Children(func() { drawDebugPane(c, binder, view, shown) })
			})
		})
	})
}

func drawDebugPane(c *ui.Context, binder *Binder, view DebugView, shown *ShownErrors) {
	ui.Text(c, "애플리케이션의 모든 진단 파일이다. 결함을 알릴 때 모두 저장한 파일을 함께 보낸다.").Wrap().TextColor(c.Theme().TextMuted)
	drawDebugActions(c, binder, view)
	if view.Failure != nil {
		shown.Show(debugErrorPlace, *view.Failure, "")
		DrawError(c, shown, debugErrorPlace)
	} else {
		shown.Hide(debugErrorPlace)
	}
	switch {
	case view.Viewing != nil:
		drawDebugFile(c, binder, *view.Viewing)
	case view.Timeline != nil:
		drawDebugTimeline(c, binder, *view.Timeline)
	case view.State != nil:
		drawDebugState(c, binder, *view.State)
	default:
		drawDebugList(c, binder, view.Entries)
	}
}

func drawDebugActions(c *ui.Context, binder *Binder, view DebugView) {
	operation := view.Operation
	saving := operation != nil && operation.Action == "save-all" && operation.State == "running"
	ui.Row(c).Gap(8).Children(func() {
		saveAll := binder.Control(c, "core.debug.save-all", "core.debug.save-all", "")
		if binder.Bound(ui.Button(c, "모두 저장"), "core.debug.save-all").Disabled(saving).Clicked() {
			saveAll(nil)
		}
		binder.Button(c, "core.debug.timeline", "core.debug.timeline", "", "타임라인", nil)
	})
	if saving && operation.Writing {
		ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Progress(binder.Name(c, "core.debug.progress", ""), float64(operation.Written)/float64(max(1, operation.Total))).Grow(1)
			ui.Text(c, megabytes(operation.Written)+" / "+megabytes(operation.Total)+" MB")
		})
	}
}

func drawDebugList(c *ui.Context, binder *Binder, entries []DebugEntry) {
	theme := c.Theme()
	states := DebugStateFiles(entries)
	for _, file := range entries {
		ui.Row(binder.Name(c, "core.debug.file", file.Path)).FillWidth().Gap(8).AlignItems(ui.Center).Role(ui.RoleRow).Label(file.Path).Children(func() {
			ui.Text(c, file.Path).Grow(1).SingleLine().Ellipsis("…")
			ui.Text(c, sizeText(file.Size)+" · "+timeText(file.Modified)).TextColor(theme.TextMuted)
			params := map[string]any{"path": file.Path}
			if slices.Contains(states, file.Path) {
				binder.Button(c, "core.debug.state", "core.debug.state", file.Path, "상태", params)
			}
			binder.Button(c, "core.debug.view", "core.debug.view", file.Path, "보기", params)
			binder.Button(c, "core.debug.save", "core.debug.save", file.Path, "저장", params)
		})
	}
}

func drawDebugFile(c *ui.Context, binder *Binder, file DebugShown) {
	theme := c.Theme()
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		binder.Button(c, "core.debug.list", "core.debug.list", "", "목록", nil)
		ui.Text(c, file.Path+" · "+sizeText(file.Size)).Grow(1).SingleLine().Ellipsis("…")
		if file.Truncated {
			ui.Text(c, "앞부분 생략").TextColor(theme.TextMuted)
		}
	})
	if file.Kind == "image" {
		ui.Image(binder.Name(c, "core.debug.image", ""), file.Image).Role(ui.RoleImage).Label(file.Path)
		return
	}
	ui.Text(binder.Name(c, "core.debug.text", ""), file.Text).Label(file.Text).Wrap().Selectable().Font(debugMonoFont)
}

func drawDebugLine(c *ui.Context, line string) {
	ui.Text(c, line).Label(line).Wrap().Selectable().Font(debugMonoFont)
}

func drawDebugState(c *ui.Context, binder *Binder, state DebugStateView) {
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		binder.Button(c, "core.debug.state.list", "core.debug.list", "", "목록", nil)
		ui.Text(c, state.Path).Grow(1).SingleLine().Ellipsis("…")
	})
	const without = "비교 안 함"
	with := state.With
	if with == "" {
		with = without
	}
	compare := binder.Control(c, "core.debug.state.with", "core.debug.state.compare", "")
	ui.Box(c).Role(ui.RoleGroup).Label("비교할 상태 파일").Children(func() {
		if binder.Bound(ui.Select(c, &with, append([]string{without}, state.Compare...)), "core.debug.state.with").Label("비교할 상태 파일").Changed() {
			chosen := with
			if chosen == without {
				chosen = ""
			}
			compare(map[string]any{"with": chosen})
		}
	})
	ui.Column(binder.Name(c, "core.debug.state.differences", "")).FillWidth().Role(ui.RoleGroup).Label("차이").Children(func() {
		for i, difference := range state.Differences {
			binder.Name(c, "core.debug.state.difference", strconv.Itoa(i))
			drawDebugLine(c, differenceLine(difference))
		}
	})
	ui.Column(binder.Name(c, "core.debug.state.tree", "")).FillWidth().Role(ui.RoleGroup).Label("상태").Children(func() {
		for i, line := range state.Lines {
			binder.Name(c, "core.debug.state.line", strconv.Itoa(i))
			drawDebugLine(c, line)
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

func drawDebugTimeline(c *ui.Context, binder *Binder, timeline DebugTimeline) {
	theme := c.Theme()
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		binder.Button(c, "core.debug.timeline.list", "core.debug.list", "", "목록", nil)
		label := "따라가기 다시 시작"
		if timeline.Following {
			label = "따라가기 멈춤"
		}
		binder.Button(c, "core.debug.timeline.follow", "core.debug.timeline.follow", "", label, map[string]any{"on": !timeline.Following})
		if timeline.Older {
			binder.Button(c, "core.debug.timeline.older", "core.debug.timeline.older", "", "이전 행", nil)
		}
		if timeline.Omitted > 0 {
			line := fmt.Sprintf("앞쪽 %d행은 보관하지 않음", timeline.Omitted)
			ui.Text(binder.Name(c, "core.debug.timeline.omitted", ""), line).Label(line).TextColor(theme.TextMuted)
		}
	})
	drawTimelineFilters(c, binder, timeline)
	ui.Row(c).FillWidth().Gap(8).AlignItems(ui.Center).Children(func() {
		binder.Button(c, "core.debug.timeline.save", "core.debug.timeline.save", "", "선택한 행 저장", nil)
		ui.Text(binder.Name(c, "core.debug.timeline.warning", ""), selectionWarning).Label(selectionWarning).TextColor(theme.TextMuted)
	})
	ui.Column(binder.Name(c, "core.debug.timeline.rows", "")).FillWidth().Role(ui.RoleGroup).Label("타임라인").Children(func() {
		for index, row := range timeline.Rows {
			drawTimelineRow(c, binder, index, row)
		}
	})
}

func drawTimelineRow(c *ui.Context, binder *Binder, index int, row DebugRow) {
	theme := c.Theme()
	ui.Row(c).FillWidth().Gap(8).Children(func() {
		mark, label := "○", "행 선택"
		if row.Selected {
			mark, label = "●", "행 선택 해제"
		}
		item := strconv.Itoa(index)
		binder.Button(c, "core.debug.timeline.select", "core.debug.timeline.select", item, mark, map[string]any{"row": index, "selected": !row.Selected}).Label(label)
		binder.Button(c, "core.debug.timeline.context", "core.debug.timeline.context", item, "주변", map[string]any{"row": index}).Label("행 주변 보기")
		line := ui.Text(binder.Name(c, "core.debug.timeline.row", item), row.Line).Label(row.Line).Grow(1).Wrap().Selectable().Font(debugMonoFont)
		if row.Context {
			line.TextColor(theme.TextMuted)
		}
		if row.Selected {
			line.Bold()
		}
	})
}

func drawTimelineFilters(c *ui.Context, binder *Binder, timeline DebugTimeline) {
	filter := timeline.Filter
	ui.Row(c).FillWidth().Gap(8).Wrap().Children(func() {
		drawFilterSelect(c, binder, "channel", "channel", "channel", filter.Channel, []string{"other", "debug", "all"})
		drawFilterSelect(c, binder, "level", "level", "가장 낮은 level", filter.Level, []string{"error", "warn", "info", "debug", "trace"})
		drawFilterSelect(c, binder, "layer", "layer", "layer", filter.Layer,
			[]string{"all", "native", "host", "workbench", "page", "plugin", "sidecar", "sok"})
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
			drawFilterField(c, binder, timeline, field.member, field.name, field.label, field.value)
		}
	})
}

func drawFilterSelect(c *ui.Context, binder *Binder, member, name, label, value string, options []string) {
	run := binder.Control(c, "core.debug.timeline."+name, "core.debug.timeline.filter", "")
	ui.Box(c).Role(ui.RoleGroup).Label(label).Children(func() {
		if binder.Bound(ui.Select(c, &value, options), "core.debug.timeline."+name).Label(label).Changed() {
			run(map[string]any{member: value})
		}
	})
}

// drawFilterField draws a text field of a filter member. It runs the filter when the field submits or loses the focus, as
// the change of an input does, so a query does not run for each key.
func drawFilterField(c *ui.Context, binder *Binder, timeline DebugTimeline, member, name, label, value string) {
	text, drafted := timeline.Drafts[member]
	if !drafted {
		text = value
	}
	run := binder.Control(c, "core.debug.timeline."+name, "core.debug.timeline.filter", "")
	field := binder.Bound(ui.TextInput(c, &text), "core.debug.timeline."+name).Placeholder(label).Label(label).Grow(1)
	if field.Changed() {
		timeline.Drafts[member] = text
		drafted = true
	}
	if drafted && (field.Submitted() || !field.Focused()) {
		delete(timeline.Drafts, member)
		run(map[string]any{member: text})
	}
}
