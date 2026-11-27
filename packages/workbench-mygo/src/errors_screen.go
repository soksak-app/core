package workbench

import (
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"
)

// workbenchErrorPlace is the place of the error banner, as createErrorDisplay of packages/workbench/page-layout.js names it.
const workbenchErrorPlace = "workbench"

// homeErrorPlace is the place of the error line of the project home.
const homeErrorPlace = "home"

// The limits of a notice of packages/workbench/notices.js: the title is its first line, and the text is the rest.
const (
	toastTitleMax = 120
	toastTextMax  = 1024
	// toastCardLimit is the number of toasts that the card form shows before it counts the rest (TOAST_LIMIT of notice-view.js).
	toastCardLimit = 3
)

// ShownErrors records the error of an origin when it appears and holds the error notices that the window displays.
type ShownErrors struct {
	report      func(line string)
	occurrences map[errorOrigin]string
	// toasts holds the shown notices, oldest first. An occurrence whose title matches a shown notice merges into it.
	toasts []*errorToast
	seq    int
	// schedule starts a timer of ms milliseconds that calls expire, and returns the function that cancels it.
	schedule func(ms int64, expire func()) (cancel func())
	expired  func()
	now      func() time.Time
	// autoDismiss states whether a toast closes by its own deadline, and deadline the delay in milliseconds; the settings of
	// the workbench hold both and ConfigureToastDeadline applies their change.
	autoDismiss bool
	deadline    int64
	// noticeOpen is whether the notice center is open, and noticeFilter its filter (notice_store.go).
	noticeOpen   bool
	noticeFilter string
	// shownNotice is the entry that core.notices.show marked as the shown entry, or "" when none was shown.
	shownNotice string
	// toastListOpen is whether the line form shows the list of its other toasts (core.toasts.list).
	toastListOpen bool
}

type errorOrigin struct {
	where  string
	source string
}

// errorToast is a shown error notice. Its count is the number of occurrences that merged into it (docs/spec/notifications.md#notices).
// A toast with a deadline runs its timer for span milliseconds from startedAt; a held toast keeps span as its remaining time and runs no timer.
type errorToast struct {
	id      string
	title   string
	text    string
	count   int
	origins map[errorOrigin]struct{}
	timed   bool
	held    bool
	cancel  func()
	// startedAt and span are the start and the length of the running deadline.
	startedAt time.Time
	span      int64
	// kind, source, actions, at, read and progress are the fields of the notice (notice_store.go); an error toast has kind error.
	kind     string
	source   NoticeSource
	actions  []NoticeAction
	at       time.Time
	read     bool
	progress *float64
	// closed is set when the toast is closed: the record stays an entry of the center.
	closed bool
	// origin is the origin that shows the notice through NotifyFrom, "" for a notice without one.
	origin string
}

// NewShownErrors returns the display that writes each line with report.
func NewShownErrors(report func(line string)) *ShownErrors {
	return &ShownErrors{
		report: report, occurrences: map[errorOrigin]string{}, now: time.Now, noticeFilter: "all",
	}
}

// UseClock sets the clock that the deadlines of the toasts read.
func (e *ShownErrors) UseClock(now func() time.Time) {
	e.now = now
}

// splitNotice returns the title and the text of an error: the first line is the title and the rest is the text, and each is cut
// to its limit. The cut text of the title moves into the text, as titleAndText of packages/workbench/shown-errors.js does.
func splitNotice(message string) (title, text string) {
	first, rest, hasRest := strings.Cut(message, "\n")
	body := []string{}
	if utf8.RuneCountInString(first) > toastTitleMax {
		runes := []rune(first)
		body = append(body, string(runes[toastTitleMax:]))
		first = string(runes[:toastTitleMax])
	}
	if hasRest {
		body = append(body, rest)
	}
	text = strings.Join(body, "\n")
	if runes := []rune(text); len(runes) > toastTextMax {
		text = string(runes[:toastTextMax])
	}
	if first == "" {
		first = "error"
	}
	return first, text
}

// Show shows the error of where in the window's toast component; the control whose operation failed keeps its label
// (docs/spec/exposure.md), as showError of packages/workbench/shown-errors.js does.
func (e *ShownErrors) Show(where, text, detail string) {
	e.ShowToast(where, text, detail)
}

