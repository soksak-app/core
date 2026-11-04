// The file commands choose the plugin that opens a file and which paths they take (docs/spec/plugins.md#pluginjson), as
// packages/workbench/test/file-open.test.mjs states them for the page workbench.
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

var filePlugins = []workbench.FilePlugin{
	{ID: "notes", Opens: []string{"md", "txt"}},
	{ID: "rust", Opens: []string{"rs"}},
	{ID: "plain"},
}

func TestThePluginThatDeclaresTheExtensionOpensAFile(t *testing.T) {
	for path, want := range map[string]string{"docs/a.md": "notes", "docs/A.MD": "notes", "src/main.rs": "rust"} {
		if got, err := workbench.ChooseOpener(filePlugins, path); err != nil || got != want {
			t.Errorf("%s: opener %q, %v, want %q", path, got, err, want)
		}
	}
	for _, path := range []string{"src/main.go", "Makefile", ".gitignore"} {
		if _, err := workbench.ChooseOpener(filePlugins, path); err == nil || err.Error() != "no plugin opens "+path {
			t.Errorf("%s: error %v", path, err)
		}
	}
	any := append(filePlugins[:3:3], workbench.FilePlugin{ID: "any", Opens: []string{"*"}})
	if _, err := workbench.ChooseOpener(any, "Makefile"); err == nil || err.Error() != "no plugin opens Makefile" {
		t.Errorf("a declaration of * is not a declaration of any extension: %v", err)
	}
	other := append(filePlugins[:3:3], workbench.FilePlugin{ID: "other", Opens: []string{"md"}})
	if _, err := workbench.ChooseOpener(other, "a.md"); err == nil || err.Error() != "a.md is opened by notes and other" {
		t.Errorf("two openers: %v", err)
	}
}

func TestAPathToOpenIsRelativeToTheProjectRoot(t *testing.T) {
	if err := workbench.CheckOpenPath("docs/a.md"); err != nil {
		t.Error(err)
	}
	for _, path := range []string{"/etc/hosts", "../a.md", "docs/../../a.md", ""} {
		if err := workbench.CheckOpenPath(path); err == nil || !strings.HasPrefix(err.Error(), "path must be relative to the project root") {
			t.Errorf("%q: error %v", path, err)
		}
	}
}

// fileWorkspace is the shell as the file commands see it.
type fileWorkspace struct {
	project  bool
	focused  string
	tabs     map[string][2]string // plugin + path -> card, tab
	selected []string
	added    [][3]string
}

func (w *fileWorkspace) HasProject() bool                    { return w.project }
func (w *fileWorkspace) FilePlugins() []workbench.FilePlugin { return filePlugins }
func (w *fileWorkspace) FocusedCard() string                 { return w.focused }
func (w *fileWorkspace) TabOfFile(plugin, path string) (string, string, bool) {
	found, ok := w.tabs[plugin+" "+path]
	return found[0], found[1], ok
}
func (w *fileWorkspace) SelectTab(tab string) error { w.selected = append(w.selected, tab); return nil }
func (w *fileWorkspace) AddTab(card, plugin, path string) (string, error) {
	w.added = append(w.added, [3]string{card, plugin, path})
	return "new-tab", nil
}

func fileRegistry(t *testing.T, w workbench.FileWorkspace, place workbench.HostCall) *workbench.Registry {
	t.Helper()
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	registry := workbench.NewRegistry(declared)
	calls := workbench.NewCalls(map[string]workbench.HostCall{"filePlace": place}, func(task func()) { task() })
	workbench.RegisterFileCommands(registry, w, calls)
	return registry
}

