package tests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// contract: cli.setup.user-path-registration
func TestUserPathRegistrationInstallsOnceAndStaysDisabled(t *testing.T) {
	home := newAgentHome(t).home
	profile := filepath.Join(home, ".zshrc")
	preexisting := "export EDITOR=vi\n"
	writeText(t, profile, preexisting)
	executable := copyExecutable(t, repositoryFile(t, "docs/spec/cases/setup/fixture.sh"),
		filepath.Join(home, "Applications", "soksak.app", "Contents", "MacOS", "sok"))
	paths := "/usr/bin"
	environment := sok.AgentEnvironment{Home: &home, Path: &paths}
	link := filepath.Join(home, ".local", "bin", "sok")
	record := filepath.Join(home, "Library", "Application Support", "app.soksak", "agent-setup.json")

	if part, err := sok.UserPathState(environment); err != nil || part.Enabled == nil || !*part.Enabled || part.State != "missing" || part.Step != "" {
		t.Fatalf("state before registration: %+v, %v", part, err)
	}
	if _, err := os.Stat(record); !os.IsNotExist(err) {
		t.Fatalf("reading state created a record: %v", err)
	}
	if changed, err := sok.ConfigureUserPath(environment, "/bin/zsh", executable, nil); err != nil || !changed {
		t.Fatalf("initial registration: changed=%v, %v", changed, err)
	}
	if target, err := filepath.EvalSymlinks(link); err != nil || target != executable {
		t.Fatalf("registered executable: %q, %v", target, err)
	}
	if content := fileText(t, profile); !strings.HasPrefix(content, preexisting) || strings.Count(content, "# >>> soksak PATH >>>") != 1 {
		t.Fatalf("startup profile: %q", content)
	}
	info, err := os.Stat(record)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("record mode: %o", got)
	}

	paths += string(os.PathListSeparator) + filepath.Dir(link)
	if part, err := sok.UserPathState(environment); err != nil || part.Enabled == nil || !*part.Enabled || part.State != "ok" {
		t.Fatalf("state after registration: %+v, %v", part, err)
	}
	if changed, err := sok.ConfigureUserPath(environment, "/bin/zsh", executable, nil); err != nil || changed {
		t.Fatalf("repeated registration: changed=%v, %v", changed, err)
	}
	afterRepeat, err := os.Stat(record)
	if err != nil || !os.SameFile(info, afterRepeat) {
		t.Fatalf("repeated registration replaced its record: %v", err)
	}
	// The current shell still sees its startup block even if the public link is missing.
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if changed, err := sok.ConfigureUserPath(environment, "/bin/zsh", executable, nil); err != nil || !changed {
		t.Fatalf("repair registration: changed=%v, %v", changed, err)
	}
	if content := fileText(t, profile); strings.Count(content, "# >>> soksak PATH >>>") != 1 {
		t.Fatalf("repair removed the startup block: %q", content)
	}

	enabled := false
	if changed, err := sok.ConfigureUserPath(environment, "/bin/zsh", executable, &enabled); err != nil || !changed {
		t.Fatalf("disable registration: changed=%v, %v", changed, err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("public link remains: %v", err)
	}
	if content := fileText(t, profile); content != preexisting {
		t.Fatalf("profile after disable: %q", content)
	}
	if changed, err := sok.ConfigureUserPath(environment, "/bin/zsh", executable, nil); err != nil || changed {
		t.Fatalf("disabled startup: changed=%v, %v", changed, err)
	}
	if part, err := sok.UserPathState(environment); err != nil || part.Enabled == nil || *part.Enabled || part.State != "ok" {
		t.Fatalf("disabled state: %+v, %v", part, err)
	}
}

// contract: cli.setup.user-path-registration
func TestUserPathRegistrationPreservesAnotherBundleAndReportsAConflict(t *testing.T) {
	home := newAgentHome(t).home
	fixture := repositoryFile(t, "docs/spec/cases/setup/fixture.sh")
	executable := copyExecutable(t, fixture, filepath.Join(home, "Applications", "first.app", "Contents", "MacOS", "sok"))
	other := copyExecutable(t, fixture, filepath.Join(home, "Applications", "second.app", "Contents", "MacOS", "sok"))
	paths := filepath.Dir(other)
	environment := sok.AgentEnvironment{Home: &home, Path: &paths}
	if changed, err := sok.ConfigureUserPath(environment, "/bin/zsh", executable, nil); err != nil || changed {
		t.Fatalf("existing bundle registration: changed=%v, %v", changed, err)
	}
	link := filepath.Join(home, ".local", "bin", "sok")
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("a local link was created: %v", err)
	}
	writeText(t, link, "mine\n")
	paths = "/usr/bin"
	if _, err := sok.ConfigureUserPath(environment, "/bin/zsh", executable, nil); err == nil || !strings.Contains(err.Error(), link) {
		t.Fatalf("conflicting public file: %v", err)
	}
	if content := fileText(t, link); content != "mine\n" {
		t.Fatalf("conflicting public file changed: %q", content)
	}
}
