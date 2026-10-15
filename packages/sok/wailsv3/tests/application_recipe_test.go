package tests

// Checks the package and source recipes of an application (docs/spec/installation.md#applications): the brew of the
// machine answers whether it has a package as the recipe declares it, and a source recipe clones a repository with the git
// of the machine at a ref into the folder of the application and runs its build commands there; a failed step names
// itself with its output. The source checks point the https address of the recipe at a repository of the check with the
// git setting url.<base>.insteadOf, so the clone runs as for a remote address but reads no network. Installing a package
// changes the machine, so that step runs only in the installation check of a connector plugin (F194.5.8).

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// The package checks ask the brew of the machine through brew info, which reads its package index and installs nothing.
func TestAPackageThatBrewHasAsDeclaredIsAccepted(t *testing.T) {
	if err := sok.CheckApplicationPackage("brew", "jq", false, os.Getenv("PATH")); err != nil {
		t.Fatal(err)
	}
	if err := sok.CheckApplicationPackage("brew", "iterm2", true, os.Getenv("PATH")); err != nil {
		t.Fatal(err)
	}
}

func TestAPackageThatBrewDoesNotHaveIsRefusedWithItsAnswer(t *testing.T) {
	err := sok.CheckApplicationPackage("brew", "no-such-cask-soksak", true, os.Getenv("PATH"))
	if err == nil || !strings.Contains(err.Error(), "application package brew info --cask no-such-cask-soksak") ||
		!strings.Contains(err.Error(), "No Cask with this name exists") {
		t.Fatalf("err %v", err)
	}
}

func TestAPackageOfTheOtherKindIsRefused(t *testing.T) {
	if err := sok.CheckApplicationPackage("brew", "iterm2", false, os.Getenv("PATH")); err == nil {
		t.Fatal("a cask declared as a formula was accepted")
	}
}

// localRepository makes a git repository with a build script at a tag and points https://example.test/sketcher.git at it
// through url.<base>.insteadOf in the environment entries that the installation passes to git, so the clone takes the
// https address of the recipe.
func localRepository(t *testing.T) []string {
	t.Helper()
	repository := t.TempDir()
	run := func(arguments ...string) {
		command := exec.Command("git", arguments...)
		command.Dir = repository
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", arguments, err, output)
		}
	}
	run("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(repository, "build.sh"), []byte("#!/bin/sh\nmkdir -p bin && printf '#!/bin/sh\\n' > bin/sketcher && chmod +x bin/sketcher\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	run("add", "build.sh")
	run("-c", "user.name=check", "-c", "user.email=check@example.test", "commit", "-q", "-m", "build")
	run("tag", "v1.0.0")
	return []string{"GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=url." + repository + ".insteadOf", "GIT_CONFIG_VALUE_0=https://example.test/sketcher.git"}
}

func TestASourceIsClonedAtItsRefAndBuiltInTheFolderOfTheApplication(t *testing.T) {
	settings := localRepository(t)
	target := filepath.Join(t.TempDir(), "applications", "sketcher", "1.0.0")
	err := sok.InstallApplicationSource("https://example.test/sketcher.git", "v1.0.0", [][]string{{"sh", "build.sh"}}, target, os.Getenv("PATH"), settings)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(target, "bin", "sketcher"))
	if err != nil || info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("the built executable: %v %v", info, err)
	}
}

func TestAFailedBuildCommandNamesItselfWithItsOutputAndLeavesNoFolder(t *testing.T) {
	settings := localRepository(t)
	root := t.TempDir()
	target := filepath.Join(root, "sketcher")
	err := sok.InstallApplicationSource("https://example.test/sketcher.git", "v1.0.0", [][]string{{"sh", "-c", "echo broken build >&2; exit 3"}}, target, os.Getenv("PATH"), settings)
	if err == nil || !strings.Contains(err.Error(), "application source command sh -c") || !strings.Contains(err.Error(), "broken build") {
		t.Fatalf("err %v", err)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Fatalf("the failed installation left %v", entries)
	}
}
