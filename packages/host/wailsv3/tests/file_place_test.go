// The save place of a new document (docs/spec/plugins.md#pluginjson): the chosen file is answered relative to the project
// root, and a place outside the root or a name that is not a file name is refused.
package host_test

import (
	"os"
	"path/filepath"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: files.place.answers-the-path-inside-the-project
func TestAPlaceInsideTheProjectIsAnsweredRelativeToTheRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "project")
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ root, chosen, want string }{
		{root, filepath.Join(root, "plan.hwp"), "plan.hwp"},
		{root, filepath.Join(root, "docs", "plan.hwp"), "docs/plan.hwp"},
		{link, filepath.Join(root, "docs", "plan.hwp"), "docs/plan.hwp"},
		{root, filepath.Join(link, "docs", "plan.hwp"), "docs/plan.hwp"},
	} {
		got, err := host.FilePlaceRelative(c.root, c.chosen)
		if err != nil || got != c.want {
			t.Fatalf("FilePlaceRelative(%q, %q) = %q, %v; want %q", c.root, c.chosen, got, err, c.want)
		}
	}
}

// contract: files.place.refuses-a-place-outside-the-project
func TestAPlaceOutsideTheProjectIsRefused(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "project")
	other := filepath.Join(base, "other")
	for _, dir := range []string{root, other} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	escape := filepath.Join(root, "escape")
	if err := os.Symlink(other, escape); err != nil {
		t.Fatal(err)
	}
	for _, chosen := range []string{filepath.Join(other, "plan.hwp"), root, filepath.Join(root, "..", "other", "plan.hwp"), filepath.Join(escape, "plan.hwp")} {
		_, err := host.FilePlaceRelative(root, chosen)
		want := "file place: " + chosen + " is outside the project " + root
		if err == nil || err.Error() != want {
			t.Fatalf("FilePlaceRelative(%q, %q) error %v; want %q", root, chosen, err, want)
		}
	}
}

// contract: files.place.refuses-a-name-that-is-not-a-file-name
func TestAPlaceNameThatIsNotAFileNameIsRefused(t *testing.T) {
	for _, name := range []string{"", ".", "..", "a/b", `a\b`} {
		err := host.FilePlaceName(name)
		want := "file place: name " + name + " is not a file name"
		if err == nil || err.Error() != want {
			t.Fatalf("FilePlaceName(%q) error %v; want %q", name, err, want)
		}
	}
	if err := host.FilePlaceName("plan.hwp"); err != nil {
		t.Fatalf("FilePlaceName(plan.hwp) = %v", err)
	}
}
