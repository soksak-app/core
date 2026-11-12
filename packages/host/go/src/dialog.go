package host

import (
	"context"
	"fmt"
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

// Dialogs holds the dialog requests of the windows whose host.dialog a client watches.
type Dialogs struct {
	changed func(window string, value map[string]any)
}

// NewDialogs creates the dialogs of the host. changed receives each new value of host.dialog of a window.
func NewDialogs(changed func(window string, value map[string]any)) *Dialogs {
	return &Dialogs{changed: changed}
}

// Watched records the start (on) or the end of the watch of host.dialog of window.
func (d *Dialogs) Watched(window string, on bool) {}

// Value is the value of host.dialog of window.
func (d *Dialogs) Value(window string) map[string]any {
	return map[string]any{"pending": []DialogRequest{}}
}

// Answer answers a request of window.
func (d *Dialogs) Answer(window string, answer DialogAnswer) error {
	return fmt.Errorf("dialog: no request %s waits in %s", answer.ID, window)
}

// DialogChoice is the choice that answer gives request.
func DialogChoice(request DialogRequest, answer DialogAnswer) ([]string, error) {
	return answer.Paths, nil
}

// savePath asks where to save name in directory.
func (h *Host) savePath(ctx context.Context, s *Surfaces, name, directory string) (string, error) {
	return framework.SaveFile(s.window, name, directory)
}

// folderPath asks for a folder with title.
func (h *Host) folderPath(ctx context.Context, s *Surfaces, title string) (string, error) {
	return framework.ChooseFolder(s.window, title)
}
