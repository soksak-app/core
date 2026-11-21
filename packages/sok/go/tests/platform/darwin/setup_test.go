//go:build darwin

// Package darwin checks the setup operations of sok that macOS decides (docs/spec/cli.md#mcp-registration,
// docs/spec/cli.md#setup-parts): the registered sok must be the sok of an application bundle, a sok on a read-only volume is
// refused, and an install needs no administrator rights.
package darwin

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

// builtSok builds the sok executable of this package into a folder of the test with the build tags of the test. The build cache
// of go makes each later build quick.
func builtSok(t *testing.T) string {
	t.Helper()
	program := filepath.Join(t.TempDir(), "sok")
	build, err := support.SokBuild("go", program)
	if err != nil {
		t.Fatal(err)
	}
	output, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("go build: %v\n%s", err, output)
	}
	return program
}

// repositoryFile returns a file of the repository that holds this package, found by walking up from this source file.
func repositoryFile(t *testing.T, relative string) string {
	t.Helper()
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("the source file of the test is unknown")
	}
	for dir := filepath.Dir(here); ; {
		if _, err := os.Stat(filepath.Join(dir, relative)); err == nil {
			return filepath.Join(dir, relative)
		}
		if filepath.Dir(dir) == dir {
			t.Fatalf("no folder above %s holds %s", here, relative)
		}
		dir = filepath.Dir(dir)
	}
}

// copyExecutable copies the file to the path with mode 0755 and returns the canonical path of the copy.
func copyExecutable(t *testing.T, source, path string) string {
	t.Helper()
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o755); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return canonical
}

// home is a disposable home with the fixture program of the external commands under the given names in one folder.
type home struct {
	dir, fixtures, log string
}

func newHome(t *testing.T, names ...string) home {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fixtures := t.TempDir()
	for _, name := range names {
		copyExecutable(t, repositoryFile(t, "docs/spec/cases/setup/fixture.sh"), filepath.Join(fixtures, name))
	}
	return home{dir: dir, fixtures: fixtures, log: filepath.Join(t.TempDir(), "commands.log")}
}

func (h home) commands(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(h.log)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return string(data)
}

// run runs the sok with HOME, PATH and the fixture log of the home and standard input from /dev/null.
func (h home) run(t *testing.T, sok string, path []string, args ...string) (int, string, string) {
	t.Helper()
	cmd := exec.Command(sok, args...)
	cmd.Env = []string{"HOME=" + h.dir, "PATH=" + strings.Join(path, ":"), "SETUP_FIXTURE_LOG=" + h.log}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.ExitCode(), stdout.String(), stderr.String()
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0, stdout.String(), stderr.String()
}

type part struct {
	Part   string `json:"part"`
	File   string `json:"file"`
	State  string `json:"state"`
	Reason string `json:"reason"`
	Error  string `json:"error"`
}

func parts(t *testing.T, stdout string) []part {
	t.Helper()
	var out struct {
		Parts []part `json:"parts"`
	}
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatalf("setup printed %q: %v", stdout, err)
	}
	return out.Parts
}

// contract: cli.mcp.install-requires-a-bundle-sok
func TestMcpInstallRequiresABundleSok(t *testing.T) {
	program := builtSok(t)
	h := newHome(t, "claude")
	bundle := copyExecutable(t, program, filepath.Join(t.TempDir(), "Mine.app", "Contents", "MacOS", "sok"))
	plain := copyExecutable(t, program, filepath.Join(t.TempDir(), "bin", "sok"))
	path := []string{filepath.Dir(bundle), h.fixtures}
	want := "the running sok, " + plain + ", is not the sok of an application bundle"
	code, stdout, stderr := h.run(t, plain, path, "mcp", "install")
	if code != 1 || stdout != "" || stderr != "sok: "+want+"\n" || h.commands(t) != "" {
		t.Fatalf("code %d stdout %q stderr %q commands %q", code, stdout, stderr, h.commands(t))
	}
	_, stdout, _ = h.run(t, plain, path, "setup", "check")
	list := parts(t, stdout)
	if mcp := list[len(list)-1]; mcp.Part != "mcp" || mcp.State != "error" || mcp.Error != want {
		t.Fatalf("parts %s", stdout)
	}
}

// The judgement with which sok mcp install refuses the registered sok: the sealed
// system volume of macOS, which statfs reports read-only, is refused, and the volume of the temporary folder of the test is
// accepted.
// contract: cli.setup.refuses-a-read-only-volume
func TestSetupRefusesASokOnAReadOnlyVolume(t *testing.T) {
	want := "/usr/bin/true is on a read-only volume; move the application to a folder such as /Applications and start it again"
	if err := sok.RequireWritableVolume("/usr/bin/true"); err == nil || err.Error() != want {
		t.Fatalf("read-only volume: %v", err)
	}
	writable := filepath.Join(t.TempDir(), "sok")
	if err := os.WriteFile(writable, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := sok.RequireWritableVolume(writable); err != nil {
		t.Fatalf("writable volume: %v", err)
	}
}

// contract: cli.no-administrator-rights
func TestSetupInstallRunsNoSudo(t *testing.T) {
	program := builtSok(t)
	h := newHome(t, "claude", "sudo")
	if err := os.MkdirAll(filepath.Join(h.dir, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	running := copyExecutable(t, program, filepath.Join(t.TempDir(), "Mine.app", "Contents", "MacOS", "sok"))
	code, stdout, stderr := h.run(t, running, []string{h.fixtures, filepath.Dir(running)}, "setup", "install")
	list := parts(t, stdout)
	if code != 0 || stderr != "" || len(list) != 3 || list[0].Part != "skill" || list[1].Part != "mcp" || list[2].Part != "hook" {
		t.Fatalf("code %d stdout %s stderr %q", code, stdout, stderr)
	}
	for _, part := range list {
		if part.State != "ok" {
			t.Fatalf("part %+v", part)
		}
	}
	if commands := h.commands(t); strings.Contains(commands, "sudo") || !strings.Contains(commands, "claude mcp add --scope user soksak -- "+running+" mcp") {
		t.Fatalf("commands %q", commands)
	}
}
