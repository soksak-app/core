package host_test

// Replays the role file cases of docs/spec/agent-roles.md#role-file against the Go host: the fingerprint and the layout of each
// case in docs/spec/cases/agent-roles/fingerprint.json, the pinned texts of that file, and the atomic write of the file with its modes.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

const fingerprintCasesPath = "../../../../docs/spec/cases/agent-roles/fingerprint.json"

const rolePathCasesPath = "../../../../docs/spec/cases/agent-roles/role-path.json"

type fingerprintCase struct {
	Name        string   `json:"name"`
	Text        string   `json:"text"`
	Files       []string `json:"files"`
	Fingerprint string   `json:"fingerprint"`
}

type fingerprintCases struct {
	Texts   map[string]string `json:"texts"`
	TextsKo map[string]string `json:"texts_ko"`
	Cases   []fingerprintCase `json:"cases"`
}

func loadFingerprintCases(t *testing.T) fingerprintCases {
	t.Helper()
	data, err := os.ReadFile(fingerprintCasesPath)
	if err != nil {
		t.Fatal(err)
	}
	var cases fingerprintCases
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	return cases
}

// withLineFeed returns text with one line feed at its end when it has none, the layout of a stored definition.
func withLineFeed(text string) string {
	if strings.HasSuffix(text, "\n") {
		return text
	}
	return text + "\n"
}

// contract: roles.fingerprint-shared-cases
func TestRoleFingerprintMatchesSharedCases(t *testing.T) {
	for _, c := range loadFingerprintCases(t).Cases {
		if got := host.RoleFingerprint(c.Name, c.Text, c.Files); got != c.Fingerprint {
			t.Fatalf("fingerprint of %s is %q, want %q", c.Name, got, c.Fingerprint)
		}
	}
}

// filesLines returns the files block that the role file holds under the heading: the heading, then one line `- <path>` per file, or an
// empty text when the list is empty.
func filesLines(heading string, files []string) string {
	if len(files) == 0 {
		return ""
	}
	block := heading + "\n"
	for _, file := range files {
		block += "- " + file + "\n"
	}
	return block
}

// contract: roles.role-file-layout
func TestRoleFileHasFirstLineDefinitionAndFingerprint(t *testing.T) {
	first := loadFingerprintCases(t).Texts["role_file_first_line"]
	for _, c := range loadFingerprintCases(t).Cases {
		want := first + "\n" + withLineFeed(c.Text) + filesLines(loadFingerprintCases(t).Texts["files_heading"], c.Files) + c.Fingerprint + "\n"
		if got := host.RoleFileContent(c.Name, c.Text, c.Files); got != want {
			t.Fatalf("layout of %s is %q, want %q", c.Name, got, want)
		}
	}
	// A stored definition without a final line feed gets one in the file; its fingerprint uses the stored text.
	got := host.RoleFileContent("ops-1", "Line one.", nil)
	if want := first + "\nLine one.\n" + host.RoleFingerprint("ops-1", "Line one.", nil) + "\n"; got != want {
		t.Fatalf("layout without a final line feed is %q, want %q", got, want)
	}
	// A definition of 5,000 characters is written whole and its fingerprint covers all of it.
	long := strings.Repeat("Check the tests and the contract. ", 150)[:5000]
	got = host.RoleFileContent("long-role", long, nil)
	if !strings.Contains(got, "\n"+long+"\n") || !strings.HasSuffix(got, host.RoleFingerprint("long-role", long, nil)+"\n") {
		t.Fatal("a definition of 5,000 characters is not written whole with its fingerprint")
	}
}

// contract: roles.role-file-phrases
func TestRoleTextsMatchPinnedTexts(t *testing.T) {
	roleFile := filepath.Join(t.TempDir(), "agents", "tab-1", "role.md")
	texts := host.RoleTexts(roleFile)
	pinned := loadFingerprintCases(t).Texts
	want := map[string]string{}
	for name, text := range pinned {
		if name == "role_file_first_line" {
			want[name] = text
			continue
		}
		want[name] = strings.ReplaceAll(text, "<role file>", roleFile)
	}
	if !reflect.DeepEqual(texts, want) {
		t.Fatalf("texts are %v, want %v", texts, want)
	}
}

// contract: roles.role-file-write
func TestWriteRoleFileWritesLayoutAtomicallyWithModes(t *testing.T) {
	config := t.TempDir()
	path, err := host.WriteRoleFile(config, "tab-1", "reviewer", "You review.\n", "검토한다.\n", nil)
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(config, "agents", "tab-1", "role.md"); path != want {
		t.Fatalf("path is %q, want %q", path, want)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := host.RoleFileContent("reviewer", "You review.\n", nil); string(data) != want {
		t.Fatalf("file is %q, want %q", data, want)
	}
	assertMode(t, path, 0o600)
	assertMode(t, filepath.Dir(path), 0o700)
	if _, err := host.WriteRoleFile(config, "tab-1", "reviewer", "You review the tests.\n", "검토한다.\n", nil); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(path)
	if want := host.RoleFileContent("reviewer", "You review the tests.\n", nil); string(data) != want {
		t.Fatalf("the second write left %q, want %q", data, want)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".role-*.tmp")); len(leftovers) != 0 {
		t.Fatalf("a write left temporary files %v", leftovers)
	}
}