// ShowToast shows the error of where in the window's toast component. A new error of the workbench can stack with its earlier errors.
func (e *ShownErrors) ShowToast(where, text, detail string) {
	e.showToast(errorOrigin{where: where}, text, detail)
}

func (e *ShownErrors) showToast(origin errorOrigin, text, detail string) {
	title, body := splitNotice(text)
	if previous, ok := e.occurrences[origin]; ok {
		if previous == text {
			return
		}
		// The same origin with a new text of the same title merges into its notice.
		if at := e.toastIndex(title); at != -1 && slices.Contains(e.originsOf(e.toasts[at]), origin) {
			e.occurrences[origin] = text
			e.toasts[at].text = body
			e.toasts[at].count++
			e.report(origin.where + ": " + text + detail)
			return
		}
		if origin.where != workbenchErrorPlace || origin.source != "" {
			e.removeToastOrigin(origin)
		}
	}
	e.occurrences[origin] = text
	at := e.toastIndex(title)
	if at == -1 {
		e.seq++
		toast := &errorToast{id: fmt.Sprintf("notice-%d", e.seq), kind: "error", title: title, text: body, count: 1,
			origins: map[errorOrigin]struct{}{origin: {}}, source: NoticeSource{Kind: "core"}, actions: []NoticeAction{}, at: e.now()}
		e.toasts = append(e.toasts, toast)
		e.scheduleToast(toast)
	} else {
		e.toasts[at].text = body
		e.toasts[at].count++
		e.toasts[at].origins[origin] = struct{}{}
	}
	e.report(origin.where + ": " + text + detail)
}

// originsOf returns the origins that hold the notice.
func (e *ShownErrors) originsOf(toast *errorToast) []errorOrigin {
	origins := make([]errorOrigin, 0, len(toast.origins))
	for origin := range toast.origins {
		origins = append(origins, origin)
	}
	return origins
}

func (e *ShownErrors) toastIndex(title string) int {
	return slices.IndexFunc(e.toasts, func(toast *errorToast) bool { return !toast.closed && toast.kind == "error" && toast.title == title })
}

// CloseNotice closes the toast with the id and reports whether it was shown. Its occurrences stay active, so a redraw of the same
// text does not show it again; a new text of its origin shows a new toast.
func (e *ShownErrors) CloseNotice(id string) bool {
	at := slices.IndexFunc(e.toasts, func(toast *errorToast) bool { return !toast.closed && toast.id == id })
	if at == -1 {
		return false
	}
	e.closeToast(at)
	return true
}

func (e *ShownErrors) closeToast(at int) {
	toast := e.toasts[at]
	toast.closed = true
	toast.stopTimer()
}

func (toast *errorToast) stopTimer() {
	if toast.cancel != nil {
		toast.cancel()
		toast.cancel = nil
	}
}

// Hold pauses the deadline of the toast with the id while held is true, and resumes it with its remaining time when held is false.
// The window calls it with the pointer or the keyboard focus on the toast, so a person who reads the toast keeps it open.
func (e *ShownErrors) Hold(id string, held bool) {
	toast := e.recordOf(id)
	if toast == nil || toast.closed {
		return
	}
	if toast.held == held {
		return
	}
	if !toast.timed {
		toast.held = held
		return
	}
	if held {
		toast.span = e.remainingOf(toast)
		toast.stopTimer()
		toast.held = true
		return
	}
	toast.held = false
	e.scheduleSpan(toast, toast.span)
}

// StartToastExpiry also starts the clocks of any errors found before the window connected its ports.
func (e *ShownErrors) StartToastExpiry(schedule func(int64, func()) func(), expired func()) {
	e.schedule, e.expired = schedule, expired
	for _, toast := range e.shownToasts() {
		e.scheduleNotice(toast)
	}
}

// ConfigureToastDeadline applies the automatic-dismissal settings: without autoDismiss no toast closes by itself, and the
// open toasts take the new deadline or drop their timer.
func (e *ShownErrors) ConfigureToastDeadline(auto bool, milliseconds int64) {
	e.autoDismiss, e.deadline = auto, milliseconds
	for _, toast := range e.shownToasts() {
		toast.stopTimer()
		toast.timed, toast.held = false, false
		e.scheduleNotice(toast)
	}
}

