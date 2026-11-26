package host

// The account runs and account homes of a plugin (docs/spec/native-surfaces.md#account-runs).

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// accountDeclarations are the programs of a plugin whose account programs take the kind and the home.
func accountDeclarations(t *testing.T) map[string]programDeclaration {
	t.Helper()
	declared, err := parseProgramDeclarations(json.RawMessage(`{
		"account-status": {"program": "plugin:bin/account.mjs", "args": [{"pattern": "[a-z][a-z0-9-]*"}, {"pattern": "/.+"}]},
		"account-node": {"program": "node", "args": [{"pattern": "[a-z][a-z0-9-]*"}, {"pattern": "/.+"}]},
		"account-path": {"program": "bin/account", "args": [{"pattern": "[a-z][a-z0-9-]*"}, {"pattern": "/.+"}]}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	return declared
}

// contract: account.run.working-folder-is-the-plugin-data-folder
// An account run starts in the data folder of the plugin with the arguments that its pattern slots accept, and needs no project.
func TestAnAccountRunStartsInThePluginDataFolder(t *testing.T) {
	declared := accountDeclarations(t)
	for _, name := range []string{"account-status", "account-node"} {
		run, err := checkAccountRun(declared, "plugin-x", name, []string{"claude", "/data/plugin-x/accounts/account-1"}, "/data/plugin-x")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if run.Directory != "/data/plugin-x" || !slices.Equal(run.Args, []string{"claude", "/data/plugin-x/accounts/account-1"}) {
			t.Fatalf("%s: run %+v", name, run)
		}
	}
	if _, err := checkAccountRun(declared, "plugin-x", "account-node", []string{"Claude", "/h"}, "/data/plugin-x"); err == nil ||
		err.Error() != "program account-node argument 1 Claude does not match its pattern" {
		t.Fatalf("an argument outside its pattern answered %v", err)
	}
	if _, err := checkAccountRun(declared, "plugin-x", "login", []string{"a", "/h"}, "/data/plugin-x"); err == nil ||
		err.Error() != "program login is not declared by plugin-x" {
		t.Fatalf("an undeclared name answered %v", err)
	}
}

// contract: account.run.refuses-a-path-program
func TestAnAccountRunRefusesAProgramPath(t *testing.T) {
	_, err := checkAccountRun(accountDeclarations(t), "plugin-x", "account-path", []string{"claude", "/h"}, "/data/plugin-x")
	if err == nil || err.Error() != "program account-path must be a plugin path or a bare name in an account run" {
		t.Fatalf("error %v", err)
	}
}

// contract: account.run.refuses-fifth-open-run
func TestTheFifthOpenAccountRunOfAPluginIsRefused(t *testing.T) {
	var runs programRuns
	cancel := func(error) {}
	if err := runs.begin("s1", 1, cancel); err != nil {
		t.Fatal(err)
	}
	for run := uint64(1); run <= programRunsPerSurface; run++ {
		if err := runs.beginAccount("plugin-x", run, cancel); err != nil {
			t.Fatalf("run %d refused: %v", run, err)
		}
	}
	if err := runs.beginAccount("plugin-x", 5, cancel); err == nil || err.Error() != "program run: 4 runs are open on plugin plugin-x" {
		t.Fatalf("error %v", err)
	}
	if err := runs.beginAccount("plugin-y", 1, cancel); err != nil {
		t.Fatalf("another plugin was refused: %v", err)
	}
}

// contract: account.run.refuses-an-open-run-identifier
func TestAnAccountRunOfAnOpenIdentifierIsRefused(t *testing.T) {
	var runs programRuns
	cancel := func(error) {}
	if err := runs.beginAccount("plugin-x", 3, cancel); err != nil {
		t.Fatal(err)
	}
	if err := runs.beginAccount("plugin-x", 3, cancel); err == nil || err.Error() != "program run: run 3 is already open on plugin plugin-x" {
		t.Fatalf("error %v", err)
	}
	if err := runs.begin("plugin-x", 3, cancel); err != nil {
		t.Fatalf("a surface of the same name is another owner: %v", err)
	}
}

// contract: account.run.cancel-is-idempotent
func TestAnAccountRunCancelIsIdempotent(t *testing.T) {
	var runs programRuns
	ctx, cancel := context.WithCancelCause(context.Background())
	if err := runs.beginAccount("plugin-x", 1, cancel); err != nil {
		t.Fatal(err)
	}
	runs.cancel("plugin-x", 1)
	if ctx.Err() != nil {
		t.Fatal("the cancel of a surface run ended an account run")
	}
	runs.cancelAccount("plugin-x", 1)
	runs.cancelAccount("plugin-x", 1)
	runs.cancelAccount("plugin-x", 9)
	if context.Cause(ctx) != ProgramCancelled {
		t.Fatalf("cause %v", context.Cause(ctx))
	}
}

// contract: account.run.window-close-ends-the-run
func TestTheWindowEndsAnAccountRunAndASurfaceEndsNone(t *testing.T) {
	var runs programRuns
	ctx, cancel := context.WithCancelCause(context.Background())
	if err := runs.beginAccount("plugin-x", 1, cancel); err != nil {
		t.Fatal(err)
	}
	runs.end("plugin-x", ProgramSurfaceClosed)
	if ctx.Err() != nil {
		t.Fatal("the end of a surface ended an account run")
	}
	runs.endAll(ProgramWindowClosed)
	if context.Cause(ctx) != ProgramWindowClosed {
		t.Fatalf("cause %v", context.Cause(ctx))
	}
}

// contract: account.home.lists-the-folders, account.home.creates-a-private-folder
func TestAccountHomesAreListedCreatedAndRemoved(t *testing.T) {
	config := t.TempDir()
	listed, err := AccountHomes(config, "plugin-x")
	if err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(config, "plugin-data", "plugin-x", "accounts")
	if listed.Folder != folder || listed.Names == nil || len(listed.Names) != 0 {
		t.Fatalf("before any home: %+v", listed)
	}
	for _, id := range []string{"account-2", "account-1"} {
		if err := AccountHomeCreate(config, "plugin-x", id); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(folder, "note"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(folder, "account-1"))
	if err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("the home is %v, %v", info, err)
	}
	if err := os.WriteFile(filepath.Join(folder, "account-1", "settings.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if listed, err = AccountHomes(config, "plugin-x"); err != nil || !slices.Equal(listed.Names, []string{"account-1", "account-2"}) {
		t.Fatalf("listed %+v, %v", listed, err)
	}
	if err := AccountHomeRemove(config, "plugin-x", "account-1"); err != nil {
		t.Fatal(err)
	}
	if err := AccountHomeRemove(config, "plugin-x", "account-1"); err != nil {
		t.Fatalf("a second remove: %v", err)
	}
	if listed, err = AccountHomes(config, "plugin-x"); err != nil || !slices.Equal(listed.Names, []string{"account-2"}) {
		t.Fatalf("listed %+v, %v", listed, err)
	}
}

// contract: account.home.refuses-an-identifier
func TestAnAccountHomeRefusesAnIdentifierAndAPlugin(t *testing.T) {
	config := t.TempDir()
	for _, id := range []string{"", "Account", "../x", "a/b", "a2345678901234567890123456789012345678901"} {
		if err := AccountHomeCreate(config, "plugin-x", id); err == nil || err.Error() != "account home "+id+" is not an account identifier" {
			t.Fatalf("id %q answered %v", id, err)
		}
		if err := AccountHomeRemove(config, "plugin-x", id); err == nil || err.Error() != "account home "+id+" is not an account identifier" {
			t.Fatalf("remove of id %q answered %v", id, err)
		}
	}
	for _, plugin := range []string{"..", "a/b", "X"} {
		want := "account home: plugin " + plugin + " is not a plugin identifier"
		if err := AccountHomeCreate(config, plugin, "account-1"); err == nil || err.Error() != want {
			t.Fatalf("plugin %q answered %v", plugin, err)
		}
		if _, err := AccountHomes(config, plugin); err == nil || err.Error() != want {
			t.Fatalf("the list of plugin %q answered %v", plugin, err)
		}
	}
	if entries, err := os.ReadDir(config); err != nil || len(entries) != 0 {
		t.Fatalf("a refusal wrote %v, %v", entries, err)
	}
}
