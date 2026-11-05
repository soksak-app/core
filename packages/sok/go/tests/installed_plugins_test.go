package tests

import (
	"encoding/json"
	"strings"
	"testing"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

const installedAlpha = `{"id":"alpha","package":"plugin-alpha","version":"1.0.0","manifest":{"id":"alpha","name":"Alpha","description":"검사용.","contributes":{}}}`

const installedProbe = `{"id":"probe","package":"@fixture/probe","version":"0.1.0","manifest":{"id":"probe","name":"Probe","description":"검사용.","contributes":{},` +
	`"dependencies":{"@fixture/sidecar-probe":"^0.1.0"}},"sidecars":`

func acceptOne(t *testing.T, plugin string) error {
	t.Helper()
	accepted, err := sok.AcceptInstalledPlugins(decode(t, `{"plugins":[`+plugin+`]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(accepted.Errors) == 0 {
		if len(accepted.Plugins) != 1 {
			t.Fatalf("accepted %v", accepted)
		}
		return nil
	}
	if len(accepted.Plugins) != 0 || len(accepted.Errors) != 1 {
		t.Fatalf("accepted %v", accepted)
	}
	return errString(accepted.Errors[0])
}

type errString string

func (e errString) Error() string { return string(e) }

func TestAcceptingLeavesOutEachRefusedPluginWithItsError(t *testing.T) {
	unnamed := `{"id":"beta","package":"plugin-beta","version":"0.0.1","manifest":{"id":"beta","description":"이름이 없는 manifest."}}`
	badPackage := strings.NewReplacer(`"plugin-alpha"`, `"Bad"`, `"alpha"`, `"gamma"`).Replace(installedAlpha)
	accepted, err := sok.AcceptInstalledPlugins(decode(t, `{"plugins":[`+unnamed+`,`+installedAlpha+`,`+badPackage+`]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(accepted.Plugins) != 1 || accepted.Plugins[0].(map[string]any)["id"] != "alpha" {
		t.Fatalf("plugins %v", accepted.Plugins)
	}
	if got, _ := json.Marshal(accepted.Refused); string(got) != `["beta","gamma"]` {
		t.Fatalf("refused %s", got)
	}
	if len(accepted.Errors) != 2 || !strings.HasPrefix(accepted.Errors[0], "installed plugin beta 0.0.1 (plugin-beta): ") ||
		!strings.Contains(accepted.Errors[1], "plugin gamma package must be a package.json name") {
		t.Fatalf("errors %q", accepted.Errors)
	}
}

func TestAnErrorDocumentAcceptsNoPluginAndAnswersItsError(t *testing.T) {
	accepted, err := sok.AcceptInstalledPlugins(decode(t, `{"error":"plugins/installed.json: format must be 3"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(accepted.Plugins) != 0 || len(accepted.Refused) != 0 || len(accepted.Errors) != 1 ||
		accepted.Errors[0] != "installed plugins: plugins/installed.json: format must be 3" {
		t.Fatalf("accepted %v", accepted)
	}
}

func TestADocumentOfAnotherFormOrWithAPluginTwiceIsAnError(t *testing.T) {
	for text, want := range map[string]string{
		`[]`:                       "expected an object",
		`{"error":1}`:              "error must be text",
		`{"plugins":{}}`:           "plugins must be an array",
		`{"plugins":[],"extra":1}`: "unknown field extra",
		`{"plugins":[` + installedAlpha + `,` + installedAlpha + `]}`:                                          "plugin alpha appears twice",
		`{"plugins":[` + installedAlpha + `,` + strings.ReplaceAll(installedAlpha, `"alpha"`, `"beta"`) + `]}`: "package plugin-alpha appears twice",
	} {
		_, err := sok.AcceptInstalledPlugins(decode(t, text))
		rejects(t, err, want)
	}
}

func TestAnInstalledEntryFollowsTheRulesOfThePage(t *testing.T) {
	entry := func(old, new string) string {
		if !strings.Contains(installedAlpha, old) {
			t.Fatalf("the fixture has no %s", old)
		}
		return strings.Replace(installedAlpha, old, new, 1)
	}
	for plugin, want := range map[string]string{
		`1`: "every plugin must be an object",
		entry(`"id":"alpha",`, `"id":"alpha","extra":1,`):              "unknown field extra",
		entry(`"id":"alpha",`, `"id":"Alpha",`):                        "plugin id Alpha is invalid",
		entry(`"plugin-alpha"`, `"Bad"`):                               "plugin alpha package must be a package.json name",
		entry(`"version":"1.0.0",`, ``):                                "plugin alpha version is required",
		`{"id":"alpha","package":"plugin-alpha","version":"1.0.0"}`:    "plugin alpha manifest is required",
		entry(`"manifest":{"id":"alpha"`, `"manifest":{"id":"beta"`):   "plugin alpha has a plugin.json with id beta",
		entry(`"name":"Alpha",`, ``):                                   "installed plugin alpha 1.0.0 (plugin-alpha): ",
		strings.TrimSuffix(installedAlpha, `}`) + `,"diagnostics":[]}`: "plugin alpha diagnostics must be an object",
	} {
		rejects(t, acceptOne(t, plugin), want)
	}
}

func TestTheSidecarFactsOfAnInstalledPluginAreItsDependencies(t *testing.T) {
	const facts = `{"message":{"form":"json-object","operationField":"operation"}}`
	for _, sidecars := range []string{`{"@fixture/sidecar-probe":` + facts + `}`, `{"@fixture/sidecar-probe":{}}`} {
		if err := acceptOne(t, installedProbe+sidecars+`}`); err != nil {
			t.Fatal(err)
		}
	}
	for sidecars, want := range map[string]string{
		`[]`:                               "sidecars must map sidecars to facts",
		`{"@fixture/other":` + facts + `}`: "sidecars @fixture/other is not a dependency",
		`{"@fixture/sidecar-probe":1}`:     "facts must be an object",
		`{"@fixture/sidecar-probe":{"executable":"build/worker"}}`:                            "unknown field executable",
		`{"@fixture/sidecar-probe":{"message":1}}`:                                            "message must be an object",
		`{"@fixture/sidecar-probe":{"message":{"form":"text","operationField":"operation"}}}`: "message form must be json-object",
		`{"@fixture/sidecar-probe":{"message":{"form":"json-object","operationField":""}}}`:   "message operationField must be a field name",
	} {
		rejects(t, acceptOne(t, installedProbe+sidecars+`}`), want)
	}
}
