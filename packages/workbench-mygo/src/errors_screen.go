package workbench

import "github.com/egoist/mygo/ui"

// workbenchErrorPlace is the place of the error banner, as createErrorDisplay of packages/workbench/page-layout.js names it.
const workbenchErrorPlace = "workbench"

// libraryErrorPlace is the place of the error line of the library, as perform of packages/workbench/library.js names it.
const libraryErrorPlace = "library"

// ShownErrors is the only path that shows an error to the person, as packages/workbench/shown-errors.js is. The next drawing
// erases an error from the screen, so the record written at the moment it is shown is the trace of that error
// (docs/spec/hosts.md#application-log). The error color is used only for what this path shows.
type ShownErrors struct {
	report func(line string)
	shown  map[string]string
	// sources holds the source of the error of a place that has one.
	sources map[string]string
	// toasts holds the open error toasts of the workbench in the order in which they appeared; each closes on its own
	// (core.error.dismiss) or when its source withdraws it.
	toasts []errorToast
}

// errorToast is one error toast of the workbench: the text that it shows and the source that showed it.
type errorToast struct {
	text   string
	source string
}

// NewShownErrors returns the display that writes each line with report.
func NewShownErrors(report func(line string)) *ShownErrors {
	return &ShownErrors{report: report, shown: map[string]string{}, sources: map[string]string{}}
}

// Show shows the error text of the place where, and writes `<where>: <text><detail>` only when the error of that place
// changes. detail is kept only in the record. An error of the workbench also opens a toast at the bottom of the window,
// one per distinct text, so several errors show at once.
func (e *ShownErrors) Show(where, text, detail string) {
	delete(e.sources, where)
	if shown, ok := e.shown[where]; ok && shown == text {
		return
	}
	e.shown[where] = text
	if where == workbenchErrorPlace && !e.hasToast(text) {
		e.toasts = append(e.toasts, errorToast{text: text})
	}
	e.report(where + ": " + text + detail)
}

// hasToast tells whether a toast with the text is open.
func (e *ShownErrors) hasToast(text string) bool {
	for _, toast := range e.toasts {
		if toast.text == text {
			return true
		}
	}
	return false
}

// DismissToast closes the open toast with the text and tells whether one closed (core.error.dismiss).
func (e *ShownErrors) DismissToast(text string) bool {
	for at, toast := range e.toasts {
		if toast.text == text {
			e.toasts = append(e.toasts[:at], e.toasts[at+1:]...)
			return true
		}
	}
	return false
}

// Toasts returns the texts of the open toasts in the order in which they appeared.
func (e *ShownErrors) Toasts() []string {
	texts := make([]string, 0, len(e.toasts))
	for _, toast := range e.toasts {
		texts = append(texts, toast.text)
	}
	return texts
}

// Hide withdraws the error of the place where, so the same error is written when it is shown again. The toasts of the
// workbench close with it.
func (e *ShownErrors) Hide(where string) {
	delete(e.shown, where)
	delete(e.sources, where)
	if where == workbenchErrorPlace {
		e.toasts = nil
	}
}

// ShowFrom is Show for an error whose end its source can tell: HideFrom of the same source withdraws it. The toast of
// the workbench carries the source, so a withdrawal closes only the toast that the source showed.
func (e *ShownErrors) ShowFrom(where, source, text, detail string) {
	e.Show(where, text, detail)
	e.sources[where] = source
	for at, toast := range e.toasts {
		if toast.text == text {
			e.toasts[at].source = source
		}
	}
}

// ShownFrom tells whether the error of the place where is one that source showed.
func (e *ShownErrors) ShownFrom(where, source string) bool {
	shown, ok := e.sources[where]
	return ok && shown == source
}

// HideFrom withdraws the error of the place where when source showed it, and tells whether it did. An error that another
// source showed since then stays.
func (e *ShownErrors) HideFrom(where, source string) bool {
	if !e.ShownFrom(where, source) {
		return false
	}
	e.Hide(where)
	return true
}

// WithdrawFrom closes the open toasts whose source is source, as the withdrawal of a layout error does
// (createErrorWithdrawal of packages/workbench/page-layout.js).
func (e *ShownErrors) WithdrawFrom(source string) {
	held := e.toasts[:0]
	for _, toast := range e.toasts {
		if toast.source != source {
			held = append(held, toast)
		}
	}
	e.toasts = held
}

// Text returns the error shown at the place where.
func (e *ShownErrors) Text(where string) (string, bool) {
	text, ok := e.shown[where]
	return text, ok
}

// DrawErrorToasts draws the open error toasts of the workbench as rows that the drawing of the window places at its
// bottom; the shell adds the close control of each toast (cards.go). It draws nothing without an open toast.
func DrawErrorToasts(c *ui.Context, errors *ShownErrors) {
	for _, text := range errors.Toasts() {
		drawErrorText(c, text)
	}
}

// DrawError draws the error of the place where in its place on a screen. It draws nothing without an error.
func DrawError(c *ui.Context, errors *ShownErrors, where string) {
	if text, ok := errors.Text(where); ok {
		drawErrorText(c, text)
	}
}

func drawErrorText(c *ui.Context, text string) {
	ui.Text(c, text).Wrap().TextColor(c.Theme().Danger).Role(ui.RoleStatus).Label(text)
}
