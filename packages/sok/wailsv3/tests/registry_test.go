package tests

// registry build(docs/spec/cli.md)가 registry 폴더를 검사하고 index.json 을 쓰는지 검사한다.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/min-median-max/soksak/packages/sok/wailsv3/src"
)

// registryTree 는 pack 과 release 로 archive 를 만들고 그 주소와 hash 를 담은 registry 폴더를 쓴다.
func registryTree(t *testing.T) (dir, pluginSum, sidecarSum string) {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	releases := t.TempDir()
	results := map[string]map[string]string{}
	for name, args := range map[string][]string{
		"plugin":  {"plugin", "pack", pluginTree(t), releases},
		"sidecar": {"sidecar", "release", sidecarTree(t, "0.1.0"), releases, "--platform", platform},
	} {
		code, stdout, stderr := run(args...)
		if code != 0 {
			t.Fatalf("%s: code %d stderr %q", name, code, stderr)
		}
		var result map[string]string
		if err := json.Unmarshal([]byte(stdout), &result); err != nil {
			t.Fatal(err)
		}
		results[name] = result
	}
	dir = t.TempDir()
	writeTree(t, dir, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [{"version": "0.2.0",
			"package": {"url": "file://` + results["plugin"]["archive"] + `", "sha256": "` + results["plugin"]["sha256"] + `"},
			"engines": {"soksak": "^0.0.2"}, "sidecars": {"@scope/sidecar-worker": "^0.1.0"}}]}`,
		"sidecars/scope-sidecar-worker.json": `{"name": "@scope/sidecar-worker", "repository": "https://example.invalid/worker",
			"versions": [{"version": "0.1.0", "protocol": 1, "assets": {"` + platform + `":
			{"url": "file://` + results["sidecar"]["archive"] + `", "sha256": "` + results["sidecar"]["sha256"] + `"}}}]}`,
		"packs/starter.json": `{"name": "starter", "description": "처음 설치하는 plugin.", "plugins": ["probe"]}`,
		"revoked.json":       `{"plugins": [], "sidecars": []}`,
	})
	return dir, results["plugin"]["archive"] + " " + results["plugin"]["sha256"], results["sidecar"]["archive"] + " " + results["sidecar"]["sha256"]
}

// contract: cli.registry.writes-checked-index
func TestRegistryBuildWritesTheIndexAfterCheckingEveryArchive(t *testing.T) {
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
	if want := "{\n  \"index\": \"" + index + "\",\n  \"packs\": 1,\n  \"plugins\": 1,\n  \"sidecars\": 1\n}\n"; stdout != want {
		t.Fatalf("stdout %q, want %q", stdout, want)
	}
	pluginArchive, pluginHash, _ := strings.Cut(plugin, " ")
	sidecarArchive, sidecarHash, _ := strings.Cut(sidecar, " ")
	want := `{
  "format": 1,
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
          "package": {
            "url": "file://` + pluginArchive + `",
            "sha256": "` + pluginHash + `"
          },
          "engines": {
            "soksak": "^0.0.2"
          },
          "sidecars": {
            "@scope/sidecar-worker": "^0.1.0"
          }
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
          "assets": {
            "` + platform + `": {
              "url": "file://` + sidecarArchive + `",
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