// contract: roles.role-ko-file
func TestWriteRoleFileWritesKoreanFileBesideRoleFile(t *testing.T) {
	config := t.TempDir()
	first := loadFingerprintCases(t).TextsKo["role_file_first_line"]
	if first == "" {
		t.Fatal("the case file pins no Korean first line in texts_ko")
	}
	path, err := host.WriteRoleFile(config, "tab-1", "reviewer", "You review.\n", "검토한다.", nil)
	if err != nil {
		t.Fatal(err)
	}
	korean := filepath.Join(filepath.Dir(path), "role.ko.md")
	data, err := os.ReadFile(korean)
	if err != nil {
		t.Fatal(err)
	}
	// The Korean file carries the fingerprint of role.md, computed over the English text.
	if want := first + "\n검토한다.\n" + host.RoleFingerprint("reviewer", "You review.\n", nil) + "\n"; string(data) != want {
		t.Fatalf("Korean file is %q, want %q", data, want)
	}
	assertMode(t, korean, 0o600)
	if _, err := host.WriteRoleFile(config, "tab-1", "reviewer", "You review the tests.\n", "test를 검토한다.\n", nil); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(korean)
	if want := first + "\ntest를 검토한다.\n" + host.RoleFingerprint("reviewer", "You review the tests.\n", nil) + "\n"; string(data) != want {
		t.Fatalf("the second write left the Korean file %q, want %q", data, want)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".role-*.tmp")); len(leftovers) != 0 {
		t.Fatalf("a write left temporary files %v", leftovers)
	}
}

// contract: roles.role-file-removes-leftovers
func TestWriteRoleFileRemovesLeftoverTemporaryFiles(t *testing.T) {
	config := t.TempDir()
	folder := filepath.Join(config, "agents", "tab-1")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatal(err)
	}
	leftover := filepath.Join(folder, ".role-crash.tmp")
	if err := os.WriteFile(leftover, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := host.WriteRoleFile(config, "tab-1", "reviewer", "You review.\n", "검토한다.\n", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(leftover); !os.IsNotExist(err) {
		t.Fatalf("a leftover temporary file remains: %v", err)
	}
}

// contract: roles.role-file-refuses-surface
func TestWriteRoleFileRefusesSurfaceWithPathParts(t *testing.T) {
	config := t.TempDir()
	for _, surface := range []string{"", "..", "a/b", "../x", "a\x01b", "a\tb"} {
		if _, err := host.WriteRoleFile(config, surface, "reviewer", "You review.\n", "검토한다.\n", nil); err == nil {
			t.Fatalf("surface %q was accepted", surface)
		}
	}
	if entries, _ := os.ReadDir(config); len(entries) != 0 {
		t.Fatalf("a refused surface created %v", entries)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s has mode %o, want %o", path, got, want)
	}
}

// TestRolePathMatchesSharedCases checks that the role file path that WriteRoleFile returns is the path of each case of
// docs/spec/cases/agent-roles/role-path.json, which the status core.tab.role carries as path.
// contract: roles.role-path-shared-cases
func TestRolePathMatchesSharedCases(t *testing.T) {
	text, err := os.ReadFile(rolePathCasesPath)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []struct {
			Name    string `json:"name"`
			Surface string `json:"surface"`
			Path    string `json:"path"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(text, &file); err != nil {
		t.Fatal(err)
	}
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			config := t.TempDir()
			path, err := host.WriteRoleFile(config, kase.Surface, "reviewer", "Review the changes.", "검토한다.\n", nil)
			if err != nil {
				t.Fatal(err)
			}
			if want := filepath.Join(config, filepath.FromSlash(kase.Path)); path != want {
				t.Fatalf("WriteRoleFile returned %q, want %q", path, want)
			}
		})
	}
}

// contract: roles.fingerprint-shared-cases
func TestRoleFingerprintEscapesQuoteAndBackslashInFileList(t *testing.T) {
	// The file list is the compact JSON array `["/a\"b\\c"]`: the quote and the backslash are escaped, the other characters are not.
	sum := sha256.Sum256([]byte("reviewer\nYou review.\n" + `["/a\"b\\c"]`))
	want := hex.EncodeToString(sum[:])[:16]
	if got := host.RoleFingerprint("reviewer", "You review.", []string{`/a"b\c`}); got != want {
		t.Fatalf("fingerprint is %q, want %q", got, want)
	}
}

// contract: roles.role-ko-file
func TestWriteRoleFileKoreanFileListsFilesUnderKoreanHeading(t *testing.T) {
	config := t.TempDir()
	files := []string{"/a/b.md", "/c d/e.md"}
	path, err := host.WriteRoleFile(config, "tab-1", "reviewer", "You review.\n", "검토한다.", files)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(path), "role.ko.md"))
	if err != nil {
		t.Fatal(err)
	}
	pinned := loadFingerprintCases(t).TextsKo
	want := pinned["role_file_first_line"] + "\n검토한다.\n" + pinned["files_heading"] + "\n- /a/b.md\n- /c d/e.md\n" +
		host.RoleFingerprint("reviewer", "You review.\n", files) + "\n"
	if string(data) != want {
		t.Fatalf("Korean file is %q, want %q", data, want)
	}
}
