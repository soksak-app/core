package workbench

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// dialogSurface is the dialog of the window (docs/spec/plugins.md#dialogs): a declared page of a plugin that a view opened as a view
// surface over the content of the window below the title bar. A window holds one dialog at a time.
type dialogSurface struct {
	surface      *heldSurface
	plugin, name string
	// answer replies to the open call of the opener, which waits for the close of the dialog.
	answer viewAnswer
}

// id is the surface id of the dialog, dialog/<plugin>/<name>.
func (d *dialogSurface) id() string { return d.surface.tab.ID }

// dialogRefusal is the refusal of a modal of the workbench while a dialog is open, and nil when the window shows no dialog
// (docs/spec/native-modals.md).
func (s *Shell) dialogRefusal() error {
	if s.dialog == nil {
		return nil
	}
	return fmt.Errorf("the window shows the dialog %s of %s", s.dialog.name, s.dialog.plugin)
}

// openDialog serves runtime.dialog.open of the view of call: it opens the declared dialog name of the plugin of the view with params
// and answers the call when the dialog view closes it. Every other end of the call removes the dialog: the cancel of the call, the
// end of the opener view and the close of the opener surface.
func (s *Shell) openDialog(call viewCallEvent, view *viewState, unit *installedUnit, answer viewAnswer) error {
	fields, err := viewFields[struct {
		Name   string          `json:"name"`
		Params json.RawMessage `json:"params"`
	}](call)
	if err != nil {
		return err
	}
	page, declared := unit.Dialogs[fields.Name]
	if !declared {
		return fmt.Errorf("view call runtime.dialog.open %s is not a dialog of %s", fields.Name, unit.ID)
	}
	if err := s.dialogRefusal(); err != nil {
		return fmt.Errorf("view call runtime.dialog.open: %w", err)
	}
	if modal := s.modalName(); modal != nil {
		return fmt.Errorf("view call runtime.dialog.open: the window shows the modal %s", *modal)
	}
	composition, err := json.Marshal(map[string]string{"kind": "view", "page": page})
	if err != nil {
		return err
	}
	params := fields.Params
	if len(params) == 0 {
		params = json.RawMessage("null")
	}
	id := "dialog/" + unit.ID + "/" + fields.Name
	entry := &dialogSurface{plugin: unit.ID, name: fields.Name, answer: answer, surface: &heldSurface{
		tab:         layout.Tab{ID: id, Plugin: unit.ID, Rest: map[string]json.RawMessage{"params": params}},
		composition: composition, dialog: &dialogStart{Name: fields.Name, Opener: call.Surface},
	}}
	s.errors.Hide(dialogErrorPlace(unit.ID, fields.Name))
	if pending := view.pending[call.ID]; pending != nil {
		pending.abort = func() { s.endDialog(entry) }
	}
	s.dialog = entry
	s.options.Invalidate()
	return nil
}

// closeDialog serves runtime.dialog.close of the view of call, which only the open dialog view may make: the open call of the opener
// replies with result.
func (s *Shell) closeDialog(call viewCallEvent, answer viewAnswer) error {
	if s.dialog == nil || s.dialog.id() != call.Surface {
		return errors.New("view call runtime.dialog.close is served only to a dialog")
	}
	fields, err := viewFields[struct {
		Result json.RawMessage `json:"result"`
	}](call)
	if err != nil {
		return err
	}
	result := fields.Result
	if len(result) == 0 {
		result = json.RawMessage("null")
	}
	// The close replies before the dialog ends, because the end of the dialog view ends its calls without a reply.
	entry := s.dialog
	answer(nil, nil)
	entry.answer(result, nil)
	s.endDialog(entry)
	return nil
}

// failDialog ends the open dialog whose view stopped its restarts: the error display shows the reason at dialog <plugin> <name>, and
// the open call fails with it.
func (s *Shell) failDialog(reason string) {
	entry := s.dialog
	s.endDialog(entry)
	s.errors.Show(dialogErrorPlace(entry.plugin, entry.name), reason, "")
	entry.answer(nil, errors.New(reason))
}

// endDialog removes the dialog entry when it is the open one: the next placement leaves its surface out, which closes its view.
func (s *Shell) endDialog(entry *dialogSurface) {
	if s.dialog != entry {
		return
	}
	s.dialog = nil
	s.forgetSurfaces([]string{entry.id()})
	s.options.Invalidate()
}

// dialogErrorPlace is the place of the error display of the dialog name of plugin.
func dialogErrorPlace(plugin, name string) string { return "dialog " + plugin + " " + name }

// drawDialogSurface draws the view of the open dialog over the content of the window below the title bar, sidebars included, above
// every other native view of the frame.
func (s *Shell) drawDialogSurface(c *ui.Context, width, height float32) {
	if s.dialog == nil {
		return
	}
	window, err := s.windowView()
	if err != nil {
		s.failWindowRead(err)
		return
	}
	top := s.chromeHeight()
	box := DevicePixels(layout.Rect{X: 0, Y: float64(top), W: float64(width), H: float64(max(0, height-top))}, window.Scale)
	surface := s.dialog.surface
	surface.box = box
	id := surface.tab.ID
	s.surfaces.drawn[id] = box
	s.holdSurface(surface)
	if view, key, ok := s.options.Element(id); ok {
		ui.NativeView(c, view, key).Absolute().Left(float32(box.X)).Top(float32(box.Y)).Size(float32(box.W), float32(box.H))
	}
}
