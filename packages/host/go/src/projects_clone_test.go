package host

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
func TestProjectCloneClonesTheAddressIntoTheTarget(t *testing.T) {
	address := bareRepository(t)
	target := filepath.Join(t.TempDir(), "widget")
	folder, err := (&Host{}).ProjectClone(cloneRequest(t, address, target))
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
func TestProjectCloneRefusesAnExistingTargetAndKeepsIt(t *testing.T) {
	address := bareRepository(t)
	target := t.TempDir()
	if err := os.WriteFile(filepath.Join(target, "keep.txt"), []byte("kept"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := (&Host{}).ProjectClone(cloneRequest(t, address, target))
	if err == nil || !strings.Contains(err.Error(), target+" already exists") {
		t.Fatalf("ProjectClone error %v, want %s already exists", err, target)
	}
	if content, err := os.ReadFile(filepath.Join(target, "keep.txt")); err != nil || string(content) != "kept" {
		t.Fatalf("the existing target was changed: %v %q", err, content)
	}
}

// A failed clone leaves no target folder, and the refusal names the git failure.
func TestProjectCloneFailureLeavesNoTargetFolder(t *testing.T) {
	target := filepath.Join(t.TempDir(), "widget")
	_, err := (&Host{}).ProjectClone(cloneRequest(t, filepath.Join(t.TempDir(), "missing.git"), target))
	if err == nil {
		t.Fatal("a clone of a missing repository succeeded")
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Fatalf("the target %s remains after the failed clone", target)
	}
}

// A parent of the target that is not a folder is refused before any clone starts.
func TestProjectCloneRefusesAParentThatIsNoFolder(t *testing.T) {
	address := bareRepository(t)
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	_, err := (&Host{}).ProjectClone(cloneRequest(t, address, filepath.Join(file, "widget")))
	if err == nil || !strings.Contains(err.Error(), file+" is not a folder") {
		t.Fatalf("ProjectClone error %v, want %s is not a folder", err, file)
	}
}