// scheduleToast gives a new toast the deadline of the settings.
func (e *ShownErrors) scheduleToast(toast *errorToast) {
	if !e.autoDismiss {
		toast.timed = false
		return
	}
	e.scheduleSpan(toast, e.deadline)
	toast.timed = true
}

// scheduleSpan runs the deadline of the toast for span milliseconds, unless the toast is held or no clock is connected.
func (e *ShownErrors) scheduleSpan(toast *errorToast, span int64) {
	toast.stopTimer()
	toast.span, toast.startedAt, toast.timed = span, e.now(), true
	if e.schedule == nil || toast.held {
		return
	}
	toast.cancel = e.schedule(span, func() {
		if at := slices.Index(e.toasts, toast); at >= 0 {
			e.closeToast(at)
			e.expired()
		}
	})
}

// remainingOf returns the milliseconds left before the toast closes: the span while it is held or waits for a clock, and the
// span less the time that the running timer has taken otherwise.
func (e *ShownErrors) remainingOf(toast *errorToast) int64 {
	if toast.held || toast.cancel == nil {
		return toast.span
	}
	return max(0, toast.span-e.now().Sub(toast.startedAt).Milliseconds())
}

func (e *ShownErrors) stopToastExpiry() {
	e.schedule = nil
	for _, toast := range e.toasts {
		toast.stopTimer()
	}
}

// ToastStatus is one entry of core.toasts (docs/spec/notifications.md#commands-and-statuses): a shown error notice whose remaining
// time is null when no deadline runs.
type ToastStatus struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Title     string `json:"title"`
	Count     int    `json:"count"`
	Remaining *int64 `json:"remaining"`
}

// ToastState is the value of core.toasts (docs/spec/notifications.md#commands-and-statuses): the shown toasts, newest first, and whether
// the line form shows the list of its other toasts.
type ToastState struct {
	Toasts   []ToastStatus `json:"toasts"`
	ListOpen bool          `json:"listOpen"`
}

// ToastStatuses returns the shown notices, newest first.
func (e *ShownErrors) ToastStatuses() []ToastStatus {
	shown := e.shownToasts()
	statuses := make([]ToastStatus, 0, len(shown))
	for i := len(shown) - 1; i >= 0; i-- {
		toast := shown[i]
		status := ToastStatus{ID: toast.id, Kind: toast.kind, Title: displayTitle(toast), Count: toast.count}
		if toast.timed {
			remaining := e.remainingOf(toast)
			status.Remaining = &remaining
		}
		statuses = append(statuses, status)
	}
	return statuses
}

// displayTitle is the title of a notice with its count when occurrences merged into it, as titleOf of notices.js writes it.
func displayTitle(toast *errorToast) string {
	if toast.count > 1 {
		return fmt.Sprintf("%s ×%d", toast.title, toast.count)
	}
	return toast.title
}

// Toasts returns the titles of the open toasts in the order in which they appeared.
func (e *ShownErrors) Toasts() []string {
	shown := e.shownToasts()
	titles := make([]string, 0, len(shown))
	for _, toast := range shown {
		titles = append(titles, displayTitle(toast))
	}
	return titles
}

// Hide withdraws every error of where so its next occurrence is recorded.
func (e *ShownErrors) Hide(where string) {
	for origin := range e.occurrences {
		if origin.where == where {
			e.withdraw(origin)
		}
	}
}

// ShownLine is an error line that the display shows: the where of its origin and its text.
type ShownLine struct {
	Where string
	Text  string
}

// Lines returns the error lines that are shown whose where matches, sorted by where. Several origins with one text are one line each.
func (e *ShownErrors) Lines(match func(where string) bool) []ShownLine {
	lines := []ShownLine{}
	for origin, text := range e.occurrences {
		if match(origin.where) {
			lines = append(lines, ShownLine{Where: origin.where, Text: text})
		}
	}
	slices.SortFunc(lines, func(a, b ShownLine) int { return strings.Compare(a.Where, b.Where) })
	return lines
}

// ShowFrom shows an error whose source can withdraw it with HideFrom.
func (e *ShownErrors) ShowFrom(where, source, text, detail string) {
	e.showToast(errorOrigin{where: where, source: source}, text, detail)
}

