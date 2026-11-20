package tests

// Shared helpers of the tests of the agent commands (docs/spec/cli.md#agents): a disposable home, the fixture program of the
// external commands (docs/spec/cases/setup/fixture.sh), folders of application bundles that hold a sok, and the sok executable
// that the tests build once.

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

// configDirVariable is the agent variable of a soksak window (docs/spec/cli.md#the-window-of-an-agent). TestMain removes it, so a
// test run inside a soksak window never reaches the application of that window, and each test that needs it sets it.
const configDirVariable = "SOKSAK_CONFIG_DIR"

// builtSokDir holds the sok executable that builtSok builds once for the test process; TestMain removes it.
var (
	builtSokDir  string
	builtSokOnce sync.Once
	builtSokErr  error
	// startEnvironment is the environment of the test process at its start, which the build of sok uses whatever HOME and PATH a
	// test set.
	startEnvironment []string
	// goTool is the go command on PATH of the test process at its start, and goToolErr the failure to find it.
	goTool    string
	goToolErr error
)

func TestMain(m *testing.M) {
	os.Unsetenv(configDirVariable)
	startEnvironment = os.Environ()
	goTool, goToolErr = exec.LookPath("go")
	code := m.Run()
	if builtSokDir != "" {
		os.RemoveAll(builtSokDir)
	}
	os.Exit(code)
}

// builtSok returns the sok executable of this package, built once for the test process with the build tags of the test.
func builtSok(t *testing.T) string {
	t.Helper()
	builtSokOnce.Do(func() {
		if goToolErr != nil {
			builtSokErr = goToolErr
			return
		}
		builtSokDir, builtSokErr = os.MkdirTemp("", "sok-build")
		if builtSokErr != nil {
			return
		}
		build, err := support.SokBuild(goTool, filepath.Join(builtSokDir, "sok"))
		if err != nil {
			builtSokErr = err
			return
		}
		build.Env = startEnvironment
		output, err := build.CombinedOutput()
		if err != nil {
			builtSokErr = &buildError{err: err, output: string(output)}
		}
	})
	if builtSokErr != nil {
		t.Fatal(builtSokErr)
	}
	return filepath.Join(builtSokDir, "sok")
}

type buildError struct {
	err    error
	output string
}

func (e *buildError) Error() string { return "go build: " + e.err.Error() + "\n" + e.output }

// repositoryFile returns a file of the repository that holds this package, found by walking up from this source file.
func repositoryFile(t *testing.T, relative string) string {
	t.Helper()
	_, here, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("the source file of the agent helpers is unknown")
	}
	for dir := filepath.Dir(here); ; {
		candidate := filepath.Join(dir, relative)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("no folder above %s holds %s", here, relative)
		}
		dir = parent
	}
}

// copyExecutable copies the file to the path with mode 0755 and creates its folder.
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

// setupFixture copies the fixture program of the external commands into a new folder under each name and returns the folder.
func setupFixture(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	source := repositoryFile(t, "docs/spec/cases/setup/fixture.sh")
	for _, name := range names {
		copyExecutable(t, source, filepath.Join(dir, name))
	}
	return dir
}

// bundleSok places a copy of the source as the sok of an application bundle <root>/<name>.app/Contents/MacOS/sok and returns
// the canonical path of the copy.
func bundleSok(t *testing.T, source, name string) string {
	t.Helper()
	return copyExecutable(t, source, filepath.Join(t.TempDir(), name+".app", "Contents", "MacOS", "sok"))
}

// agentHome is a disposable home: HOME names it, CLAUDE_CONFIG_DIR is removed and the fixture log is a file in another folder.
type agentHome struct {
	home string
	log  string
}

func newAgentHome(t *testing.T) agentHome {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	unsetenv(t, "CLAUDE_CONFIG_DIR")
	log := filepath.Join(t.TempDir(), "commands.log")
	t.Setenv("SETUP_FIXTURE_LOG", log)
	unsetenv(t, "SETUP_FIXTURE_FAIL")
	unsetenv(t, "SETUP_FIXTURE_SKIP_WRITE")
	return agentHome{home: home, log: log}
}

// commands are the lines of the fixture log: the external commands that ran.
func (h agentHome) commands(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile(h.log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
}

// unsetenv removes the variable for the test and restores it afterwards.
func unsetenv(t *testing.T, name string) {
	t.Helper()
	t.Setenv(name, "")
	os.Unsetenv(name)
}

// mkdirs creates each folder.
func mkdirs(t *testing.T, dirs ...string) {
	t.Helper()
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

// writeText writes the file and creates its folder.
func writeText(t *testing.T, path, text string) {
	t.Helper()
	mkdirs(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// fileText reads the file, or "" when it does not exist.
func fileText(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// runProgram runs the executable with the environment and an empty standard input and returns its exit status and output.
func runProgram(t *testing.T, program string, env []string, args ...string) (int, string, string) {
	t.Helper()
	cmd := exec.Command(program, args...)
	cmd.Env = env
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

// environment is the environment of a child sok: HOME, PATH and the fixture variables of the test, and no agent variables.
func environment(extra ...string) []string {
	env := []string{"HOME=" + os.Getenv("HOME"), "PATH=" + os.Getenv("PATH"), "SETUP_FIXTURE_LOG=" + os.Getenv("SETUP_FIXTURE_LOG")}
	if value, ok := os.LookupEnv("CLAUDE_CONFIG_DIR"); ok {
		env = append(env, "CLAUDE_CONFIG_DIR="+value)
	}
	return append(env, extra...)
}

// testExecutable is the canonical path of the running test binary, the <sok> of an in-process run.
func testExecutable(t *testing.T) string {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		t.Fatal(err)
	}
	return executable
}
