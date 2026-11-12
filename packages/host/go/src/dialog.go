package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/soksak-app/core/packages/host/go/src/platform"
	"github.com/soksak-app/core/packages/host/go/src/routine"
)

// The kinds of a dialog request (docs/spec/exposure.md#dialogs).
const (
	DialogSave     = "save"
	DialogFolder   = "folder"
	DialogOpen     = "open"
	DialogDownload = "download"
)

// DialogRequest is a dialog that a window asks for while a client watches its host.dialog.
type DialogRequest struct {
	ID            string  `json:"id"`
	Kind          string  `json:"kind"`
	SuggestedName *string `json:"suggestedName"`
	Directory     *string `json:"directory"`
	Multiple      bool    `json:"multiple"`
	Directories   bool    `json:"directories"`
	URL           *string `json:"url"`
}

// DialogAnswer is the answer of input.dialog.answer.
type DialogAnswer struct {
	ID      string   `json:"id"`
	Paths   []string `json:"paths"`
	Cancel  bool     `json:"cancel"`
	Replace bool     `json:"replace"`
}

// heldDialog is a request that waits for its answer. answered receives the answer once.
type heldDialog struct {
	request  DialogRequest
	answered chan dialogAnswered
}

// dialogAnswered is the answer of a request: the chosen paths, nil for a cancel, and applied, which receives once whether the
// asker applied them. The answer of a client returns the result of applied.
type dialogAnswered struct {
	paths   []string
	applied chan error
}

// Dialogs holds the dialog requests of the windows whose host.dialog a client watches. While a window is watched, a dialog that
// the window asks for shows no panel: it waits as a request of host.dialog until a client answers it, the watch ends or the
// call that asked ends.
type Dialogs struct {
	mu      sync.Mutex
	watched map[string]bool
	held    map[string][]*heldDialog
	next    uint64
	changed func(window string, value map[string]any)
}

// NewDialogs creates the dialogs of the host. changed receives each new value of host.dialog of a window, in the order of the
// changes; it must not block.
func NewDialogs(changed func(window string, value map[string]any)) *Dialogs {
	return &Dialogs{watched: map[string]bool{}, held: map[string][]*heldDialog{}, changed: changed}
}

// Watched records the start (on) or the end of the watch of host.dialog of window. The end answers each request of the window
// that waits as cancelled.
func (d *Dialogs) Watched(window string, on bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if on {
		d.watched[window] = true
		return
	}
	delete(d.watched, window)
	held := d.held[window]
	if len(held) == 0 {
		return
	}
	delete(d.held, window)
	for _, dialog := range held {
		dialog.answered <- dialogAnswered{applied: make(chan error, 1)}
	}
	d.changed(window, d.value(window))
}

// Value is the value of host.dialog of window: {pending}, the requests that wait in the order they were asked.
func (d *Dialogs) Value(window string) map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.value(window)
}

func (d *Dialogs) value(window string) map[string]any {
	pending := make([]DialogRequest, 0, len(d.held[window]))
	for _, dialog := range d.held[window] {
		pending = append(pending, dialog.request)
	}
	return map[string]any{"pending": pending}
}

// Ask asks for request in window. Without a watch of host.dialog of window, panel shows the person's panel and gives its
// answer. With one, request waits with an id of its own until a client answers it, and Ask returns the chosen paths, or nil
// for a cancel and for the end of the watch. The end of ctx removes the request and returns the error of ctx.
func (d *Dialogs) Ask(ctx context.Context, window string, request DialogRequest, panel func() ([]string, error)) ([]string, error) {
	d.mu.Lock()
	if !d.watched[window] {
		d.mu.Unlock()
		return panel()
	}
	dialog := d.add(window, request)
	d.mu.Unlock()
	select {
	case answer := <-dialog.answered:
		answer.applied <- nil
		return answer.paths, nil
	case <-ctx.Done():
	}
	d.mu.Lock()
	removed := d.remove(window, dialog.request.ID) != nil
	if removed {
		d.changed(window, d.value(window))
	}
	d.mu.Unlock()
	if !removed {
		// An answer or the end of the watch took the request before the end of the call, and the client holds the result of
		// its answer, so the call goes on with it.
		answer := <-dialog.answered
		answer.applied <- nil
		return answer.paths, nil
	}
	return nil, ctx.Err()
}

// add gives request an id of its own, lets it wait in window and announces it. d.mu is held.
func (d *Dialogs) add(window string, request DialogRequest) *heldDialog {
	d.next++
	request.ID = fmt.Sprintf("dialog-%d", d.next)
	dialog := &heldDialog{request: request, answered: make(chan dialogAnswered, 1)}
	d.held[window] = append(d.held[window], dialog)
	d.changed(window, d.value(window))
	return dialog
}

