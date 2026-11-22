package workbench

import (
	"slices"

	"github.com/egoist/mygo/ui"
)

// workbenchErrorPlace is the place of the error banner, as createErrorDisplay of packages/workbench/page-layout.js names it.
const workbenchErrorPlace = "workbench"

// libraryErrorPlace is the place of the error line of the library, as perform of packages/workbench/library.js names it.
const libraryErrorPlace = "library"

// ShownErrors records the error of an origin when it appears and holds the errors that the window displays.
type ShownErrors struct {
	report      func(line string)
	occurrences map[errorOrigin]string
	toasts      []*errorToast
	schedule    func(expire func()) (cancel func())
	expired     func()
	// autoDismiss states whether a toast closes by its own deadline, and deadline the delay in milliseconds; the settings of
	// the workbench hold both and ConfigureToastDeadline applies their change.
	autoDismiss bool
	deadline    int64
}

type errorOrigin struct {
	where  string
	source string
}

// errorToast is a visible row shared by the origins that reported its text, in the order in which it first appeared.
type errorToast struct {
	text    string
	origins map[errorOrigin]struct{}
	cancel  func()
}

// NewShownErrors returns the display that writes each line with report.
func NewShownErrors(report func(line string)) *ShownErrors {
	return &ShownErrors{
		report: report, occurrences: map[errorOrigin]string{},
	}
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
	if previous, ok := e.occurrences[origin]; ok {
		if previous == text {
			return
		}
		if origin.where != workbenchErrorPlace || origin.source != "" {
			e.removeToastOrigin(origin)
		}
	}
	e.occurrences[origin] = text
	at := e.toastIndex(text)
	if at == -1 {
		toast := &errorToast{text: text, origins: map[errorOrigin]struct{}{origin: {}}}
		e.toasts = append(e.toasts, toast)
		e.scheduleToast(toast)
	} else {
		e.toasts[at].origins[origin] = struct{}{}
	}
	e.report(origin.where + ": " + text + detail)
}

func (e *ShownErrors) toastIndex(text string) int {
	return slices.IndexFunc(e.toasts, func(toast *errorToast) bool { return toast.text == text })
}

// DismissToast closes the open toast with the text. The occurrences stay active until the owning operation withdraws them.
func (e *ShownErrors) DismissToast(text string) bool {
	at := e.toastIndex(text)
	if at == -1 {
		return false
	}
	e.closeToast(at)
	return true
}

func (e *ShownErrors) closeToast(at int) {
	toast := e.toasts[at]
	e.toasts = slices.Delete(e.toasts, at, at+1)
	toast.stopTimer()
}

func (toast *errorToast) stopTimer() {
	if toast.cancel != nil {
		toast.cancel()
		toast.cancel = nil
	}
}

// startToastExpiry also starts the clocks of any errors found before the window connected its ports.
func (e *ShownErrors) startToastExpiry(schedule func(func()) func(), expired func()) {
	e.schedule, e.expired = schedule, expired
	for _, toast := range e.toasts {
		e.scheduleToast(toast)
	}
}

// ConfigureToastDeadline applies the automatic-dismissal settings: without autoDismiss no toast closes by itself, and the
// open toasts take the new deadline or drop their timer.
func (e *ShownErrors) ConfigureToastDeadline(auto bool, milliseconds int64) {
	e.autoDismiss, e.deadline = auto, milliseconds
	for _, toast := range e.toasts {
		toast.stopTimer()
		if auto {
			e.scheduleToast(toast)
		}
	}
}

func (e *ShownErrors) scheduleToast(toast *errorToast) {
	if e.schedule == nil || !e.autoDismiss {
		return
	}
	toast.cancel = e.schedule(func() {
		if at := slices.Index(e.toasts, toast); at >= 0 {
			e.closeToast(at)
			e.expired()
		}
	})
}

func (e *ShownErrors) stopToastExpiry() {
	e.schedule = nil
	for _, toast := range e.toasts {
		toast.stopTimer()
	}
}

// Toasts returns the texts of the open toasts in the order in which they appeared.
func (e *ShownErrors) Toasts() []string {
	texts := make([]string, 0, len(e.toasts))
	for _, toast := range e.toasts {
		texts = append(texts, toast.text)
	}
	return texts
}

