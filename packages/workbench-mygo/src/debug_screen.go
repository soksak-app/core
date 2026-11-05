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
	Style  DebugStyle
}

// DebugStyle is the look of the card: the colors of the theme, the chrome metrics of workbench.json that .set-card and .dbg-card of
// packages/workbench/app.css name, and the drawing of the close switch.
type DebugStyle struct {
	Card, Background, Edge, Rail, Fg, Muted                      ui.Color
	Border, Radius, ButtonRadius, Top                            float32
	HeadH, HeadGap, HeadPadStart, HeadPadEnd                     float32
	ShadowY, ShadowBlur, ShadowAlpha                             float32
	PanePadX, PaneTop, PaneBottom, ErrorGap                      float32
	RowGap, RowH, ActW, BarGap, CaptionGap                       float32
	ActionsGap, ActionsMargin, FieldPadY, Space1, Space2, Space3 float32
	LineHeight, TextControl, TextSmall                           float32
	Close                                                        func(c *ui.Context, button ui.Element, title string)
}

// button draws a button of the view, the .ui-button of packages/workbench/app.css.
func (st DebugStyle) button(c *ui.Context, binder *Binder, name, command, item, label string, params any) ui.Element {
	button := binder.Press(c, name, command, item, params)
	edge := st.Edge
	if button.Hovered() {
		edge = st.Rail
	}
	button.Padding(st.FieldPadY, st.Space3).Border(st.Border, edge).Radius(st.ButtonRadius).Background(st.Background).Center().Label(label).Children(func() {
		ui.Text(c, label).FontSize(st.TextControl).TextColor(st.Fg)
	})
	return button
}

// bar draws the head of a shown file, the .dbg-card__bar of packages/workbench/app.css: it stays at the top of the pane.
func (st DebugStyle) bar(c *ui.Context, children func()) {
	ui.Row(c).FillWidth().Sticky().Top(0).Gap(st.BarGap).AlignItems(ui.Center).MinHeight(st.RowH).Padding(st.Space1, 0).Margin(0, 0, st.Space3, 0).Background(st.Card).Children(children)
}

// path draws the name in a bar, the .dbg-card__path of packages/workbench/app.css.
func (st DebugStyle) path(c *ui.Context, text string) {
	ui.Text(c, text).Grow(1).SingleLine().Ellipsis("…").FontSize(st.TextControl).TextColor(st.Fg)
}

// mono draws the text of a file or a row, the .dbg-card__text and .dbg-card__rows of packages/workbench/app.css.
func (st DebugStyle) mono(text ui.Element) ui.Element {
	return text.Wrap().Selectable().Font(debugMonoFont).FontSize(st.TextSmall).LineHeight(st.LineHeight)
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
	st := view.Style
	ui.Box(binder.Name(c, "core.debug.scrim", "")).Absolute().Left(0).Top(0).Right(0).Bottom(0).Column().AlignItems(ui.Center).Padding(st.Top, 0, 0, 0).Background(dialogScrim).Modal().Role(ui.RoleGroup).Label(debugName).Children(func() {
		// The card takes the focus of the dialog, so a key presses no control before Tab or a press reaches one.
		ui.Column(binder.Name(c, "core.debug.card", "")).Focusable().FocusRing(false).Width(view.CardWidth).MaxHeight(view.CardMaxHeight).Background(st.Card).Border(st.Border, st.Edge).Radius(st.Radius).Clip().LineHeight(st.LineHeight).
			Shadow(0, st.ShadowY, st.ShadowBlur, 0, ui.RGBA(0, 0, 0, st.ShadowAlpha)).Role(ui.RoleDialog).Label(debugName).Children(func() {
			ui.Row(c).FillWidth().Height(st.HeadH).Shrink(0).Padding(0, st.HeadPadEnd, 0, st.HeadPadStart).Gap(st.HeadGap).AlignItems(ui.Center).
				BorderWidth(0, 0, st.Border, 0).BorderColor(st.Edge).Cursor(ui.CursorGrab).Children(func() {
				ui.Text(c, debugName).Grow(1).FontSize(st.TextControl).TextColor(st.Fg)
				st.Close(c, binder.Press(c, "core.debug.close", "core.debug.close", "", nil), "닫는다")
			})
			pane := ui.Scroll(c).Grow(1).FillWidth()
			if view.Scroll != nil {
				pane = pane.TrackScroll(view.Scroll)
			}
			pane.Children(func() {
				ui.Column(c).FillWidth().Padding(st.PaneTop, st.PanePadX, st.PaneBottom, st.PanePadX).Children(func() { drawDebugPane(c, binder, view, shown) })
			})
		})
	})
}

