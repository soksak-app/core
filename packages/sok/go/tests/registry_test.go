package tests

// Checks that registry build (docs/spec/cli.md) checks the registry folder and writes index.json.

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/go/src"
	"github.com/soksak-app/core/packages/sok/go/tests/support"
)

// registryTree makes a release from a pack and a release, and writes a registry folder that holds its address and hash.
func registryTree(t *testing.T) (dir, pluginSum, sidecarSum string) {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	releases := t.TempDir()
	results := map[string]map[string]string{"plugin": support.PackRelease(t, pluginTree(t), releases)}
	results["sidecar"] = support.PackRelease(t, sidecarTree(t, "0.1.0"), releases)
	dir = t.TempDir()
	writeTree(t, dir, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [{"version": "0.2.0",
			"release": {"url": "file://` + results["plugin"]["release"] + `", "sha256": "` + results["plugin"]["sha256"] + `"},
			"engines": {"soksak": "^0.0.2"}, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}}]}`,
		"sidecars/scope-sidecar-worker.json": `{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker",
			"versions": [{"version": "0.1.0", "protocol": 1, "releases": {"` + platform + `":
			{"url": "file://` + results["sidecar"]["release"] + `", "sha256": "` + results["sidecar"]["sha256"] + `"}}}]}`,
		"packs/starter.json": `{"name": "starter", "description": "처음 설치하는 plugin.", "plugins": ["probe"]}`,
		"revoked.json":       `{"plugins": [], "sidecars": []}`,
	})
	return dir, results["plugin"]["release"] + " " + results["plugin"]["sha256"], results["sidecar"]["release"] + " " + results["sidecar"]["sha256"]
}

// contract: cli.registry.writes-checked-index
func TestRegistryBuildWritesTheIndexAfterCheckingEveryRelease(t *testing.T) {
	dir, plugin, sidecar := registryTree(t)
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	code, stdout, stderr := run("registry", "build", dir)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	index := filepath.Join(dir, "index.json")
	if want := "{\n  \"carried\": 0,\n  \"core\": 0,\n  \"index\": \"" + index + "\",\n  \"packs\": 1,\n  \"plugins\": 1,\n  \"read\": 2,\n  \"sidecars\": 1\n}\n"; stdout != want {
		t.Fatalf("stdout %q, want %q", stdout, want)
	}
	pluginRelease, pluginHash, _ := strings.Cut(plugin, " ")
	sidecarRelease, sidecarHash, _ := strings.Cut(sidecar, " ")
	want := `{
  "format": 2,
  "plugins": [
    {
      "id": "probe",
      "package": "@scope/plugin-probe",
      "name": "Probe",
      "description": "검사용 plugin.",
      "license": "MIT",
      "repository": "https://example.invalid/probe",
      "versions": [
        {
          "version": "0.2.0",
          "release": {
            "url": "file://` + pluginRelease + `",
            "sha256": "` + pluginHash + `"
          },
          "engines": {
            "soksak": "^0.0.2"
          },
          "sidecars": {
            "@scope/sidecar-worker": "^0.1.0"
          },
          "plugins": {}
        }
      ]
    }
  ],
  "sidecars": [
    {
      "name": "@scope/sidecar-worker",
      "repository": "https://example.invalid/worker",
      "versions": [
        {
          "version": "0.1.0",
          "protocol": 1,
          "releases": {
            "` + platform + `": {
              "url": "file://` + sidecarRelease + `",
              "sha256": "` + sidecarHash + `"
            }
          }
        }
      ]
    }
  ],
  "packs": [
    {
      "name": "starter",
      "description": "처음 설치하는 plugin.",
      "plugins": [
        "probe"
      ]
    }
  ],
  "revoked": {
    "plugins": [],
    "sidecars": []
  }
}
`
	if data, err := os.ReadFile(index); err != nil || string(data) != want {
		t.Fatalf("index.json %v\n%s", err, data)
	}
}

// contract: cli.registry.rejects-without-writing
func TestRegistryBuildRejectsAMismatchWithoutWritingTheIndex(t *testing.T) {
	cases := []struct {
		change func(dir string)
		want   string
	}{
		{func(dir string) {
			replaceIn(t, filepath.Join(dir, "plugins/probe.json"), `"sha256": "`, `"sha256": "0`, 1)
		}, "sha256 must be 64 lowercase hexadecimal digits"},
		{func(dir string) {
			data, err := os.ReadFile(filepath.Join(dir, "plugins/probe.json"))
			if err != nil {
				t.Fatal(err)
			}
			hash := strings.Split(strings.Split(string(data), `"sha256": "`)[1], `"`)[0]
			replaceIn(t, filepath.Join(dir, "plugins/probe.json"), hash, strings.Repeat("0", 64), 1)
		}, "plugin probe 0.2.0 package: "},
		{func(dir string) {
			replaceIn(t, filepath.Join(dir, "plugins/probe.json"), `"engines": {"soksak": "^0.0.2"}`, `"engines": {"soksak": "^0.0.3"}`, 1)
		}, "plugin probe 0.2.0 package: package.json engines.soksak is ^0.0.2, the entry says ^0.0.3"},
		{func(dir string) {
			replaceIn(t, filepath.Join(dir, "plugins/probe.json"), `"sidecars": {"@scope/sidecar-worker": "^0.1.0"}`, `"sidecars": {"@scope/sidecar-worker": "~0.1.0"}`, 1)
		}, `plugin probe 0.2.0 package: plugin.json dependencies {"@scope/sidecar-worker":"^0.1.0"} differ from the entry {"@scope/sidecar-worker":"~0.1.0"}`},
		{func(dir string) {
			if err := os.Rename(filepath.Join(dir, "packs/starter.json"), filepath.Join(dir, "packs/first.json")); err != nil {
				t.Fatal(err)
			}
		}, "packs/first.json holds starter; its file name must be starter.json"},
		{func(dir string) {
			if err := os.Remove(filepath.Join(dir, "revoked.json")); err != nil {
				t.Fatal(err)
			}
		}, "revoked.json: "},
		{func(dir string) {
			replaceIn(t, filepath.Join(dir, "packs/starter.json"), `["probe"]`, `["probe", "missing"]`, 1)
		}, "registry index: pack starter names unknown plugin missing"},
	}
	for _, c := range cases {
		dir, _, _ := registryTree(t)
		c.change(dir)
		code, _, stderr := run("registry", "build", dir)
		if code != 1 || !strings.Contains(stderr, c.want) {
			t.Fatalf("code %d stderr %q, want %q", code, stderr, c.want)
		}
		if _, err := os.Stat(filepath.Join(dir, "index.json")); !os.IsNotExist(err) {
			t.Fatalf("a failed build wrote index.json: %v", err)
		}
	}
}

// contract: cli.registry.checks-plugin-dependencies
func TestRegistryBuildChecksPluginDependencies(t *testing.T) {
	// A plugin dependency names the package of a listed plugin, and the sidecars of the index hold only sidecar
	// dependencies.
	dir := dependencyRegistry(t, base("1.0.0"), dependent{"ext", "1.0.0", map[string]string{"@scope/plugin-base": "^1.0.0", "@scope/sidecar-worker": "^0.1.0"}})
	index := filepath.Join(dir, "index.json")
	if err := os.Remove(index); err != nil {
		t.Fatal(err)
	}
	succeeds(t, "registry", "build", dir)
	var built map[string]any
	if err := json.Unmarshal([]byte(readText(t, index)), &built); err != nil {
		t.Fatal(err)
	}
	if sidecars := jsonText(t, at(built, "plugins", 1, "versions", 0, "sidecars")); sidecars != `{"@scope/sidecar-worker":"^0.1.0"}` {
		t.Fatalf("ext sidecars %s", sidecars)
	}
	for _, c := range []struct {
		versions []dependent
		want     string
	}{
		{[]dependent{{"ext", "1.0.0", map[string]string{"@scope/plugin-gone": "^1.0.0"}}},
			"sok: ext 1.0.0: dependency @scope/plugin-gone is neither a plugin nor a sidecar of the registry\n"},
		{[]dependent{base("1.0.0"), ext("^2.0.0")},
			"sok: ext 1.0.0: plugin dependency @scope/plugin-base ^2.0.0 is satisfied by no listed version\n"},
	} {
		dir := dependencyRegistry(t, c.versions...)
		index := filepath.Join(dir, "index.json")
		if err := os.Remove(index); err != nil {
			t.Fatal(err)
		}
		code, _, stderr := run("registry", "build", dir)
		if code != 1 || stderr != c.want {
			t.Fatalf("code %d stderr %q, want %q", code, stderr, c.want)
		}
		if exists(index) {
			t.Fatal("a failed build wrote index.json")
		}
	}
}

// contract: cli.registry.checks-plugin-dependencies
func TestRegistryBuildReadsAUnionInThePluginDependencies(t *testing.T) {
	// A union is satisfied when a listed version is inside one of its parts, and the index keeps its text.
	dir := dependencyRegistry(t, base("1.0.0"), dependent{"ext", "1.0.0", map[string]string{"@scope/plugin-base": "^2.0.0 || ^1.0.0", "@scope/sidecar-worker": "^0.3.0 || ^0.1.0"}})
	index := filepath.Join(dir, "index.json")
	if err := os.Remove(index); err != nil {
		t.Fatal(err)
	}
	succeeds(t, "registry", "build", dir)
	var built map[string]any
	if err := json.Unmarshal([]byte(readText(t, index)), &built); err != nil {
		t.Fatal(err)
	}
	if sidecars := jsonText(t, at(built, "plugins", 1, "versions", 0, "sidecars")); sidecars != `{"@scope/sidecar-worker":"^0.3.0 || ^0.1.0"}` {
		t.Fatalf("ext sidecars %s", sidecars)
	}
	// A union of which no part holds a listed version is refused with its text.
	dir = dependencyRegistry(t, base("1.0.0"), ext("^2.0.0 || ^3.0.0"))
	if err := os.Remove(filepath.Join(dir, "index.json")); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := run("registry", "build", dir)
	if want := "sok: ext 1.0.0: plugin dependency @scope/plugin-base ^2.0.0 || ^3.0.0 is satisfied by no listed version\n"; code != 1 || stderr != want {
		t.Fatalf("code %d stderr %q, want %q", code, stderr, want)
	}
}

func replaceIn(t *testing.T, path, old, replacement string, count int) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(data), old) < count {
		t.Fatalf("%s has no %q", path, old)
	}
	if err := os.WriteFile(path, []byte(strings.Replace(string(data), old, replacement, count)), 0o644); err != nil {
		t.Fatal(err)
	}
}

// coreTree writes the registry of registryTree with a core.json that lists one core release, and returns its release.
func coreTree(t *testing.T) (dir, release, sum string) {
	t.Helper()
	dir, _, _ = registryTree(t)
	release = filepath.Join(t.TempDir(), "soksak-0.0.9-darwin-arm64-wailsv3.zip")
	if err := os.WriteFile(release, []byte("the zip of an application bundle"), 0o644); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("the zip of an application bundle"))
	sum = hex.EncodeToString(hash[:])
	writeTree(t, dir, map[string]string{
		"core.json": `{"versions": [{"version": "0.0.9", "releases": {"darwin-arm64-wailsv3": {"url": "file://` + release + `", "sha256": "` + sum + `"}}}]}`,
	})
	return dir, release, sum
}

// contract: cli.registry.lists-core-releases
func TestRegistryBuildListsTheCoreReleasesAfterCheckingTheirHashes(t *testing.T) {
	dir, release, sum := coreTree(t)
	code, stdout, stderr := run("registry", "build", dir)
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	if !strings.Contains(stdout, "\"core\": 1,") {
		t.Fatalf("stdout %q does not count the core release", stdout)
	}
	data, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := `  "core": {
    "versions": [
      {
        "version": "0.0.9",
        "releases": {
          "darwin-arm64-wailsv3": {
            "url": "file://` + release + `",
            "sha256": "` + sum + `"
          }
        }
      }
    ]
  },
