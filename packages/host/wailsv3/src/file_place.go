package host

// The save place of a new document (docs/spec/plugins.md#pluginjson): the host shows the save panel in the project root of
// the window and answers the chosen file relative to that root.

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// FilePlaceRequest is the argument of the filePlace call: the file name that the save panel offers.
type FilePlaceRequest struct {
	Name string `json:"name"`
}

// FilePlaced is the answer of filePlace: the chosen file relative to the project root, or nil when the person cancelled.
type FilePlaced struct {
	Path *string `json:"path"`
}

// FilePlaceName refuses a name that is not a file name: empty, `.`, `..`, or holding a separator.
func FilePlaceName(name string) error {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return fmt.Errorf("file place: name %s is not a file name", name)
	}
	return nil
}

// FilePlaceRelative answers chosen relative to root with `/` between its parts, after the symbolic links of root and of the
// folder of chosen are resolved, and refuses a place that is not inside root.
func FilePlaceRelative(root, chosen string) (string, error) {
	outside := fmt.Errorf("file place: %s is outside the project %s", chosen, root)
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("file place: %s: %w", root, err)
	}
	folder, err := filepath.EvalSymlinks(filepath.Dir(chosen))
	if err != nil {
		return "", fmt.Errorf("file place: %s: %w", chosen, err)
	}
	relative, err := filepath.Rel(realRoot, filepath.Join(folder, filepath.Base(chosen)))
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", outside
	}
	return filepath.ToSlash(relative), nil
}

// FilePlace is the page's filePlace call: it shows the save panel of the window in its project root with the name and
// answers the chosen file relative to that root.
func (h *Host) FilePlace(ctx context.Context, requestJSON json.RawMessage) (FilePlaced, error) {
	request, err := argument[FilePlaceRequest]("request", requestJSON)
	if err != nil {
		return FilePlaced{}, err
	}
	if err := FilePlaceName(request.Name); err != nil {
		return FilePlaced{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return FilePlaced{}, err
	}
	root := s.ProjectRoot()
	if root == "" {
		return FilePlaced{}, fmt.Errorf("file place: the window shows no project")
	}
	chosen, err := application.Get().Dialog.SaveFile().SetFilename(request.Name).SetDirectory(root).AttachToWindow(s.window).PromptForSingleSelection()
	if err != nil {
		return FilePlaced{}, fmt.Errorf("file place: save panel: %w", err)
	}
	if chosen == "" {
		return FilePlaced{}, nil
	}
	relative, err := FilePlaceRelative(root, chosen)
	if err != nil {
		return FilePlaced{}, err
	}
	return FilePlaced{Path: &relative}, nil
}
