package files_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func gitRequest(t *testing.T, root string) string {
	t.Helper()
	line, err := json.Marshal(map[string]any{"surface": "state:files:p1", "root": root, "body": map[string]any{"operation": "git", "id": "g"}})
	if err != nil {
		t.Fatal(err)
	}
	return string(line)
}

func TestGitReportsStatusesRelativeToTheRootAndLeavesOutOtherDirectories(t *testing.T) {
	repo := t.TempDir()
	run(t, repo, "init", "-q")
	write(t, filepath.Join(repo, "outside.txt"), "a")
	write(t, filepath.Join(repo, "project", "kept.txt"), "a")
	write(t, filepath.Join(repo, "project", "gone.txt"), "text that leaves the project")
	write(t, filepath.Join(repo, "project", "old.txt"), "a")
	run(t, repo, "add", ".")
	run(t, repo, "commit", "-q", "-m", "base")
	write(t, filepath.Join(repo, "outside.txt"), "b")
	write(t, filepath.Join(repo, "project", "kept.txt"), "b")
	write(t, filepath.Join(repo, "project", "new", "file.txt"), "a")
	write(t, filepath.Join(repo, "project", "staged.txt"), "a new file with its own text")
	run(t, repo, "add", "project/staged.txt")
	run(t, repo, "rm", "-q", "project/gone.txt")
	run(t, repo, "mv", "project/old.txt", "project/moved.txt")
	events := serve(t, gitRequest(t, filepath.Join(repo, "project")))
	got, _ := json.Marshal(events[0].Body)
	want := `{"id":"g","entries":[{"path":"gone.txt","status":"deleted"},{"path":"kept.txt","status":"modified"},{"path":"moved.txt","status":"renamed"},{"path":"new/file.txt","status":"untracked"},{"path":"staged.txt","status":"added"}]}`
	if string(got) != want {
		t.Fatalf("git = %s\nwant %s", got, want)
	}
}

func TestGitOutsideARepositoryReportsNoEntries(t *testing.T) {
	root := t.TempDir()
	events := serve(t, gitRequest(t, root))
	if got, _ := json.Marshal(events[0].Body); string(got) != `{"id":"g","entries":[]}` {
		t.Fatalf("git = %s", got)
	}
}