// Hold holds request, a request that a page of window gives the host: the open panel of a file input or the place of a
// download. While a client watches host.dialog of window, it waits until it is answered, and apply applies the chosen paths to
// the page, nil for a cancel; the answer of the client returns the error of apply, so the answer of a download returns when the
// download ended. Without a watch the request is cancelled at once. Hold returns after apply.
func (d *Dialogs) Hold(window string, request DialogRequest, apply func(paths []string) error) {
	d.mu.Lock()
	if !d.watched[window] {
		d.mu.Unlock()
		if err := apply(nil); err != nil {
			LogError("dialog cancel", err)
		}
		return
	}
	dialog := d.add(window, request)
	d.mu.Unlock()
	answer := <-dialog.answered
	err := apply(answer.paths)
	if err != nil && answer.paths == nil {
		LogError("dialog cancel", err)
	}
	answer.applied <- err
}

// remove takes the request id out of the requests of window. d.mu is held.
func (d *Dialogs) remove(window, id string) *heldDialog {
	held := d.held[window]
	for index, dialog := range held {
		if dialog.request.ID != id {
			continue
		}
		held = append(held[:index:index], held[index+1:]...)
		if len(held) == 0 {
			delete(d.held, window)
		} else {
			d.held[window] = held
		}
		return dialog
	}
	return nil
}

// Answer answers the request answer.ID of window and returns when the asker applied the answer, with the error of applying
// it. An answer that the request does not take is refused with the rule and the path, and the request keeps waiting.
func (d *Dialogs) Answer(window string, answer DialogAnswer) error {
	applied := make(chan error, 1)
	if err := d.answer(window, answer, applied); err != nil {
		return err
	}
	return <-applied
}

func (d *Dialogs) answer(window string, answer DialogAnswer, applied chan error) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	var dialog *heldDialog
	for _, held := range d.held[window] {
		if held.request.ID == answer.ID {
			dialog = held
		}
	}
	if dialog == nil {
		return fmt.Errorf("dialog: no request %s waits in %s", answer.ID, window)
	}
	var paths []string
	if !answer.Cancel {
		chosen, err := DialogChoice(dialog.request, answer)
		if err != nil {
			return err
		}
		paths = chosen
	}
	d.remove(window, answer.ID)
	dialog.answered <- dialogAnswered{paths: paths, applied: applied}
	d.changed(window, d.value(window))
	return nil
}

// DialogChoice is the choice that answer gives request, after the checks of the panel of a person: a save or a download takes
// one absolute path in an existing folder whose name is not empty, holds no ':' and does not start with '.', and that names no
// folder and no existing file unless replace is set; a folder takes one existing folder; an open takes existing paths, at least
// one, one unless multiple, and files unless directories.
func DialogChoice(request DialogRequest, answer DialogAnswer) ([]string, error) {
	paths := answer.Paths
	switch request.Kind {
	case DialogSave, DialogDownload:
		if len(paths) != 1 {
			return nil, fmt.Errorf("dialog: a %s takes one path, the answer gives %d", request.Kind, len(paths))
		}
		return paths, savePlace(paths[0], answer.Replace)
	case DialogFolder:
		if len(paths) != 1 {
			return nil, fmt.Errorf("dialog: a folder takes one path, the answer gives %d", len(paths))
		}
		folder, err := existing(paths[0])
		if err != nil {
			return nil, err
		}
		if !folder {
			return nil, fmt.Errorf("dialog: %s is not a folder", paths[0])
		}
		return paths, nil
	case DialogOpen:
		if len(paths) == 0 {
			return nil, errors.New("dialog: an open takes at least one path, the answer gives none")
		}
		if len(paths) > 1 && !request.Multiple {
			return nil, fmt.Errorf("dialog: this open takes one path, the answer gives %d", len(paths))
		}
		for _, path := range paths {
			folder, err := existing(path)
			if err != nil {
				return nil, err
			}
			if folder && !request.Directories {
				return nil, fmt.Errorf("dialog: %s is a folder, and this open takes files", path)
			}
		}
		return paths, nil
	}
	return nil, fmt.Errorf("dialog: unknown kind %s", request.Kind)
}