// ShownFrom reports whether source has an active occurrence of where, including a dismissed toast.
func (e *ShownErrors) ShownFrom(where, source string) bool {
	_, ok := e.occurrences[errorOrigin{where: where, source: source}]
	return ok
}

// HideFrom withdraws the occurrence that source owns and reports whether it existed.
func (e *ShownErrors) HideFrom(where, source string) bool {
	return e.withdraw(errorOrigin{where: where, source: source})
}

func (e *ShownErrors) withdraw(origin errorOrigin) bool {
	if _, ok := e.occurrences[origin]; !ok {
		return false
	}
	delete(e.occurrences, origin)
	e.removeToastOrigin(origin)
	return true
}

func (e *ShownErrors) removeToastOrigin(origin errorOrigin) {
	for _, toast := range e.toasts {
		if _, owned := toast.origins[origin]; !owned {
			continue
		}
		delete(toast.origins, origin)
		if len(toast.origins) == 0 && !toast.closed {
			// The withdrawn error closes its toast and its status line; its entry stays, read, until it is cleared (docs/spec/notifications.md#notices).
			toast.closed, toast.read = true, true
			toast.stopTimer()
		}
	}
}

// WithdrawTab withdraws the errors that name the closed tab: its operation error, the error of its restored session, the error of
// its stopped view, and the program and activity errors of the tab (docs/spec/exposure.md#error-presentation). The state that each error
// describes ended with the tab, and a display shows only the current state.
func (e *ShownErrors) WithdrawTab(tab string) {
	for origin := range e.occurrences {
		named := origin.where == "tab error "+tab || origin.where == "restored tab "+tab ||
			(strings.HasPrefix(origin.where, "surface status ") && strings.HasSuffix(origin.where, " "+tab)) ||
			(origin.where == workbenchErrorPlace && (origin.source == "program "+tab || origin.source == "activity "+tab))
		if named {
			e.withdraw(origin)
		}
	}
}

// WithdrawFrom ends the workbench occurrences of source.
func (e *ShownErrors) WithdrawFrom(source string) {
	e.HideFrom(workbenchErrorPlace, source)
}

// Text returns the current error of where. The workbench returns its newest open toast.
func (e *ShownErrors) Text(where string) (string, bool) {
	if where == workbenchErrorPlace {
		shown := e.shownToasts()
		if len(shown) == 0 {
			return "", false
		}
		return shown[len(shown)-1].title, true
	}
	for origin, text := range e.occurrences {
		if origin.where == where {
			return text, true
		}
	}
	return "", false
}

