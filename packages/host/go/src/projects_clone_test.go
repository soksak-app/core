package host

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// bareRepository makes a local bare repository with one commit, which the clone reads through its path (no network).
func bareRepository(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	source := filepath.Join(dir, "source")
	if err := os.Mkdir(source, 0755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", source}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("widget\n"), 0644); err != nil {
		t.Fatal(err)
	}
	run("add", "README.md")
	run("commit", "-q", "-m", "init")
	bare := filepath.Join(dir, "widget.git")
	if out, err := exec.Command("git", "clone", "-q", "--bare", source, bare).CombinedOutput(); err != nil {
		t.Fatalf("git clone --bare: %v\n%s", err, out)
	}
	return bare
}

func cloneRequest(t *testing.T, address, target string) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]string{"address": address, "target": target})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// The clone writes the repository into the target and returns the identity of the target folder.
// contract: projects.clone.clones-the-address-into-the-target
func TestProjectCloneClonesTheAddressIntoTheTarget(t *testing.T) {
	address := bareRepository(t)
	target := filepath.Join(t.TempDir(), "widget")
	folder, err := (&Host{}).ProjectClone(context.Background(), cloneRequest(t, address, target))
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(filepath.Join(target, "README.md"))
	if err != nil || string(content) != "widget\n" {
		t.Fatalf("the clone has no README.md of the repository: %v %q", err, content)
	}
	if folder.Identity == "" || !strings.HasSuffix(folder.Root, "widget") {
		t.Fatalf("the clone returned %+v, want the target folder with its identity", folder)
	}
}

// An existing target is refused before any clone starts, and its content stays.
// contract: projects.clone.refuses-an-existing-target-and-keeps-it
func TestProjectCloneRefusesAnExistingTargetAndKeepsIt(t *testing.T) {
	address := bareRepository(t)
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(target, "keep.txt"), []byte("kept"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := (&Host{}).ProjectClone(context.Background(), cloneRequest(t, address, target))
	if err == nil || !strings.Contains(err.Error(), target+" already exists") {
		t.Fatalf("ProjectClone error %v, want %s already exists", err, target)
	}
	if content, err := os.ReadFile(filepath.Join(target, "keep.txt")); err != nil || string(content) != "kept" {
		t.Fatalf("the existing target was changed: %v %q", err, content)
	}
}

// A failed clone leaves no target folder, and the refusal names the git failure.
// contract: projects.clone.failed-clone-leaves-no-target-folder
func TestProjectCloneFailureLeavesNoTargetFolder(t *testing.T) {
	target := filepath.Join(t.TempDir(), "widget")
	_, err := (&Host{}).ProjectClone(context.Background(), cloneRequest(t, filepath.Join(t.TempDir(), "missing.git"), target))
	if err == nil {
		t.Fatal("a clone of a missing repository succeeded")
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Fatalf("the target %s remains after the failed clone", target)
	}
}

// A parent of the target that is not a folder is refused before any clone starts.
// contract: projects.clone.refuses-a-parent-that-is-no-folder
func TestProjectCloneRefusesAParentThatIsNoFolder(t *testing.T) {
	address := bareRepository(t)
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := (&Host{}).ProjectClone(context.Background(), cloneRequest(t, address, filepath.Join(file, "widget")))
	if err == nil || !strings.Contains(err.Error(), file+" is not a folder") {
		t.Fatalf("ProjectClone error %v, want %s is not a folder", err, file)
	}
}

// cloneWindow is the window of a call; it records the lines of the project-clone events.
type cloneWindow struct {
	Frontend
	mu    sync.Mutex
	lines []string
}

func (w *cloneWindow) Emit(name string, data ...any) {
	if name != "project-clone" || len(data) != 1 {
		return
	}
	event, ok := data[0].(map[string]string)
	if !ok {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.lines = append(w.lines, event["line"])
}

// The clone sends each line of its output to the window of the call as a project-clone event.
// contract: projects.clone.sends-each-output-line-to-the-window-of-the-call
func TestProjectCloneSendsEachOutputLineToTheWindowOfTheCall(t *testing.T) {
	address := bareRepository(t)
	target := filepath.Join(t.TempDir(), "widget")
	window := &cloneWindow{}
	if _, err := (&Host{}).ProjectClone(WithFrontend(context.Background(), window), cloneRequest(t, address, target)); err != nil {
		t.Fatal(err)
	}
	window.mu.Lock()
	defer window.mu.Unlock()
	if !slices.ContainsFunc(window.lines, func(line string) bool { return strings.HasPrefix(line, "Cloning into") }) {
		t.Fatalf("the window received %q, want the output of git", window.lines)
	}
}

// A clone from a file address streams the progress lines of git to the window of the call, not only its first line.
// contract: projects.clone.streams-the-progress-lines-of-git
func TestProjectCloneStreamsTheProgressLinesOfGit(t *testing.T) {
	address := "file://" + bareRepository(t)
	target := filepath.Join(t.TempDir(), "widget")
	window := &cloneWindow{}
	if _, err := (&Host{}).ProjectClone(WithFrontend(context.Background(), window), cloneRequest(t, address, target)); err != nil {
		t.Fatal(err)
	}
	window.mu.Lock()
	defer window.mu.Unlock()
	progress := 0
	for _, line := range window.lines {
		if strings.Contains(line, "objects") {
			progress++
		}
	}
	if progress == 0 {
		t.Fatalf("the window received %q, want the progress lines of git", window.lines)
	}
}