func drawDebugPane(c *ui.Context, binder *Binder, view DebugView, shown *ShownErrors) {
	st := view.Style
	ui.Text(c, "애플리케이션의 모든 진단 파일이다. 결함을 알릴 때 모두 저장한 파일을 함께 보낸다.").Wrap().LineHeight(st.LineHeight).FontSize(st.TextSmall).TextColor(st.Muted).Margin(0, 0, st.CaptionGap, 0)
	drawDebugActions(c, binder, view)
	if view.Failure != nil {
		shown.Show(debugErrorPlace, *view.Failure, "")
		ui.Box(c).FillWidth().Margin(0, 0, st.ErrorGap, 0).FontSize(st.TextSmall).Children(func() { DrawError(c, shown, debugErrorPlace) })
	} else {
		shown.Hide(debugErrorPlace)
	}
	switch {
	case view.Viewing != nil:
		drawDebugFile(c, binder, st, *view.Viewing)
	case view.Timeline != nil:
		drawDebugTimeline(c, binder, st, *view.Timeline)
	case view.State != nil:
		drawDebugState(c, binder, st, *view.State)
	default:
		drawDebugList(c, binder, st, view.Entries)
	}
}

func drawDebugActions(c *ui.Context, binder *Binder, view DebugView) {
	st := view.Style
	operation := view.Operation
	saving := operation != nil && operation.Action == "save-all" && operation.State == "running"
	ui.Row(c).Gap(st.ActionsGap).Wrap().Margin(0, 0, st.ActionsMargin, 0).Children(func() {
		st.button(c, binder, "core.debug.save-all", "core.debug.save-all", "", "모두 저장", nil).Disabled(saving)
		st.button(c, binder, "core.debug.timeline", "core.debug.timeline", "", "타임라인", nil)
	})
	if saving && operation.Writing {
		ui.Row(c).FillWidth().Gap(st.Space2).AlignItems(ui.Center).Margin(0, 0, st.Space2, 0).Children(func() {
			ui.Progress(binder.Name(c, "core.debug.progress", ""), float64(operation.Written)/float64(max(1, operation.Total))).Grow(1)
			ui.Text(c, megabytes(operation.Written)+" / "+megabytes(operation.Total)+" MB").FontSize(st.TextSmall).TextColor(st.Muted)
		})
	}
}

func drawDebugList(c *ui.Context, binder *Binder, st DebugStyle, entries []DebugEntry) {
	states := DebugStateFiles(entries)
	for _, file := range entries {
		ui.Row(binder.Name(c, "core.debug.file", file.Path)).FillWidth().Gap(st.RowGap).MinHeight(st.RowH).AlignItems(ui.Center).Role(ui.RoleRow).Label(file.Path).Children(func() {
			ui.Text(c, file.Path).Grow(1).SingleLine().Ellipsis("…").FontSize(st.TextControl).TextColor(st.Fg)
			ui.Text(c, sizeText(file.Size)+" · "+timeText(file.Modified)).FontSize(st.TextSmall).TextColor(st.Muted)
			params := map[string]any{"path": file.Path}
			// The three columns of actions stay in place on a row without the state of a file.
			ui.Row(c).Gap(st.Space2).Shrink(0).Children(func() {
				if slices.Contains(states, file.Path) {
					st.button(c, binder, "core.debug.state", "core.debug.state", file.Path, "상태", params).Width(st.ActW)
				} else {
					ui.Box(c).Width(st.ActW)
				}
				st.button(c, binder, "core.debug.view", "core.debug.view", file.Path, "보기", params).Width(st.ActW)
				st.button(c, binder, "core.debug.save", "core.debug.save", file.Path, "저장", params).Width(st.ActW)
			})
		})
	}
}

func drawDebugFile(c *ui.Context, binder *Binder, st DebugStyle, file DebugShown) {
	st.bar(c, func() {
		st.button(c, binder, "core.debug.list", "core.debug.list", "", "목록", nil)
		st.path(c, file.Path+" · "+sizeText(file.Size))
		if file.Truncated {
			ui.Text(c, "앞부분 생략").FontSize(st.TextSmall).TextColor(st.Muted)
		}
	})
	if file.Kind == "image" {
		ui.Image(binder.Name(c, "core.debug.image", ""), file.Image).Border(st.Border, st.Edge).Radius(st.ButtonRadius).Role(ui.RoleImage).Label(file.Path)
		return
	}
	st.mono(ui.Text(binder.Name(c, "core.debug.text", ""), file.Text).Label(file.Text)).TextColor(st.Fg)
}