// drawErrorToasts draws the notice toasts under the bell at the top right of the window, in the form of the setting toastStyle
// (#toasts of packages/workbench/app.css). The card form shows toastCardLimit toasts and counts the rest, the line form shows the
// newest toast and the count of the rest, and the deck form shows the stack, which spreads while the pointer or the focus is on it.
// Each toast closes with core.notices.close and holds its deadline while the pointer or the focus is on it.
func (s *Shell) drawErrorToasts(c *ui.Context, width float32) {
	if len(s.errors.shownToasts()) == 0 {
		return
	}
	m := s.metrics
	theme := c.Theme()
	font := ui.Font{Family: theme.Font, Size: theme.FontSize, Lang: c.Locale(), LineHeight: m.lineHeight}
	style := s.toastStyle()
	statuses := s.errors.ToastStatuses()
	shownCount := len(statuses)
	switch style {
	case "card":
		shownCount = min(shownCount, toastCardLimit)
	case "line":
		shownCount = min(shownCount, 1)
	}
	rest := len(statuses) - shownCount
	maxWidth := min(m.toastWidth, width-2*m.toastRight)
	closeGlyph, closeHeight := ui.ShapeText("×", font, 0).Size()
	closeWidth := closeGlyph + 2*m.toastMorePadX
	textWidth := max(1, maxWidth-m.toastPadX-m.toastPadRight-closeWidth-m.toastGap)
	// buildRows measures the rows of the statuses in the form rowStyle; the listed toasts of the line form are measured in the card form.
	buildRows := func(rowStyle string, list []ToastStatus) []toastRow {
		built := make([]toastRow, 0, len(list))
		for _, status := range list {
		toast := s.errors.toastByID(status.ID)
		_, titleH := ui.ShapeRichTextWith([]ui.Span{{Text: status.Title}}, font, ui.TextShape{Direction: c.Direction(), KeepAll: true, Width: textWidth}).Size()
		bodyH := float32(0)
		if toast.text != "" && rowStyle != "line" {
			_, bodyH = ui.ShapeRichTextWith([]ui.Span{{Text: toast.text}}, font, ui.TextShape{Direction: c.Direction(), KeepAll: true, Width: textWidth}).Size()
		}
		height := titleH + bodyH + m.toastPadTop + m.toastPadBottom
		_, actionsHeight := ui.ShapeText("가", font, 0).Size()
		if rowStyle == "line" {
			height = m.toastLineH
		}
		actions := s.toastActions(toast)
		if rowStyle == "line" && len(actions) > 1 {
			actions = actions[:1]
		}
		if len(actions) > 0 && rowStyle != "line" {
			height += actionsHeight + m.toastGap
		}
		built = append(built, toastRow{status: status, body: toast.text, actions: actions, width: maxWidth, form: rowStyle,
			height: max(height, closeHeight+m.toastPadTop+m.toastPadBottom)})
	
		}
		return built
	}
	rows := buildRows(style, statuses[:shownCount])
	if style == "line" && s.errors.toastListOpen {
		rows = append(rows, buildRows("card", statuses[shownCount:])...)
	}
	stackHovered := false
	drawRows := func() {
		for i, row := range rows {
			box := ui.Row(c).Size(row.width, row.height).Shrink(0).AlignItems(ui.Start).Gap(m.toastGap).Padding(m.toastPadTop, m.toastPadRight, m.toastPadBottom, m.toastPadX).
				Background(s.palette.Card).Radius(s.radiusMiddle())
			// The deck form lifts and shrinks each toast after the first until the pointer is on the stack (#toasts of app.css).
			if style == "deck" && i > 0 {
				if s.toastStackHovered {
					box = box.Margin(m.toastGap, 0, 0, 0)
				} else {
					box = box.Margin(m.toastDeckLift, 0, 0, 0).Scale(m.toastDeckScale, m.toastDeckScale)
				}
			}
			held := box.Hovered() || box.FocusWithin()
			s.errors.Hold(row.status.ID, held)
			stackHovered = stackHovered || held
			box.Children(func() {
				ui.Column(c).Width(textWidth).Shrink(0).Gap(m.toastGap).Children(func() {
					drawErrorText(c, row.status.Title).Width(textWidth).Shrink(0).LineHeight(font.LineHeight).KeepAll()
					if row.body != "" && row.form != "line" {
						ui.Text(c, row.body).Wrap().TextColor(s.palette.Muted).Label(row.body).Width(textWidth).Shrink(0).LineHeight(font.LineHeight).KeepAll()
					}
					if len(row.actions) > 0 && row.form != "line" {
						ui.Row(c).Gap(m.toastGap).Children(func() { s.drawToastActions(c, row) })
					}
				})
				if row.form == "line" {
					s.drawToastActions(c, row)
				}
				close := s.binder.Press(c, "core.notices.close", "core.notices.close", row.status.ID, map[string]any{"id": row.status.ID})
				close.Size(closeWidth, closeHeight).Shrink(0).PaddingX(m.toastMorePadX).Center().
					Label("닫기").Tooltip("닫기").Cursor(ui.CursorPointer).Children(func() {
					ui.Text(c, "×").SingleLine().LineHeight(font.LineHeight).TextColor(s.palette.Fg)
				})
			})
		}
	}
	// extra is the top margin of the row at index i beyond the gap between rows: the deck form lifts its stack, and spreads it
	// by the gap while the pointer is on it.
	extra := func(i int) float32 {
		if style != "deck" || i == 0 {
			return 0
		}
		if s.toastStackHovered {
			return m.toastGap
		}
		return m.toastDeckLift
	}
	stackHeight := float32(0)
	for i, row := range rows {
		stackHeight += row.height
		if i > 0 {
			stackHeight += m.toastGap + extra(i)
		}
	}
	_, height := c.Size()
	visibleHeight := min(stackHeight, height/2)
	popup := ui.Box(c).Absolute().Top(m.toastTop).Right(m.toastRight).Size(maxWidth, visibleHeight)
	if rest > 0 {
		// The count runs core.toasts.list with the opposite of the list state, so a second press hides the list (docs/spec/notifications.md#toasts).
		more := s.binder.Press(c, "core.toasts.more", "core.toasts.list", "", map[string]any{"open": !s.errors.toastListOpen}).
			Absolute().Top(m.toastTop + stackHeight + m.toastGap)
		more.Children(func() {
			ui.Text(c, counterText(style, rest)).SingleLine().TextColor(s.palette.Muted)
		})
	}
	if stackHeight > visibleHeight {
		popup.Children(func() {
			ui.Scroll(c).Fill().Column().AlignItems(ui.End).Gap(m.toastGap).Children(drawRows)
		})
	} else {
		popup.PassThrough().Column().AlignItems(ui.End).Gap(m.toastGap).Children(drawRows)
	}
	s.toastStackHovered = stackHovered
}