// Hide withdraws every error of where so its next occurrence is recorded.
func (e *ShownErrors) Hide(where string) {
	for origin := range e.occurrences {
		if origin.where == where {
			e.withdraw(origin)
		}
	}
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
	e.toasts = slices.DeleteFunc(e.toasts, func(toast *errorToast) bool {
		delete(toast.origins, origin)
		if len(toast.origins) != 0 {
			return false
		}
		toast.stopTimer()
		return true
	})
}

// WithdrawFrom ends the workbench occurrences of source.
func (e *ShownErrors) WithdrawFrom(source string) {
	e.HideFrom(workbenchErrorPlace, source)
}

// Text returns the current error of where. The workbench returns its newest open toast.
func (e *ShownErrors) Text(where string) (string, bool) {
	if where == workbenchErrorPlace {
		if len(e.toasts) == 0 {
			return "", false
		}
		return e.toasts[len(e.toasts)-1].text, true
	}
	for origin, text := range e.occurrences {
		if origin.where == where {
			return text, true
		}
	}
	return "", false
}

type toastRow struct {
	text                     string
	width, height, textWidth float32
}

// drawErrorToasts draws the floating component inside either the window overlay or the active modal.
func (s *Shell) drawErrorToasts(c *ui.Context, width float32) {
	if len(s.errors.toasts) == 0 {
		return
	}
	m := s.metrics
	theme := c.Theme()
	font := ui.Font{Family: theme.Font, Size: theme.FontSize, Lang: c.Locale(), LineHeight: m.lineHeight}
	glyphWidth, closeHeight := ui.ShapeText("×", font, 0).Size()
	closeWidth := glyphWidth + 2*m.errorClosePadX
	otherWidth := closeWidth + 3*m.errorPadX + 2*m.errorBorder
	maxWidth := min(m.errorToastMaxWidth, width-2*m.space4)
	stackWidth := float32(0)
	stackHeight := float32(len(s.errors.toasts)-1) * m.errorPadY
	rows := make([]toastRow, 0, len(s.errors.toasts))
	for _, toast := range s.errors.toasts {
		shape := ui.TextShape{Direction: c.Direction(), KeepAll: true}
		spans := []ui.Span{{Text: toast.text}}
		textWidth, textHeight := ui.ShapeRichTextWith(spans, font, shape).Size()
		shape.Width = max(1, maxWidth-otherWidth)
		if textWidth > shape.Width {
			textWidth = shape.Width
			_, textHeight = ui.ShapeRichTextWith(spans, font, shape).Size()
		}
		row := toastRow{toast.text, textWidth + otherWidth, max(textHeight, closeHeight) + 2*(m.errorPadY+m.errorBorder), textWidth}
		rows = append(rows, row)
		stackWidth, stackHeight = max(stackWidth, row.width), stackHeight+row.height
	}
	drawRows := func() {
		for _, row := range rows {
			ui.Row(c).Size(row.width, row.height).Shrink(0).AlignItems(ui.Start).Gap(m.errorPadX).Padding(m.errorPadY, m.errorPadX).
				Background(s.palette.Card).Border(m.errorBorder, theme.Danger).Radius(s.radiusMiddle()).Children(func() {
				drawErrorText(c, row.text).Width(row.textWidth).Shrink(0).LineHeight(font.LineHeight).KeepAll()
				close := s.binder.Press(c, "core.error.dismiss", "core.error.dismiss", row.text, map[string]any{"text": row.text})
				close.Size(closeWidth, closeHeight).Shrink(0).PaddingX(m.errorClosePadX).Center().
					Label("오류 닫기").Tooltip("오류 닫기").Cursor(ui.CursorPointer).Children(func() {
					ui.Text(c, "×").SingleLine().LineHeight(font.LineHeight).TextColor(s.palette.Fg)
				})
			})
		}
	}
	_, height := c.Size()
	visibleHeight := min(stackHeight, height/2)
	popup := ui.Box(c).Absolute().Left((width-stackWidth)/2).Bottom(m.errorToastBottom).Size(stackWidth, visibleHeight)
	if stackHeight > visibleHeight {
		popup.Children(func() {
			ui.Scroll(c).Fill().Column().AlignItems(ui.Center).Gap(m.errorPadY).Children(drawRows)
		})
		return
	}
	popup.PassThrough().Column().AlignItems(ui.Center).Gap(m.errorPadY).Children(drawRows)
}

// drawErrorText draws the text of a toast, the one element that takes the error color.
func drawErrorText(c *ui.Context, text string) ui.Element {
	return ui.Text(c, text).Wrap().TextColor(c.Theme().Danger).Role(ui.RoleStatus).Label(text)
}