// savePlace checks the place of a save or a download at path.
func savePlace(path string, replace bool) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("dialog: %s is not absolute", path)
	}
	name := filepath.Base(path)
	switch {
	case strings.HasSuffix(path, string(filepath.Separator)) || name == string(filepath.Separator) || name == ".":
		return fmt.Errorf("dialog: %s has no name", path)
	case strings.Contains(name, ":"):
		return fmt.Errorf("dialog: the name of %s holds ':'", path)
	case strings.HasPrefix(name, "."):
		return fmt.Errorf("dialog: the name of %s starts with '.'", path)
	}
	parent, err := os.Stat(filepath.Dir(path))
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("dialog: the folder of %s does not exist", path)
	}
	if err != nil {
		return fmt.Errorf("dialog: %s: %w", path, err)
	}
	if !parent.IsDir() {
		return fmt.Errorf("dialog: the folder of %s is not a folder", path)
	}
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("dialog: %s: %w", path, err)
	}
	if info.IsDir() {
		return fmt.Errorf("dialog: %s is a folder", path)
	}
	if !replace {
		return fmt.Errorf("dialog: %s exists; an answer that replaces it sets replace", path)
	}
	return nil
}

// existing reports whether the absolute path names a folder; a relative or a missing path is an error.
func existing(path string) (bool, error) {
	if !filepath.IsAbs(path) {
		return false, fmt.Errorf("dialog: %s is not absolute", path)
	}
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, fmt.Errorf("dialog: %s does not exist", path)
	}
	if err != nil {
		return false, fmt.Errorf("dialog: %s: %w", path, err)
	}
	return info.IsDir(), nil
}

// savePath asks where to save name, in directory when it is not empty, for the window of s: the save panel of the person, or
// the answer of a client that watches host.dialog of the window. "" is a cancel.
func (h *Host) savePath(ctx context.Context, s *Surfaces, name, directory string) (string, error) {
	request := DialogRequest{Kind: DialogSave, SuggestedName: &name}
	if directory != "" {
		request.Directory = &directory
	}
	paths, err := h.dialogs.Ask(ctx, s.name, request, func() ([]string, error) {
		return chosenPath(framework.SaveFile(s.window, name, directory))
	})
	if err != nil || len(paths) == 0 {
		return "", err
	}
	return paths[0], nil
}

// folderPath asks for a folder with title for the window of s: the folder panel of the person, or the answer of a client that
// watches host.dialog of the window. "" is a cancel.
func (h *Host) folderPath(ctx context.Context, s *Surfaces, title string) (string, error) {
	paths, err := h.dialogs.Ask(ctx, s.name, DialogRequest{Kind: DialogFolder}, func() ([]string, error) {
		return chosenPath(framework.ChooseFolder(s.window, title))
	})
	if err != nil || len(paths) == 0 {
		return "", err
	}
	return paths[0], nil
}

// chosenPath is the choice of a panel that answers one path, "" for a cancel.
func chosenPath(path string, err error) ([]string, error) {
	if err != nil || path == "" {
		return nil, err
	}
	return []string{path}, nil
}

// holdDialogs holds (on) or releases the dialogs of the pages of the window of s: while held, the open panel of a file input
// and the place of a download of a page are requests of host.dialog (docs/spec/exposure.md#dialogs).
func (s *Surfaces) holdDialogs(on bool) {
	if !on {
		// The release does not use the window, so it runs also after the window closed.
		mainThreadStep(func() {
			if s.dialogHold != nil {
				system.ReleaseDialogs(s.dialogHold)
				s.dialogHold = nil
			}
		})
		return
	}
	err := s.useWindow(func(window platform.Window) error {
		if s.dialogHold != nil {
			return nil
		}
		hold, err := system.HoldDialogs(window, func(request uint64, fields string) {
			routine.Go("dialog-request", func() { s.pageDialog(request, fields) })
		})
		if err != nil {
			return err
		}
		s.dialogHold = hold
		return nil
	})
	if err != nil {
		LogError("dialog hold", err)
	}
}

// pageDialog holds the request number of a page of the window of s, whose fields the native layer gives, and applies its
// answer to the page.
func (s *Surfaces) pageDialog(number uint64, fields string) {
	var request DialogRequest
	apply := func(paths []string) error {
		answered := make(chan string, 1)
		mainThreadStep(func() { system.AnswerDialog(number, paths, paths == nil, func(failure string) { answered <- failure }) })
		if failure := <-answered; failure != "" {
			return errors.New(failure)
		}
		return nil
	}
	if err := json.Unmarshal([]byte(fields), &request); err != nil {
		LogError("dialog request", fmt.Errorf("%s: %w", fields, err))
		if err := apply(nil); err != nil {
			LogError("dialog cancel", err)
		}
		return
	}
	s.host.dialogs.Hold(s.name, request, apply)
}
