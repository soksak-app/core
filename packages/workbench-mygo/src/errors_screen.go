package workbench

import "github.com/egoist/mygo/ui"

// workbenchErrorPlace is the place of the error banner, as createErrorDisplay of packages/workbench/page-layout.js names it.
const workbenchErrorPlace = "workbench"

// ShownErrors is the only path that shows an error to the person, as packages/workbench/shown-errors.js is. The next drawing
// erases an error from the screen, so the record written at the moment it is shown is the trace of that error
// (docs/spec/hosts.md#application-log). The error color is used only for what this path shows.
type ShownErrors struct {
	report func(line string)
	shown  map[string]string
}

// NewShownErrors returns the display that writes each line with report.
func NewShownErrors(report func(line string)) *ShownErrors {
	return &ShownErrors{report: report, shown: map[string]string{}}
}

// Show shows the error text of the place where, and writes `<where>: <text><detail>` only when the error of that place
// changes. detail is kept only in the record.
func (e *ShownErrors) Show(where, text, detail string) {
	if shown, ok := e.shown[where]; ok && shown == text {
		return
	}
	e.shown[where] = text
	e.report(where + ": " + text + detail)
}

// Hide withdraws the error of the place where, so the same error is written when it is shown again.
func (e *ShownErrors) Hide(where string) { delete(e.shown, where) }

// Text returns the error shown at the place where.
func (e *ShownErrors) Text(where string) (string, bool) {
	text, ok := e.shown[where]
	return text, ok
}

// DrawErrorBanner draws the error banner of the workbench, the value of `core.page.error`. It draws nothing without an error.
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
