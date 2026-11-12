package host

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// panelFramework is the framework of a dialog test: its save panel and folder panel answer the person's choice and count their
// calls, so a test tells a request that the client answered from one that a person's panel answered.
type panelFramework struct {
	frameworkRecord
	mu     sync.Mutex
	panels []string
}

func (f *panelFramework) SaveFile(_ Frontend, name, directory string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.panels = append(f.panels, "save "+name+" in "+directory)
	return "/person/" + name, nil
}

func (f *panelFramework) ChooseFolder(_ Frontend, title string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.panels = append(f.panels, "folder "+title)
	return "/person", nil
}

func (f *panelFramework) shown() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.panels...)
}

// dialogHost is a host with one window "w1" whose dialogs announce each value of host.dialog to changes.
func dialogHost(t *testing.T) (*Host, *Surfaces, context.Context, *panelFramework, chan map[string]any) {
	t.Helper()
	saved := framework
	panels := &panelFramework{}
	framework = panels
	t.Cleanup(func() { framework = saved })
	changes := make(chan map[string]any, 16)
	h := &Host{windows: map[uint]*Surfaces{}}
	h.dialogs = NewDialogs(func(window string, value map[string]any) {
		if window != "w1" {
			t.Errorf("host.dialog of %s changed, want w1", window)
		}
		changes <- value
	})
	s := &Surfaces{host: h, window: &frontendRecord{}, name: "w1"}
	h.windows[0] = s
	return h, s, WithFrontend(context.Background(), s.window), panels, changes
}

// chosen is what a call that asked for a dialog returned.
type chosen struct {
	path string
	err  error
}

// heldBy waits for the value of host.dialog that the request of a call announces. A call that returns first was not held: its
// panel answered, and the test fails at once.
func heldBy(t *testing.T, changes chan map[string]any, returned chan chosen) map[string]any {
	t.Helper()
	select {
	case value := <-changes:
		return value
	case got := <-returned:
		t.Fatalf("the call returned %q, %v without a held request", got.path, got.err)
		return nil
	}
}

// announced is the value of host.dialog that a change announced before the call that made it returned. The change is
// announced in that call, so a change that is not there was never announced, and the test fails at once.
func announced(t *testing.T, changes chan map[string]any) map[string]any {
	t.Helper()
	select {
	case value := <-changes:
		return value
	default:
		t.Fatal("the change of host.dialog was not announced")
		return nil
	}
}

// pendingOf reads the requests of a value of host.dialog.
func pendingOf(t *testing.T, value map[string]any) []DialogRequest {
	t.Helper()
	pending, ok := value["pending"].([]DialogRequest)
	if !ok {
		t.Fatalf("host.dialog %v has no pending list", value)
	}
	return pending
}

// While a client watches host.dialog of a window, a save panel and a folder panel that the host would show for the window are
// held as requests, none shows, and the answer of the client reaches the caller as the choice of the panel would. Without a
// watch the person's panel shows as before.
// contract: dialog.host.held
func TestAWatchedWindowHoldsTheSaveAndFolderPanelsOfTheHost(t *testing.T) {
	h, s, ctx, panels, changes := dialogHost(t)
	folder := t.TempDir()

	if got, err := h.savePath(ctx, s, "host.jsonl", ""); err != nil || got != "/person/host.jsonl" {
		t.Fatalf("an unwatched save answered %q, %v; want the person's panel", got, err)
	}
	if got, err := h.folderPath(ctx, s, "프로젝트 폴더 선택"); err != nil || got != "/person" {
		t.Fatalf("an unwatched folder answered %q, %v; want the person's panel", got, err)
	}
	h.dialogs.Watched("w1", true)

	saved := make(chan chosen, 1)
	go func() {
		path, err := h.savePath(ctx, s, "host.jsonl", folder)
		saved <- chosen{path, err}
	}()
	pending := pendingOf(t, heldBy(t, changes, saved))
	if len(pending) != 1 || pending[0].Kind != DialogSave || pending[0].SuggestedName == nil || *pending[0].SuggestedName != "host.jsonl" ||
		pending[0].Directory == nil || *pending[0].Directory != folder || pending[0].ID == "" {
		t.Fatalf("the held save is %+v", pending)
	}
	if value := h.dialogs.Value("w1"); !reflect.DeepEqual(pendingOf(t, value), pending) {
		t.Fatalf("host.dialog reads %v, it announced %v", value, pending)
	}
	target := filepath.Join(folder, "saved.jsonl")
	if err := h.dialogs.Answer("w1", DialogAnswer{ID: pending[0].ID, Paths: []string{target}}); err != nil {
		t.Fatal(err)
	}
	if got := <-saved; got.err != nil || got.path != target {
		t.Fatalf("the answered save gave the caller %q, %v; want %s", got.path, got.err, target)
	}
	if pending := pendingOf(t, announced(t, changes)); len(pending) != 0 {
		t.Fatalf("an answered save stays pending: %+v", pending)
	}

	folders := make(chan chosen, 1)
	go func() {
		path, err := h.folderPath(ctx, s, "프로젝트 폴더 선택")
		folders <- chosen{path, err}
	}()
	pending = pendingOf(t, heldBy(t, changes, folders))
	if len(pending) != 1 || pending[0].Kind != DialogFolder {
		t.Fatalf("the held folder is %+v", pending)
	}
	if err := h.dialogs.Answer("w1", DialogAnswer{ID: pending[0].ID, Cancel: true}); err != nil {
		t.Fatal(err)
	}
	if got := <-folders; got.err != nil || got.path != "" {
		t.Fatalf("a cancelled folder gave the caller %q, %v; want the cancel of the panel", got.path, got.err)
	}
	announced(t, changes)
	if shown := panels.shown(); len(shown) != 2 {
		t.Fatalf("a watched window showed the panels %v", shown[2:])
	}
	if err := h.dialogs.Answer("w1", DialogAnswer{ID: pending[0].ID, Cancel: true}); err == nil ||
		!strings.Contains(err.Error(), pending[0].ID) {
		t.Fatalf("an answer of a request that waits no more gave %v", err)
	}
}