`
	if !strings.Contains(string(data), want) {
		t.Fatalf("the index has no core list %q: %s", want, data)
	}
	// An index of a registry without core.json lists no core release.
	plain, _, _ := registryTree(t)
	if code, stdout, stderr := run("registry", "build", plain); code != 0 || !strings.Contains(stdout, "\"core\": 0,") {
		t.Fatalf("code %d stdout %q stderr %q", code, stdout, stderr)
	}
	data, err = os.ReadFile(filepath.Join(plain, "index.json"))
	if err != nil || strings.Contains(string(data), `"core"`) {
		t.Fatalf("the index of a registry without core.json holds a core list (%v): %s", err, data)
	}
}

// contract: cli.registry.lists-core-releases
func TestRegistryBuildListsTheCoreKeyOfEachHost(t *testing.T) {
	for _, host := range []string{"tauriv2", "wailsv3", "mygo"} {
		dir, _, _ := coreTree(t)
		replaceIn(t, filepath.Join(dir, "core.json"), `darwin-arm64-wailsv3`, "darwin-arm64-"+host, 1)
		code, _, stderr := run("registry", "build", dir)
		if code != 0 {
			t.Fatalf("darwin-arm64-%s: code %d stderr %q", host, code, stderr)
		}
		data, err := os.ReadFile(filepath.Join(dir, "index.json"))
		if err != nil || !strings.Contains(string(data), `"darwin-arm64-`+host+`": {`) {
			t.Fatalf("the index lists no darwin-arm64-%s release (%v): %s", host, err, data)
		}
	}
}

// contract: cli.registry.rejects-malformed-core-releases
func TestRegistryBuildRejectsMalformedCoreReleasesWithoutWritingTheIndex(t *testing.T) {
	cases := []struct {
		change func(dir, release string)
		want   string
	}{
		{func(dir, release string) {
			replaceIn(t, filepath.Join(dir, "core.json"), `darwin-arm64-wailsv3`, `darwin-arm64`, 1)
		}, "registry core 0.0.9: darwin-arm64 is not <platform>-<host>"},
		{func(dir, release string) {
			replaceIn(t, filepath.Join(dir, "core.json"), `darwin-arm64-wailsv3`, `darwin-arm64-electron`, 1)
		}, "registry core 0.0.9: unknown host electron"},
		{func(dir, release string) {
			replaceIn(t, filepath.Join(dir, "core.json"), `darwin-arm64-wailsv3`, `plan9-arm64-wailsv3`, 1)
		}, "registry core 0.0.9: unknown platform plan9-arm64"},
		{func(dir, release string) {
			replaceIn(t, filepath.Join(dir, "core.json"), `"versions": [`, `"versions": [{"version": "0.0.9", "releases": {"darwin-arm64-tauriv2": {"url": "file://`+release+`", "sha256": "`+strings.Repeat("a", 64)+`"}}}, `, 1)
		}, "registry core: version 0.0.9 appears twice"},
		{func(dir, release string) {
			replaceIn(t, filepath.Join(dir, "core.json"), `{"versions"`, `{"extra": 1, "versions"`, 1)
		}, "registry core: unknown field extra"},
		{func(dir, release string) {
			if err := os.WriteFile(release, []byte("another zip"), 0o644); err != nil {
				t.Fatal(err)
			}
		}, "core 0.0.9 darwin-arm64-wailsv3: "},
		{func(dir, release string) {
			replaceIn(t, filepath.Join(dir, "revoked.json"), `"sidecars": []`, `"sidecars": [], "core": [{"version": "0.0.8", "reason": "broken"}]`, 1)
		}, "registry index: revoked core 0.0.8 is not listed"},
	}
	for _, c := range cases {
		dir, release, _ := coreTree(t)
		c.change(dir, release)
		code, _, stderr := run("registry", "build", dir)
		if code != 1 || !strings.Contains(stderr, c.want) {
			t.Fatalf("code %d stderr %q, want %q", code, stderr, c.want)
		}
		if _, err := os.Stat(filepath.Join(dir, "index.json")); !os.IsNotExist(err) {
			t.Fatalf("a failed build wrote index.json: %v", err)
		}
	}
}

// contract: cli.registry.carries-unchanged-releases
func TestRegistryBuildCarriesUnchangedReleasesWithTheHashOfThePreviousIndex(t *testing.T) {
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	releases := t.TempDir()
	plugin := support.PackRelease(t, pluginTree(t), releases)
	sidecar := support.PackRelease(t, sidecarTree(t, "0.1.0"), releases)
	served := map[string]string{
		"/plugin-0.2.0.tgz":        plugin["release"],
		"/sidecar-0.1.0.tgz":       sidecar["release"],
		"/sidecar-0.1.0-moved.tgz": sidecar["release"],
	}
	var mu sync.Mutex
	silent := false
	var published []byte
	requests := map[string]int{}
	stop := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests[r.URL.Path]++
		never := silent && r.URL.Path == "/plugin-0.2.0.tgz"
		body := published
		mu.Unlock()
		switch {
		case never:
			// The release of the unchanged plugin version never answers, so a build that reads it stalls.
			select {
			case <-r.Context().Done():
			case <-stop:
			}
		case r.URL.Path == "/index.json" && body != nil:
			w.Write(body)
		case served[r.URL.Path] != "":
			data, err := os.ReadFile(served[r.URL.Path])
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Write(data)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(stop) })
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	defer func(previous sok.Fetcher) { sok.DefaultFetcher = previous }(sok.DefaultFetcher)
	sok.DefaultFetcher.TLS = &tls.Config{RootCAs: pool}
	sok.DefaultFetcher.Release.Timeout = 2 * time.Second

	dir := t.TempDir()
	writeTree(t, dir, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [{"version": "0.2.0",
			"release": {"url": "` + server.URL + `/plugin-0.2.0.tgz", "sha256": "` + plugin["sha256"] + `"},
			"engines": {"soksak": "^0.0.2"}, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}}]}`,
		"sidecars/scope-sidecar-worker.json": `{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker",
			"versions": [{"version": "0.1.0", "protocol": 1, "releases": {"` + platform + `":
			{"url": "` + server.URL + `/sidecar-0.1.0.tgz", "sha256": "` + sidecar["sha256"] + `"}}}]}`,
		"packs/starter.json": `{"name": "starter", "description": "처음 설치하는 plugin.", "plugins": ["probe"]}`,
		"revoked.json":       `{"plugins": [], "sidecars": []}`,
	})
	succeeds(t, "registry", "build", dir)
	data, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	published = data
	silent = true
	requests = map[string]int{}
	mu.Unlock()

	// The sidecar release moves to a new address with the same bytes, so its entry changed; the plugin entry did not.
	replaceIn(t, filepath.Join(dir, "sidecars/scope-sidecar-worker.json"), "/sidecar-0.1.0.tgz", "/sidecar-0.1.0-moved.tgz", 1)
	code, stdout, stderr := run("registry", "build", dir, "--previous", server.URL+"/index.json")
	if code != 0 {
		t.Fatalf("code %d stderr %q", code, stderr)
	}
	mu.Lock()
	defer mu.Unlock()
	if requests["/plugin-0.2.0.tgz"] != 0 || requests["/sidecar-0.1.0.tgz"] != 0 || requests["/sidecar-0.1.0-moved.tgz"] != 1 {
		t.Fatalf("release requests %v, want only the changed sidecar release once", requests)
	}
	if want := "{\n  \"carried\": 1,\n  \"core\": 0,\n  \"index\": \"" + filepath.Join(dir, "index.json") + "\",\n  \"packs\": 1,\n  \"plugins\": 1,\n  \"read\": 1,\n  \"sidecars\": 1\n}\n"; stdout != want {
		t.Fatalf("stdout %q, want %q", stdout, want)
	}
}

// contract: cli.registry.rejects-a-previous-index-without-writing
func TestRegistryBuildRejectsAPreviousIndexThatIsMissingOrInvalidWithoutWritingTheIndex(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/invalid.json":
			w.Write([]byte(`{"format": 1}`))
			return
		case "/format1.json":
			// The index of the earlier format, with no plugin dependencies recorded.
			w.Write([]byte(`{"format": 1, "plugins": [], "sidecars": [], "packs": [], "revoked": {"plugins": [], "sidecars": []}}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(server.Close)
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	defer func(previous sok.Fetcher) { sok.DefaultFetcher = previous }(sok.DefaultFetcher)
	sok.DefaultFetcher.TLS = &tls.Config{RootCAs: pool}
	for _, location := range []string{server.URL + "/missing.json", server.URL + "/invalid.json", server.URL + "/format1.json", "relative/index.json"} {
		dir, _, _ := registryTree(t)
		code, _, stderr := run("registry", "build", dir, "--previous", location)
		if code != 1 || !strings.Contains(stderr, location) {
			t.Fatalf("%s: code %d stderr %q", location, code, stderr)
		}
		if _, err := os.Stat(filepath.Join(dir, "index.json")); !os.IsNotExist(err) {
			t.Fatalf("%s: a failed build wrote index.json: %v", location, err)
		}
	}
}

// contract: cli.registry.checks-carried-dependencies
func TestRegistryBuildJudgesCarriedPluginVersionsByTheirRecordedDependencies(t *testing.T) {
	// ext 1.0.0 depends on the plugin base with ^1.0.0, and base lists 1.0.0 and 2.0.0.
	dir := dependencyRegistry(t, base("1.0.0"), base("2.0.0"), ext("^1.0.0"))
	succeeds(t, "registry", "build", dir)
	index := filepath.Join(dir, "index.json")
	previous := filepath.Join(t.TempDir(), "previous.json")
	data, err := os.ReadFile(index)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(previous, data, 0o600); err != nil {
		t.Fatal(err)
	}
	// base 1.0.0 leaves the entries. ext 1.0.0 is unchanged, so it is carried, and its dependency has no listed version.
	removeVersion(t, filepath.Join(dir, "plugins/base.json"), "1.0.0")
	if err := os.Remove(index); err != nil {
		t.Fatal(err)
	}
	code, _, stderr := run("registry", "build", dir, "--previous", "file://"+previous)
	if want := "sok: ext 1.0.0: plugin dependency @scope/plugin-base ^1.0.0 is satisfied by no listed version\n"; code != 1 || stderr != want {
		t.Fatalf("code %d stderr %q, want %q", code, stderr, want)
	}
	if exists(index) {
		t.Fatal("a failed build wrote index.json")
	}
}

// removeVersion deletes the version of the plugin entry at path.
func removeVersion(t *testing.T, path, version string) {
	t.Helper()
	var entry map[string]any
	if err := json.Unmarshal([]byte(readText(t, path)), &entry); err != nil {
		t.Fatal(err)
	}
	var kept []any
	for _, raw := range entry["versions"].([]any) {
		if raw.(map[string]any)["version"] != version {
			kept = append(kept, raw)
		}
	}
	entry["versions"] = kept
	data, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
