package tests

// plugin pack 과 sidecar release(docs/spec/cli.md)가 쓰는 archive 와 SHA256SUMS 를 검사한다.

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeTree 는 경로마다 내용을 쓴다. 이름이 * 로 끝나면 실행 bit 를 붙인다.
func writeTree(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		mode := os.FileMode(0o644)
		if strings.HasSuffix(name, "*") {
			name, mode = strings.TrimSuffix(name, "*"), 0o755
		}
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
}

type tarEntry struct {
	name    string
	mode    int64
	time    int64
	owner   int
	content string
}

func readArchive(t *testing.T, path string) ([]tarEntry, string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	zipped, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(zipped)
	var entries []tarEntry
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, tarEntry{header.Name, header.Mode, header.ModTime.Unix(), header.Uid + header.Gid, string(content)})
	}
	return entries, hex.EncodeToString(sum[:])
}

func pluginTree(t *testing.T) string {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"package.json": `{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"},
			"soksak": {"sidecars": {"@scope/sidecar-worker": "^0.1.0"}}, "files": ["plugin.json", "ui"]}`,
		"plugin.json":   `{"id": "probe", "sidecars": ["@scope/sidecar-worker"]}`,
		"ui/b.js":       "b",
		"ui/a/run.sh*":  "run",
		"test/skip.mjs": "not listed",
	})
	return dir
}

// contract: cli.pack.writes-sorted-plugin-archive
func TestPluginPackWritesASortedArchiveOfTheListedFiles(t *testing.T) {
	dir := pluginTree(t)
	out := filepath.Join(t.TempDir(), "out")
	code, stdout, stderr := run("plugin", "pack", dir, out)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	archive := filepath.Join(out, "probe-0.2.0.tgz")
	entries, sum := readArchive(t, archive)
	want := fmt.Sprintf("{\n  \"archive\": %q,\n  \"id\": \"probe\",\n  \"sha256\": %q,\n  \"version\": \"0.2.0\"\n}\n", archive, sum)
	if stdout != want {
		t.Fatalf("stdout %q, want %q", stdout, want)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, fmt.Sprintf("%s %o %d %d", entry.name, entry.mode, entry.time, entry.owner))
	}
	if got := strings.Join(names, ", "); got != "package.json 644 0 0, plugin.json 644 0 0, ui/a/run.sh 755 0 0, ui/b.js 644 0 0" {
		t.Fatalf("entries %s", got)
	}
	if entries[3].content != "b" {
		t.Fatalf("content %q", entries[3].content)
	}
	// 같은 폴더를 다시 pack 하면 같은 byte 를 쓴다.
	if code, again, _ := run("plugin", "pack", dir, out); code != 0 || again != stdout {
		t.Fatalf("repeat %d %q", code, again)
	}
}

// contract: cli.pack.rejects-links-and-manifest-mismatch
func TestPluginPackRejectsLinksAndAManifestMismatchWithoutWriting(t *testing.T) {
	dir := pluginTree(t)
	if err := os.Symlink("b.js", filepath.Join(dir, "ui", "link.js")); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "out")
	code, _, stderr := run("plugin", "pack", dir, out)
	if code != 1 || stderr != "sok: ui/link.js is a symbolic link; an archive holds no links\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if names, _ := os.ReadDir(out); len(names) != 0 {
		t.Fatalf("a failed pack left %v", names)
	}
	other := pluginTree(t)
	writeTree(t, other, map[string]string{"plugin.json": `{"id": "probe"}`})
	code, _, stderr = run("plugin", "pack", other, out)
	if code != 1 || stderr != "sok: @scope/plugin-probe: plugin.json sidecars [] differ from package.json soksak.sidecars [\"@scope/sidecar-worker\"]\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	writeTree(t, other, map[string]string{"plugin.json": `{"sidecars": ["@scope/sidecar-worker"]}`})
	code, _, stderr = run("plugin", "pack", other, out)
	if code != 1 || stderr != "sok: plugin.json: id must be a lowercase identifier\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

func sidecarTree(t *testing.T, version string) string {
	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"package.json":       `{"name": "@scope/sidecar-worker", "version": "` + version + `", "files": ["sidecar.json", "build/worker"]}`,
		"sidecar.json":       `{"executable": "build/worker", "protocol": 1}`,
		"build/worker*":      "binary " + version,
		"build/intermediate": "not listed",
	})
	return dir
}