// The end of the last watch of host.dialog of a window answers each request that waits as cancelled, and a request of the
// window then shows the person's panel again.
// contract: dialog.watch.end-cancels
func TestTheEndOfTheWatchCancelsTheHeldDialogs(t *testing.T) {
	h, s, ctx, panels, changes := dialogHost(t)
	h.dialogs.Watched("w1", true)
	answered := make(chan chosen, 1)
	go func() {
		path, err := h.savePath(ctx, s, "host.jsonl", "")
		answered <- chosen{path, err}
	}()
	heldBy(t, changes, answered)
	h.dialogs.Watched("w1", false)
	if got := <-answered; got.err != nil || got.path != "" {
		t.Fatalf("the end of the watch gave the caller %q, %v; want the cancel of the panel", got.path, got.err)
	}
	if pending := pendingOf(t, announced(t, changes)); len(pending) != 0 {
		t.Fatalf("requests stay after the end of the watch: %+v", pending)
	}
	if got, err := h.savePath(ctx, s, "host.jsonl", ""); err != nil || got != "/person/host.jsonl" || len(panels.shown()) != 1 {
		t.Fatalf("a save after the end of the watch answered %q, %v with the panels %v", got, err, panels.shown())
	}
}

// The end of the call that asked, the end of its page call, removes its request.
// contract: dialog.watch.end-cancels
func TestTheEndOfTheCallRemovesItsRequest(t *testing.T) {
	h, s, ctx, _, changes := dialogHost(t)
	h.dialogs.Watched("w1", true)
	ended, end := context.WithCancel(ctx)
	failed := make(chan chosen, 1)
	go func() {
		path, err := h.savePath(ended, s, "host.jsonl", "")
		failed <- chosen{path, err}
	}()
	heldBy(t, changes, failed)
	end()
	if got := <-failed; got.err == nil {
		t.Fatal("an ended call answered without an error")
	}
	if pending := pendingOf(t, announced(t, changes)); len(pending) != 0 {
		t.Fatalf("the request of an ended call stays: %+v", pending)
	}
}