// toastRow is one drawn notice: the status it draws and the measured sizes of its content.
type toastRow struct {
	status  ToastStatus
	body    string
	actions []NoticeAction
	width   float32
	height  float32
	// form is the form in which the row is drawn: line for the one toast of the line form, card for its listed toasts.
	form string
}

// toastStyle returns the toastStyle setting, which names the form of the toasts.
func (s *Shell) toastStyle() string {
	if style, ok := s.settings.Value("toastStyle").(string); ok && style != "" {
		return style
	}
	return "card"
}

// counterText is the count of the toasts that a form does not show, as notice-view.js writes it.
func counterText(style string, rest int) string {
	if style == "line" {
		return fmt.Sprint(rest)
	}
	return fmt.Sprintf("+%d개 더", rest)
}

// toastByID returns the shown toast with the id, which the status of the same redraw reported.
func (e *ShownErrors) toastByID(id string) *errorToast {
	at := slices.IndexFunc(e.toasts, func(toast *errorToast) bool { return !toast.closed && toast.id == id })
	return e.toasts[at]
}

// drawErrorText draws the title of a toast, the one element that takes the error color.
func drawErrorText(c *ui.Context, text string) ui.Element {
	return ui.Text(c, text).Wrap().TextColor(c.Theme().Danger).Role(ui.RoleStatus).Label(text)
}

// WithdrawNotice withdraws the shown notice id because its origin no longer holds it: the toast and the status line close, and the entry
// stays in the center, read (docs/spec/notifications.md#commands-and-statuses). It reports whether a shown notice has id.
func (e *ShownErrors) WithdrawNotice(id string) bool {
	at := slices.IndexFunc(e.toasts, func(toast *errorToast) bool { return !toast.closed && toast.id == id })
	if at == -1 {
		return false
	}
	e.toasts[at].read = true
	e.toasts[at].origin = ""
	e.closeToast(at)
	return true
}

// toastActions returns the actions that a shown toast offers: the actions of its notice, then 카드로 가기 for a warning or an error of a
// card that does not have the focus, which runs core.card.focus (docs/spec/notifications.md#toasts).
func (s *Shell) toastActions(toast *errorToast) []NoticeAction {
	actions := append([]NoticeAction{}, toast.actions...)
	if toast.source.Kind == "card" && toast.source.Card != s.focused && (toast.kind == "warning" || toast.kind == "error") {
		actions = append(actions, NoticeAction{Label: "카드로 가기", Command: "core.card.focus", Params: map[string]any{"card": toast.source.Card}})
	}
	// An error toast offers 자세히, which opens the center at the notice (docs/spec/notifications.md#toasts).
	if toast.kind == "error" {
		actions = append(actions, NoticeAction{Label: "자세히", Command: "core.notices.show", Params: map[string]any{"id": toast.id}})
	}
	return actions
}

// drawToastActions draws the action buttons of a toast row; an action whose command is not declared is not drawn.
func (s *Shell) drawToastActions(c *ui.Context, row toastRow) {
	for _, action := range row.actions {
		if !s.binder.Declares(action.Command) {
			continue
		}
		s.uiButton(c, s.binder.Press(c, "core.notices.action", action.Command, row.status.ID, action.Params), action.Label, false)
	}
}