func TestCoreFileOpenSelectsTheOpenTabOrAddsOneToTheCard(t *testing.T) {
	w := &fileWorkspace{project: true, focused: "focused", tabs: map[string][2]string{"notes a.md": {"card-1", "tab-1"}}}
	registry := fileRegistry(t, w, nil)
	opened, err := registry.Run("core.file.open", json.RawMessage(`{"path":"a.md"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := opened.(workbench.FileOpened); got != (workbench.FileOpened{Card: "card-1", Tab: "tab-1"}) || len(w.selected) != 1 || w.selected[0] != "tab-1" {
		t.Fatalf("opened %+v, selected %v", got, w.selected)
	}
	opened, err = registry.Run("core.file.open", json.RawMessage(`{"path":"b.md"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := opened.(workbench.FileOpened); got != (workbench.FileOpened{Card: "focused", Tab: "new-tab"}) {
		t.Fatalf("a new tab goes to the focused card: %+v", got)
	}
	if _, err = registry.Run("core.file.open", json.RawMessage(`{"path":"c.rs","card":"card-2"}`)); err != nil {
		t.Fatal(err)
	}
	if last := w.added[len(w.added)-1]; last != [3]string{"card-2", "rust", "c.rs"} {
		t.Fatalf("added %v", last)
	}
}

func TestCoreFileOpenRefusesAWindowWithoutAProjectAndAnAbsolutePath(t *testing.T) {
	registry := fileRegistry(t, &fileWorkspace{}, nil)
	if _, err := registry.Run("core.file.open", json.RawMessage(`{"path":"a.md"}`)); err == nil || err.Error() != "this window shows no project" {
		t.Fatalf("no project: %v", err)
	}
	registry = fileRegistry(t, &fileWorkspace{project: true}, nil)
	if _, err := registry.Run("core.file.open", json.RawMessage(`{"path":"/etc/hosts"}`)); err == nil || err.Error() != "path must be relative to the project root: /etc/hosts" {
		t.Fatalf("absolute path: %v", err)
	}
}

func TestCoreFilePlaceAnswersWithTheAnswerOfTheHost(t *testing.T) {
	var asked string
	registry := fileRegistry(t, &fileWorkspace{project: true}, func(_ context.Context, argument json.RawMessage) (any, error) {
		asked = string(argument)
		return map[string]any{"path": "notes/a.md"}, nil
	})
	done := make(chan struct{})
	var value any
	var failure error
	registry.RunLater("core.file.place", json.RawMessage(`{"name":"a.md"}`), func(answer any, err error) {
		value, failure = answer, err
		close(done)
	})
	<-done
	if failure != nil || value.(map[string]any)["path"] != "notes/a.md" || asked != `{"name":"a.md"}` {
		t.Fatalf("answer %v, %v, asked %s", value, failure, asked)
	}
}

func TestACommandThatAnswersLaterIsNotRunWithoutAnAnswer(t *testing.T) {
	registry := fileRegistry(t, &fileWorkspace{project: true}, func(context.Context, json.RawMessage) (any, error) {
		return nil, errors.New("the panel must not open")
	})
	if _, err := registry.Run("core.file.place", json.RawMessage(`{"name":"a.md"}`)); err == nil || !strings.Contains(err.Error(), "answers in a later step") {
		t.Fatalf("error %v", err)
	}
}

func TestAnswerGivesTheResultOfACommandThatReturns(t *testing.T) {
	registry := fileRegistry(t, &fileWorkspace{project: true, focused: "focused"}, nil)
	var value any
	var failure error
	registry.RunLater("core.file.open", json.RawMessage(`{"path":"a.md"}`), func(answer any, err error) { value, failure = answer, err })
	if failure != nil || value.(workbench.FileOpened).Card != "focused" {
		t.Fatalf("answer %v, %v", value, failure)
	}
}

func TestACommandThatAnswersLaterIsADeclaredCommandOfTheRegistry(t *testing.T) {
	r := registry(t)
	refused(t, func() { r.CommandLater("core.not.declared", func(json.RawMessage, func(any, error)) {}) })
	r.CommandLater("core.file.place", func(json.RawMessage, func(any, error)) {})
	refused(t, func() { r.CommandLater("core.file.place", func(json.RawMessage, func(any, error)) {}) })
	refused(t, func() { r.Command("core.file.place", func(json.RawMessage) (any, error) { return nil, nil }) })
	if commands, _ := r.Names(); len(commands) != 1 || commands[0] != "core.file.place" {
		t.Fatalf("names %v", commands)
	}
}
