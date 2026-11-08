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
}

// NewShownErrors returns the display that writes each line with report.
func NewShownErrors(report func(line string)) *ShownErrors {
	return &ShownErrors{report: report, shown: map[string]string{}, sources: map[string]string{}}
}

// Show shows the error text of the place where, and writes `<where>: <text><detail>` only when the error of that place
// changes. detail is kept only in the record.
func (e *ShownErrors) Show(where, text, detail string) {
	delete(e.sources, where)
	if shown, ok := e.shown[where]; ok && shown == text {
		return
	}
	e.shown[where] = text
	e.report(where + ": " + text + detail)
}

// Hide withdraws the error of the place where, so the same error is written when it is shown again.
func (e *ShownErrors) Hide(where string) {
	delete(e.shown, where)
	delete(e.sources, where)
}

// ShowFrom is Show for an error whose end its source can tell: HideFrom of the same source withdraws it.
func (e *ShownErrors) ShowFrom(where, source, text, detail string) {
	e.Show(where, text, detail)
	e.sources[where] = source
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

// Text returns the error shown at the place where.
func (e *ShownErrors) Text(where string) (string, bool) {
	text, ok := e.shown[where]
	return text, ok
}

// DrawErrorBanner draws the error banner of the workbench, the value of `core.workbench.error`. It draws nothing without an error.
func DrawErrorBanner(c *ui.Context, errors *ShownErrors) {
	if text, ok := errors.Text(workbenchErrorPlace); ok {
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
