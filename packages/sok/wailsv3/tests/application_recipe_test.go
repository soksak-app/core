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
	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/linux"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/windows"
)

// The package checks ask the brew of the machine through brew info, which reads its package index and installs nothing.
// contract: application.package.brew-has-declared-kind
func TestAPackageThatBrewHasAsDeclaredIsAccepted(t *testing.T) {
	skipWithoutBrew(t)
	if err := sok.CheckApplicationPackage("brew", "jq", false, os.Getenv("PATH")); err != nil {
		t.Fatal(err)
	}
	if err := sok.CheckApplicationPackage("brew", "iterm2", true, os.Getenv("PATH")); err != nil {
		t.Fatal(err)
	}
}

// contract: application.package.brew-lacks-package
func TestAPackageThatBrewDoesNotHaveIsRefusedWithItsAnswer(t *testing.T) {
	skipWithoutBrew(t)
	err := sok.CheckApplicationPackage("brew", "no-such-cask-soksak", true, os.Getenv("PATH"))
	if err == nil || !strings.Contains(err.Error(), "application package brew info --cask no-such-cask-soksak") ||
		!strings.Contains(err.Error(), "No Cask with this name exists") {
		t.Fatalf("err %v", err)
	}
}

// contract: application.package.other-kind-refused
func TestAPackageOfTheOtherKindIsRefused(t *testing.T) {
	skipWithoutBrew(t)
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

// contract: application.source.clones-and-builds
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

// contract: application.source.failed-command-named
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

// contract: application.package.manager-of-platform
func TestThePackageManagerIsTheOneOfThePlatform(t *testing.T) {
	system, manager := currentPlatform(t).PackageManager()
	other := "winget"
	if manager == "winget" {
		other = "flatpak"
	}
	err := sok.CheckApplicationPackage(other, "x", false, os.Getenv("PATH"))
	want := "application package manager of " + system + " is " + manager + ", not " + other
	if err == nil || err.Error() != want {
		t.Fatalf("err %v, want %q", err, want)
	}
	if manager != "brew" {
		err := sok.CheckApplicationPackage(manager, "x", false, os.Getenv("PATH"))
		if want := "application package manager " + manager + " is not implemented on " + system; err == nil || err.Error() != want {
			t.Fatalf("err %v, want %q", err, want)
		}
	}
}

// skipWithoutBrew skips a brew check where brew is not the package manager of the platform or is not on the search
// path.
func skipWithoutBrew(t *testing.T) {
	t.Helper()
	if system, manager := currentPlatform(t).PackageManager(); manager != "brew" {
		t.Skip("brew is not the package manager of " + system)
	}
	if _, err := exec.LookPath("brew"); err != nil {
		t.Skip("brew is not on the search path")
	}
}

// currentPlatform is the platform of the test run.
func currentPlatform(t *testing.T) platform.Platform {
	t.Helper()
	current, err := platform.Current()
	if err != nil {
		t.Fatal(err)
	}
	return current
}
