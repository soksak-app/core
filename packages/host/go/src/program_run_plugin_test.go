package host

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// writeProgramFile writes a file of the plugin folder with the mode, creating its folders.
func writeProgramFile(t *testing.T, folder, name, content string, mode os.FileMode) {
	t.Helper()
	path := filepath.Join(folder, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

// contract: program.run.plugin-path-runs-installed-file
func TestProgramRunPluginPathRunsTheInstalledFile(t *testing.T) {
	folder := t.TempDir()
	writeProgramFile(t, folder, "bin/tool", "#!/bin/sh\necho \"$1\"\n", 0o755)
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "plugin:bin/tool", Args: []string{"$HOME"},
		Directory: t.TempDir(), Environment: programRunEnvironment, PluginFolder: folder,
	})
	if outcome.Result != "exited" || outcome.Stdout != "$HOME\n" {
		t.Fatalf("result %q stdout %q: the program of the plugin folder did not run with its argument", outcome.Result, outcome.Stdout)
	}
}

// contract: program.run.plugin-path-not-found
func TestProgramRunPluginPathNotFoundFailsTheRun(t *testing.T) {
	project := t.TempDir()
	writeProgramFile(t, project, "bin/tool", "#!/bin/sh\necho ran\n", 0o755)
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: "plugin:bin/tool", Directory: project, Environment: programRunEnvironment, PluginFolder: t.TempDir(),
	})
	if err == nil || err.Error() != "program not found: plugin:bin/tool" {
		t.Fatalf("error %v, want program not found: the file of the project folder must not be run", err)
	}
}

// contract: program.run.plugin-path-not-executable
func TestProgramRunPluginPathNotExecutableFailsTheRun(t *testing.T) {
	folder := t.TempDir()
	writeProgramFile(t, folder, "bin/tool", "#!/bin/sh\n", 0o644)
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: "plugin:bin/tool", Directory: t.TempDir(), Environment: programRunEnvironment, PluginFolder: folder,
	})
	if err == nil || err.Error() != "program plugin:bin/tool is not a regular executable file" {
		t.Fatalf("error %v, want the executable refusal", err)
	}
}

// contract: program.run.plugin-path-refuses-invalid-path
func TestProgramDeclarationRefusesAnInvalidPluginPath(t *testing.T) {
	want := "programs.lint program plugin path must be a relative path of / separated segments that are not empty, . or .., without a backslash"
	for _, program := range []string{"plugin:../tool", "plugin:/tool", "plugin:", "plugin:bin//tool"} {
		input, err := json.Marshal(map[string]any{"lint": map[string]any{"program": program}})
		if err != nil {
			t.Fatal(err)
		}
		_, err = parseProgramDeclarations(json.RawMessage(input))
		if err == nil || err.Error() != want {
			t.Fatalf("%s: error %v, want %q", program, err, want)
		}
	}
}