// contract: cli.release.writes-asset-and-sums
func TestSidecarReleaseWritesTheAssetAndKeepsSHA256SUMSSorted(t *testing.T) {
	out := t.TempDir()
	var sums []string
	for _, item := range [][2]string{{"0.1.1", "linux-x64"}, {"0.1.0", "darwin-arm64"}, {"0.1.1", "linux-x64"}} {
		code, stdout, stderr := run("sidecar", "release", sidecarTree(t, item[0]), out, "--platform", item[1])
		if code != 0 {
			t.Fatalf("code %d stderr %q", code, stderr)
		}
		var result map[string]string
		if err := json.Unmarshal([]byte(stdout), &result); err != nil {
			t.Fatal(err)
		}
		name := "scope-sidecar-worker-" + item[0] + "-" + item[1] + ".tar.gz"
		entries, sum := readArchive(t, filepath.Join(out, name))
		if result["archive"] != filepath.Join(out, name) || result["sha256"] != sum || result["platform"] != item[1] ||
			result["name"] != "@scope/sidecar-worker" || result["version"] != item[0] {
			t.Fatalf("result %v", result)
		}
		if len(entries) != 3 || entries[0].name != "build/worker" || entries[0].mode != 0o755 || entries[2].name != "sidecar.json" {
			t.Fatalf("entries %v", entries)
		}
		sums = append(sums, sum+"  "+name)
	}
	// 같은 이름의 세 번째 release 는 첫 줄을 바꾸고, 줄은 archive 이름 순서다.
	data, err := os.ReadFile(filepath.Join(out, "SHA256SUMS"))
	if err != nil || string(data) != sums[1]+"\n"+sums[2]+"\n" {
		t.Fatalf("SHA256SUMS %q %v", data, err)
	}
	code, _, stderr := run("sidecar", "release", sidecarTree(t, "0.1.0"), out, "--platform", "solaris-sparc")
	if code != 2 || !strings.HasPrefix(stderr, "sok: --platform: unknown platform solaris-sparc\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	unlisted := sidecarTree(t, "0.1.0")
	writeTree(t, unlisted, map[string]string{"package.json": `{"name": "@scope/sidecar-worker", "version": "0.1.0", "files": ["sidecar.json"]}`})
	code, _, stderr = run("sidecar", "release", unlisted, out, "--platform", "darwin-arm64")
	if code != 1 || stderr != "sok: package.json files: build/worker is not listed\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	writeTree(t, out, map[string]string{"SHA256SUMS": "broken\n"})
	code, _, stderr = run("sidecar", "release", sidecarTree(t, "0.2.0"), out, "--platform", "darwin-arm64")
	if code != 1 || stderr != "sok: "+filepath.Join(out, "SHA256SUMS")+" line 1 is not \"<sha256>  <archive name>\"\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(out, "scope-sidecar-worker-0.2.0-darwin-arm64.tar.gz")); !os.IsNotExist(err) {
		t.Fatalf("a failed release left its archive: %v", err)
	}
}

// contract: cli.pack.diagnostics-only-with-flag
func TestPluginPackAddsDiagnosticDeclarationsOnlyWithTheFlag(t *testing.T) {
	dir := pluginTree(t)
	writeTree(t, dir, map[string]string{
		"diagnostics.json":     `{"module": "probe-diagnostics.js", "exposes": {}}`,
		"probe-diagnostics.js": "export const probe = true;",
	})
	for _, c := range []struct {
		flags []string
		want  string
	}{
		{nil, "package.json, plugin.json, ui/a/run.sh, ui/b.js"},
		{[]string{"--diagnostics"}, "diagnostics.json, package.json, plugin.json, probe-diagnostics.js, ui/a/run.sh, ui/b.js"},
	} {
		out := t.TempDir()
		code, _, stderr := run(append([]string{"plugin", "pack", dir, out}, c.flags...)...)
		if code != 0 {
			t.Fatalf("%v: code %d stderr %q", c.flags, code, stderr)
		}
		entries, _ := readArchive(t, filepath.Join(out, "probe-0.2.0.tgz"))
		var names []string
		for _, entry := range entries {
			names = append(names, entry.name)
		}
		if got := strings.Join(names, ", "); got != c.want {
			t.Fatalf("%v: entries %s", c.flags, got)
		}
	}
	writeTree(t, dir, map[string]string{"package.json": `{"name": "@scope/plugin-probe", "version": "0.2.0", "engines": {"soksak": "^0.0.2"},
		"soksak": {"sidecars": {"@scope/sidecar-worker": "^0.1.0"}}, "files": ["plugin.json", "ui", "probe-diagnostics.js"]}`})
	code, _, stderr := run("plugin", "pack", dir, t.TempDir())
	if code != 1 || stderr != "sok: package.json files: probe-diagnostics.js is diagnostic and must not be listed\n" {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	code, _, stderr = run("sidecar", "release", sidecarTree(t, "0.1.0"), t.TempDir(), "--diagnostics")
	if code != 2 || !strings.HasPrefix(stderr, "sok: --diagnostics belongs to plugin pack\n") {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
}

// contract: cli.pack.rejects-unlisted-modules
func TestPluginPackRejectsAModuleThatFilesDoesNotList(t *testing.T) {
	for _, c := range []struct{ manifest, want string }{
		{`{"id": "probe", "sidecars": ["@scope/sidecar-worker"], "surface": {"module": "page/probe.js"}}`, "plugin.json: surface module page/probe.js must be listed in files"},
		{`{"id": "probe", "sidecars": ["@scope/sidecar-worker"], "sections": [{"id": "probe.list", "module": {"horizontal": "ui/b.js", "vertical": "side/v.js"}}]}`, "plugin.json: section probe.list module side/v.js must be listed in files"},
		{`{"id": "probe", "sidecars": ["@scope/sidecar-worker"], "state": {"module": "state.js"}}`, "plugin.json: state module state.js must be listed in files"},
	} {
		dir := pluginTree(t)
		writeTree(t, dir, map[string]string{"plugin.json": c.manifest})
		code, _, stderr := run("plugin", "pack", dir, t.TempDir())
		if code != 1 || stderr != "sok: "+c.want+"\n" {
			t.Fatalf("code %d stderr %q, want %q", code, stderr, c.want)
		}
	}
	dir := pluginTree(t)
	writeTree(t, dir, map[string]string{"plugin.json": `{"id": "probe", "sidecars": ["@scope/sidecar-worker"], "surface": {"module": "ui/b.js"}, "sections": [{"id": "probe.list", "module": "ui/a/run.sh"}]}`})
	if code, _, stderr := run("plugin", "pack", dir, t.TempDir()); code != 0 {
		t.Fatalf("listed modules: code %d stderr %q", code, stderr)
	}
}
