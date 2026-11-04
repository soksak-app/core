package workbench

import (
	"encoding/json"
	"fmt"
	"path"
	"slices"
	"strings"
)

// FilePlugin is a loaded plugin as the file commands read it: its id and the extensions of surface.opens, which are none for
// a plugin that declares no surface.opens.
type FilePlugin struct {
	ID    string
	Opens []string
}

// FileWorkspace is the workbench of a window as the file commands use it.
type FileWorkspace interface {
	// HasProject tells whether the window shows a project.
	HasProject() bool
	// FilePlugins returns the loaded plugins.
	FilePlugins() []FilePlugin
	// TabOfFile returns the card and the tab of plugin that show path.
	TabOfFile(plugin, path string) (card, tab string, found bool)
	// SelectTab activates tab.
	SelectTab(tab string) error
	// FocusedCard returns the focused card.
	FocusedCard() string
	// AddTab adds a tab of plugin that shows path to card and returns the tab.
	AddTab(card, plugin, path string) (string, error)
}

// FileOpened is the result of core.file.open.
type FileOpened struct {
	Card string `json:"card"`
	Tab  string `json:"tab"`
}

// extensionOf returns the extension of the file name of file in lowercase, and false for a name without one.
func extensionOf(file string) (string, bool) {
	name := file[strings.LastIndex(file, "/")+1:]
	dot := strings.LastIndex(name, ".")
	if dot <= 0 {
		return "", false
	}
	return strings.ToLower(name[dot+1:]), true
}

// ChooseOpener returns the id of the plugin that opens file, from the surface.opens declarations of plugins
// (docs/spec/plugins.md#pluginjson). Only a declared extension connects a file to a plugin: a file whose extension no plugin
// declares has no opener, and two plugins that declare the extension are an error, not a choice.
func ChooseOpener(plugins []FilePlugin, file string) (string, error) {
	var openers []string
	if extension, ok := extensionOf(file); ok {
		for _, plugin := range plugins {
			if slices.Contains(plugin.Opens, extension) {
				openers = append(openers, plugin.ID)
			}
		}
	}
	switch len(openers) {
	case 0:
		return "", fmt.Errorf("no plugin opens %s", file)
	case 1:
		return openers[0], nil
	}
	return "", fmt.Errorf("%s is opened by %s", file, strings.Join(openers, " and "))
}

// CheckOpenPath refuses a path that is not relative to the project root or that has a .. segment.
func CheckOpenPath(file string) error {
	if file == "" || path.IsAbs(file) || slices.Contains(strings.Split(file, "/"), "..") {
		return fmt.Errorf("path must be relative to the project root: %s", file)
	}
	return nil
}

// OpenFile opens file, relative to the project root, in the plugin that declares its extension: it activates the tab of that
// plugin with the same path, or adds one to card, or to the focused card when card is empty.
func OpenFile(workspace FileWorkspace, file, card string) (FileOpened, error) {
	opener, err := ChooseOpener(workspace.FilePlugins(), file)
	if err != nil {
		return FileOpened{}, err
	}
	if owner, tab, found := workspace.TabOfFile(opener, file); found {
		if err := workspace.SelectTab(tab); err != nil {
			return FileOpened{}, err
		}
		return FileOpened{Card: owner, Tab: tab}, nil
	}
	if card == "" {
		card = workspace.FocusedCard()
	}
	tab, err := workspace.AddTab(card, opener, file)
	if err != nil {
		return FileOpened{}, err
	}
	return FileOpened{Card: card, Tab: tab}, nil
}

// RegisterFileCommands registers core.file.open and core.file.place of the window of workspace.
func RegisterFileCommands(registry *Registry, workspace FileWorkspace, calls *Calls) {
	registry.Command("core.file.open", func(params json.RawMessage) (any, error) {
		var request struct {
			Path string `json:"path"`
			Card string `json:"card"`
		}
		if err := json.Unmarshal(params, &request); err != nil {
			return nil, fmt.Errorf("core.file.open: %w", err)
		}
		if !workspace.HasProject() {
			return nil, fmt.Errorf("this window shows no project")
		}
		if err := CheckOpenPath(request.Path); err != nil {
			return nil, err
		}
		return OpenFile(workspace, request.Path, request.Card)
	})
	// The host shows the save panel of the window, so the answer comes when the person has answered.
	registry.CommandLater("core.file.place", func(params json.RawMessage, answer func(any, error)) {
		calls.Call("filePlace", params, answer)
	})
}
