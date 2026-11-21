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
	inline      map[string]inlineError
	occurrences map[errorOrigin]string
	toasts      []errorToast
}

type inlineError struct {
	text   string
	source string
}

type errorOrigin struct {
	where  string
	source string
}

// errorToast is a visible row shared by the origins that reported its text, in the order in which it first appeared.
type errorToast struct {
	text    string
	origins map[errorOrigin]struct{}
}

// NewShownErrors returns the display that writes each line with report.
func NewShownErrors(report func(line string)) *ShownErrors {
	return &ShownErrors{
		report: report, inline: map[string]inlineError{}, occurrences: map[errorOrigin]string{},
	}
}

// Show shows the inline error of where or adds an error of the workbench to its open toasts.
func (e *ShownErrors) Show(where, text, detail string) {
	if where == workbenchErrorPlace {
		e.ShowToast(where, text, detail)
		return
	}
	e.showInline(where, "", text, detail)
}

func (e *ShownErrors) showInline(where, source, text, detail string) {
	shown, ok := e.inline[where]
	e.inline[where] = inlineError{text: text, source: source}
	if !ok || shown.text != text {
		e.report(where + ": " + text + detail)
	}
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
		if origin != (errorOrigin{where: workbenchErrorPlace}) {
			e.removeToastOrigin(origin)
		}
	}
	e.occurrences[origin] = text
	at := e.toastIndex(text)
	if at == -1 {
		e.toasts = append(e.toasts, errorToast{text: text, origins: map[errorOrigin]struct{}{origin: {}}})
	} else {
		e.toasts[at].origins[origin] = struct{}{}
	}
	e.report(origin.where + ": " + text + detail)
}

func (e *ShownErrors) toastIndex(text string) int {
	return slices.IndexFunc(e.toasts, func(toast errorToast) bool { return toast.text == text })
}

// DismissToast closes the open toast with the text. The occurrences stay active until the owning operation withdraws them.
func (e *ShownErrors) DismissToast(text string) bool {
	at := e.toastIndex(text)
	if at == -1 {
		return false
	}
	e.toasts = slices.Delete(e.toasts, at, at+1)
	return true
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
	delete(e.inline, where)
	for origin := range e.occurrences {
		if origin.where == where {
			e.withdraw(origin)
		}
	}
}

// ShowFrom shows an error whose source can withdraw it with HideFrom.
func (e *ShownErrors) ShowFrom(where, source, text, detail string) {
	if where == workbenchErrorPlace {
		e.showToast(errorOrigin{where: where, source: source}, text, detail)
		return
	}
	e.showInline(where, source, text, detail)
}

// ShownFrom reports whether source has an active occurrence of where, including a dismissed toast.
func (e *ShownErrors) ShownFrom(where, source string) bool {
	if where == workbenchErrorPlace {
		_, ok := e.occurrences[errorOrigin{where: where, source: source}]
		return ok
	}
	shown, ok := e.inline[where]
	return ok && shown.source == source
}

// HideFrom withdraws the occurrence that source owns and reports whether it existed.
func (e *ShownErrors) HideFrom(where, source string) bool {
	if where == workbenchErrorPlace {
		return e.withdraw(errorOrigin{where: where, source: source})
	}
	if !e.ShownFrom(where, source) {
		return false
	}
	delete(e.inline, where)
	return true
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
	e.toasts = slices.DeleteFunc(e.toasts, func(toast errorToast) bool {
		delete(toast.origins, origin)
		return len(toast.origins) == 0
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
	if text, ok := e.occurrences[errorOrigin{where: where}]; ok {
		return text, true
	}
	shown, ok := e.inline[where]
	return shown.text, ok
}

type toastLayout struct {
	font                    ui.Font
	direction               ui.Direction
	textWidth               float32
	closeWidth, closeHeight float32
}

func (s *Shell) toastLayout(c *ui.Context, width float32) toastLayout {
	m := s.metrics
	theme := c.Theme()
	font := ui.Font{Family: theme.Font, Size: theme.FontSize, Lang: c.Locale(), LineHeight: m.lineHeight}
	glyphWidth, closeHeight := ui.ShapeText("×", font, 0).Size()
	closeWidth := glyphWidth + 2*m.errorClosePadX
	return toastLayout{
		font: font, direction: c.Direction(),
		textWidth: max(1, width-3*m.errorPadX-closeWidth), closeWidth: closeWidth, closeHeight: closeHeight,
	}
}

func (s *Shell) toastRowHeight(layout toastLayout, text string) float32 {
	m := s.metrics
	spans := []ui.Span{{Text: text}}
	shape := ui.TextShape{Width: layout.textWidth, Direction: layout.direction, KeepAll: true}
	_, textHeight := ui.ShapeRichTextWith(spans, layout.font, shape).Size()
	return max(textHeight, layout.closeHeight) + 2*m.errorPadY + m.errorBorder
}

// toastHeight returns the space occupied by all open error toasts at width.
func (s *Shell) toastHeight(c *ui.Context, width float32) float32 {
	if len(s.errors.toasts) == 0 {
		return 0
	}
	layout := s.toastLayout(c, width)
	total := float32(len(s.errors.toasts)-1) * s.metrics.errorBorder
	for _, toast := range s.errors.toasts {
		total += s.toastRowHeight(layout, toast.text)
	}
	return total
}

// drawErrorToasts draws each visible error and its close button in the view that owns the active focus.
func (s *Shell) drawErrorToasts(c *ui.Context, width float32) {
	if len(s.errors.toasts) == 0 {
		return
	}
	m := s.metrics
	layout := s.toastLayout(c, width)
	color := c.Theme().Danger
	ui.Column(c).Width(width).Shrink(0).Gap(m.errorBorder).Children(func() {
		for _, toast := range s.errors.toasts {
			text := toast.text
			height := s.toastRowHeight(layout, text)
			ui.Row(c).Size(width, height).Shrink(0).AlignItems(ui.Start).Gap(m.errorPadX).Padding(m.errorPadY, m.errorPadX).
				Background(s.palette.Bg).BorderWidth(m.errorBorder, 0, 0, 0).BorderColor(color).Children(func() {
				drawErrorText(c, text).Width(layout.textWidth).Shrink(0).LineHeight(layout.font.LineHeight).KeepAll()
				close := s.binder.Press(c, "core.error.dismiss", "core.error.dismiss", text, map[string]any{"text": text})
				close.Size(layout.closeWidth, layout.closeHeight).Shrink(0).PaddingX(m.errorClosePadX).Center().
					Label("오류 닫기").Tooltip("오류 닫기").Cursor(ui.CursorPointer).Children(func() {
					ui.Text(c, "×").SingleLine().LineHeight(layout.font.LineHeight).TextColor(s.palette.Fg)
				})
			})
		}
	})
}

// drawModalErrorToasts anchors the component inside the active modal's focus scope.
func (s *Shell) drawModalErrorToasts(c *ui.Context, width float32) {
	height := s.toastHeight(c, width)
	if height == 0 {
		return
	}
	ui.Box(c).Absolute().Left(0).Bottom(0).Size(width, height).Children(func() {
		s.drawErrorToasts(c, width)
	})
}

// DrawError draws the error of the place where in its place on a screen. It draws nothing without an error.
func DrawError(c *ui.Context, errors *ShownErrors, where string) {
	if text, ok := errors.Text(where); ok {
		drawErrorText(c, text)
	}
}

func drawErrorText(c *ui.Context, text string) ui.Element {
	return ui.Text(c, text).Wrap().TextColor(c.Theme().Danger).Role(ui.RoleStatus).Label(text)
}