func drawDebugLine(c *ui.Context, st DebugStyle, line string) {
	st.mono(ui.Text(c, line).Label(line)).TextColor(st.Fg)
}

func drawDebugState(c *ui.Context, binder *Binder, st DebugStyle, state DebugStateView) {
	st.bar(c, func() {
		st.button(c, binder, "core.debug.state.list", "core.debug.list", "", "목록", nil)
		st.path(c, state.Path)
	})
	const without = "비교 안 함"
	with := state.With
	if with == "" {
		with = without
	}
	compare := binder.Control(c, "core.debug.state.with", "core.debug.state.compare", "")
	ui.Box(c).Margin(0, 0, st.Space3, 0).Role(ui.RoleGroup).Label("비교할 상태 파일").Children(func() {
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
			drawDebugLine(c, st, differenceLine(difference))
		}
	})
	ui.Column(binder.Name(c, "core.debug.state.tree", "")).FillWidth().Role(ui.RoleGroup).Label("상태").Children(func() {
		for i, line := range state.Lines {
			binder.Name(c, "core.debug.state.line", strconv.Itoa(i))
			drawDebugLine(c, st, line)
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

func drawDebugTimeline(c *ui.Context, binder *Binder, st DebugStyle, timeline DebugTimeline) {
	st.bar(c, func() {
		st.button(c, binder, "core.debug.timeline.list", "core.debug.list", "", "목록", nil)
		label := "따라가기 다시 시작"
		if timeline.Following {
			label = "따라가기 멈춤"
		}
		st.button(c, binder, "core.debug.timeline.follow", "core.debug.timeline.follow", "", label, map[string]any{"on": !timeline.Following})
		if timeline.Older {
			st.button(c, binder, "core.debug.timeline.older", "core.debug.timeline.older", "", "이전 행", nil)
		}
		if timeline.Omitted > 0 {
			line := fmt.Sprintf("앞쪽 %d행은 보관하지 않음", timeline.Omitted)
			ui.Text(binder.Name(c, "core.debug.timeline.omitted", ""), line).Label(line).FontSize(st.TextSmall).TextColor(st.Muted)
		}
	})
	drawTimelineFilters(c, binder, st, timeline)
	ui.Row(c).FillWidth().Gap(st.Space2).AlignItems(ui.Center).Children(func() {
		st.button(c, binder, "core.debug.timeline.save", "core.debug.timeline.save", "", "선택한 행 저장", nil)
		ui.Text(binder.Name(c, "core.debug.timeline.warning", ""), selectionWarning).Label(selectionWarning).FontSize(st.TextSmall).TextColor(st.Muted)
	})
	ui.Column(binder.Name(c, "core.debug.timeline.rows", "")).FillWidth().Role(ui.RoleGroup).Label("타임라인").Children(func() {
		for index, row := range timeline.Rows {
			drawTimelineRow(c, binder, st, index, row)
		}
	})
}

func drawTimelineRow(c *ui.Context, binder *Binder, st DebugStyle, index int, row DebugRow) {
	ui.Row(c).FillWidth().Gap(st.Space2).Children(func() {
		mark, label := "○", "행 선택"
		if row.Selected {
			mark, label = "●", "행 선택 해제"
		}
		item := strconv.Itoa(index)
		st.button(c, binder, "core.debug.timeline.select", "core.debug.timeline.select", item, mark, map[string]any{"row": index, "selected": !row.Selected}).Label(label)
		st.button(c, binder, "core.debug.timeline.context", "core.debug.timeline.context", item, "주변", map[string]any{"row": index}).Label("행 주변 보기")
		line := st.mono(ui.Text(binder.Name(c, "core.debug.timeline.row", item), row.Line).Label(row.Line)).Grow(1).TextColor(st.Fg)
		if row.Context {
			line.TextColor(st.Muted)
		}
		if row.Selected {
			line.Bold()
		}
	})
}

func drawTimelineFilters(c *ui.Context, binder *Binder, st DebugStyle, timeline DebugTimeline) {
	filter := timeline.Filter
	ui.Row(c).FillWidth().Gap(st.Space2).Wrap().Margin(0, 0, st.Space3, 0).Children(func() {
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