// An answer passes the checks of the panel of a person: a save or a download takes one absolute path in an existing folder whose
// name is not empty, holds no ':' and does not start with '.', and that names no existing file unless replace is set; a folder
// takes one existing folder; an open takes existing paths, one unless multiple, and files unless directories. A refusal states
// the rule and the path, and the request stays.
// contract: dialog.answer.rules
func TestAnAnswerPassesTheChecksOfThePanel(t *testing.T) {
	folder := t.TempDir()
	existing := filepath.Join(folder, "existing")
	if err := os.WriteFile(existing, []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	inner := filepath.Join(folder, "inner")
	if err := os.Mkdir(inner, 0o700); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(folder, "missing")
	save := DialogRequest{Kind: DialogSave}
	for _, c := range []struct {
		request DialogRequest
		answer  DialogAnswer
		want    []string
		refusal string
	}{
		{save, DialogAnswer{Paths: []string{filepath.Join(folder, "new")}}, []string{filepath.Join(folder, "new")}, ""},
		{save, DialogAnswer{Paths: []string{existing}, Replace: true}, []string{existing}, ""},
		{save, DialogAnswer{Paths: []string{existing}}, nil, "exists"},
		{save, DialogAnswer{Paths: []string{inner}, Replace: true}, nil, "is a folder"},
		{save, DialogAnswer{Paths: []string{"relative"}}, nil, "is not absolute"},
		{save, DialogAnswer{Paths: []string{filepath.Join(folder, "a:b")}}, nil, "holds ':'"},
		{save, DialogAnswer{Paths: []string{filepath.Join(folder, ".hidden")}}, nil, "starts with '.'"},
		{save, DialogAnswer{Paths: []string{filepath.Join(missing, "new")}}, nil, "does not exist"},
		{save, DialogAnswer{Paths: []string{filepath.Join(existing, "new")}}, nil, "is not a folder"},
		{save, DialogAnswer{Paths: []string{filepath.Join(folder, "a"), filepath.Join(folder, "b")}}, nil, "takes one path"},
		{save, DialogAnswer{}, nil, "takes one path"},
		{DialogRequest{Kind: DialogDownload}, DialogAnswer{Paths: []string{existing}}, nil, "exists"},
		{DialogRequest{Kind: DialogDownload}, DialogAnswer{Paths: []string{filepath.Join(folder, "got")}}, []string{filepath.Join(folder, "got")}, ""},
		{DialogRequest{Kind: DialogFolder}, DialogAnswer{Paths: []string{inner}}, []string{inner}, ""},
		{DialogRequest{Kind: DialogFolder}, DialogAnswer{Paths: []string{existing}}, nil, "is not a folder"},
		{DialogRequest{Kind: DialogFolder}, DialogAnswer{Paths: []string{missing}}, nil, "does not exist"},
		{DialogRequest{Kind: DialogOpen}, DialogAnswer{Paths: []string{existing}}, []string{existing}, ""},
		{DialogRequest{Kind: DialogOpen}, DialogAnswer{Paths: []string{existing, existing}}, nil, "takes one path"},
		{DialogRequest{Kind: DialogOpen, Multiple: true}, DialogAnswer{Paths: []string{existing, existing}}, []string{existing, existing}, ""},
		{DialogRequest{Kind: DialogOpen}, DialogAnswer{Paths: []string{inner}}, nil, "takes files"},
		{DialogRequest{Kind: DialogOpen, Directories: true}, DialogAnswer{Paths: []string{inner}}, []string{inner}, ""},
		{DialogRequest{Kind: DialogOpen}, DialogAnswer{Paths: []string{missing}}, nil, "does not exist"},
		{DialogRequest{Kind: DialogOpen, Multiple: true}, DialogAnswer{}, nil, "takes at least one path"},
	} {
		got, err := DialogChoice(c.request, c.answer)
		if c.refusal == "" {
			if err != nil || !reflect.DeepEqual(got, c.want) {
				t.Errorf("%s %+v answered %v, %v; want %v", c.request.Kind, c.answer, got, err, c.want)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.refusal) {
			t.Errorf("%s %+v answered %v, %v; want the refusal %q", c.request.Kind, c.answer, got, err, c.refusal)
		} else if len(c.answer.Paths) == 1 && !strings.Contains(err.Error(), c.answer.Paths[0]) {
			t.Errorf("the refusal %q does not name the path %s", err, c.answer.Paths[0])
		}
	}

	h, s, ctx, _, changes := dialogHost(t)
	h.dialogs.Watched("w1", true)
	asked := make(chan chosen, 1)
	go func() {
		path, err := h.savePath(ctx, s, "host.jsonl", "")
		asked <- chosen{path, err}
	}()
	pending := pendingOf(t, heldBy(t, changes, asked))
	if err := h.dialogs.Answer("w1", DialogAnswer{ID: pending[0].ID, Paths: []string{existing}}); err == nil {
		t.Fatal("a held save took an existing file without replace")
	}
	if still := pendingOf(t, h.dialogs.Value("w1")); len(still) != 1 || still[0].ID != pending[0].ID {
		t.Fatalf("a refused answer did not leave its request: %+v", still)
	}
	h.dialogs.Watched("w1", false)
	if got := <-asked; got.err != nil || got.path != "" {
		t.Fatalf("the end of the watch gave the caller %q, %v; want the cancel of the panel", got.path, got.err)
	}
}
