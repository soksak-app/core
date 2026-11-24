package host_test

// Checks a plugin operation that the live service of a persistent sidecar holds, in the plugin operations of the host
// (docs/spec/persistent-services.md#updates). The registry holds real releases, the old service is a process that the endpoint
// names, and the installed service is the sidecar fixture program of the release.

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

const heldWorker = "@scope/sidecar-worker"

// packHeldRelease writes the release of files, under package/, to path and returns its sha256. A name that ends with * is an
// executable.
func packHeldRelease(t *testing.T, path string, files map[string]string) string {
	t.Helper()
	var data bytes.Buffer
	zipped := gzip.NewWriter(&data)
	stream := tar.NewWriter(zipped)
	for name, content := range files {
		mode := int64(0o644)
		if trimmed, executable := strings.CutSuffix(name, "*"); executable {
			name, mode = trimmed, 0o755
		}
		if err := stream.WriteHeader(&tar.Header{Typeflag: tar.TypeReg, Name: "package/" + name, Mode: mode, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := stream.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data.Bytes())
	return hex.EncodeToString(sum[:])
}

// fixtureProgram is the text of the sidecar fixture program, which a release carries as the executable of the sidecar.
func fixtureProgram(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	data, err := os.ReadFile(filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "docs", "spec", "cases", "sidecars", "fixture.sh"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// writeHeldRegistry builds in dir the registry of the given probe versions: probe 0.2.0 requires the persistent sidecar worker
// ^0.1.0 and probe 0.3.0 requires ^0.2.0. Each worker release is the fixture program, whose control publishes an endpoint on
// socket and records the process id in pidPath. It returns the path of index.json.
func writeHeldRegistry(t *testing.T, dir, socket, pidPath string, versions ...string) string {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	ranges := map[string]string{"0.2.0": "^0.1.0", "0.3.0": "^0.2.0"}
	if err := os.MkdirAll(filepath.Join(dir, "releases"), 0o755); err != nil {
		t.Fatal(err)
	}
	var entries []string
	for _, version := range versions {
		path := filepath.Join(dir, "releases", "probe-"+version+".tgz")
		sum := packHeldRelease(t, path, map[string]string{
			"package.json": `{"name": "@scope/plugin-probe", "version": "` + version + `", "engines": {"soksak": "^` + sok.CoreVersion + `"}, "files": ["plugin.json", "ui"]}`,
			"plugin.json": `{"id": "probe", "name": "Probe", "description": "Sample.", "contributes": {"lib.point": [{"range": "^1.0.0", "module": "ui/b.js"}]},
				"dependencies": {"` + heldWorker + `": "` + ranges[version] + `"}}`,
			"ui/b.js": "b " + version,
		})
		entries = append(entries, fmt.Sprintf(`{"version": %q, "release": {"url": "file://%s", "sha256": %q}, "engines": {"soksak": "^%s"}, "sidecars": {%q: %q}}`,
			version, path, sum, sok.CoreVersion, heldWorker, ranges[version]))
	}
	var sidecars []string
	for _, version := range []string{"0.1.0", "0.2.0"} {
		path := filepath.Join(dir, "releases", "worker-"+version+".tgz")
		sum := packHeldRelease(t, path, map[string]string{
			"package.json":  `{"name": "` + heldWorker + `", "version": "` + version + `", "files": ["sidecar.json", "build"]}`,
			"sidecar.json":  `{"executable": "build/worker", "protocol": 1, "displayName": "soksak://sidecar/probe", "transport": "persistent"}`,
			"build/worker*": fixtureProgram(t),
			"build/control": "record-pid " + pidPath + "\nendpoint " + socket + " harness-token\nsleep 20\n",
		})
		sidecars = append(sidecars, fmt.Sprintf(`{"version": %q, "protocol": 1, "releases": {%q: {"url": "file://%s", "sha256": %q}}}`, version, platform, path, sum))
	}
	support.WriteInstalled(t, dir, map[string]string{
		"plugins/probe.json": `{"id": "probe", "package": "@scope/plugin-probe", "name": "Probe", "description": "검사용 plugin.",
			"license": "MIT", "repository": "https://example.invalid/probe", "versions": [` + strings.Join(entries, ",") + `]}`,
		"sidecars/scope-sidecar-worker.json": `{"name": "` + heldWorker + `", "repository": "https://example.invalid/worker", "versions": [` + strings.Join(sidecars, ",") + `]}`,
		"revoked.json":                       `{"plugins": [], "sidecars": []}`,
	})
	var stdout, stderr bytes.Buffer
	if code := sok.Run([]string{"registry", "build", dir}, &stdout, &stderr, sok.Options{Identifier: "com.soksak.test", CoreVersion: sok.CoreVersion}); code != 0 {
		t.Fatalf("registry build: code %d stderr %s", code, stderr.String())
	}
	return filepath.Join(dir, "index.json")
}

// heldService is the service of worker 0.1.0 that runs beside the installation: a process that the endpoint names, whose first
// connection answers hello with 0.1.0 and ends the process after shutdown, and whose later connections, from the installed service
// that the host starts, answer hello with 0.2.0. installed receives each later connection.
type heldService struct {
	process   *exec.Cmd
	installed chan struct{}
}

func serveHeldService(t *testing.T, config, socket, pidPath string) *heldService {
	t.Helper()
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	process := exec.Command("cat")
	if _, err := process.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	if err := process.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { process.Process.Kill(); process.Wait() })
	// The installed service that the host starts records its process id, and ends with the test.
	t.Cleanup(func() {
		data, err := os.ReadFile(pidPath)
		if errors.Is(err, os.ErrNotExist) {
			return
		}
		if err != nil {
			t.Error(err)
			return
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
		if err != nil {
			t.Error(err)
			return
		}
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			t.Error(err)
		}
		var status syscall.WaitStatus
		for {
			if _, err := syscall.Wait4(pid, &status, 0, nil); !errors.Is(err, syscall.EINTR) {
				break
			}
		}
	})
	support.WriteInstalled(t, config, map[string]string{
		"services/worker/endpoint.json": fmt.Sprintf(`{"protocol": 1, "pid": %d, "socket": %q, "token": "harness-token"}`, process.Process.Pid, socket),
	})
	service := &heldService{process: process, installed: make(chan struct{}, 4)}
	go func() {
		for index := 0; ; index++ {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			version := "0.1.0"
			if index > 0 {
				version = "0.2.0"
			}
			go func(first bool) {
				defer connection.Close()
				reader := bufio.NewReader(connection)
				for {
					line, err := reader.ReadBytes('\n')
					if err != nil {
						return
					}
					var request map[string]any
					if json.Unmarshal(line, &request) != nil {
						return
					}
					var reply []byte
					switch request["operation"] {
					case "hello":
						reply, _ = json.Marshal(map[string]any{"operation": "hello", "protocol": 1, "ok": true, "version": version})
					case "close-owner":
						reply, _ = json.Marshal(map[string]any{"operation": "closed-owner", "request": request["request"], "ok": true})
					case "shutdown":
						reply, _ = json.Marshal(map[string]any{"operation": "shutdown", "request": request["request"], "ok": true})
					case "retain":
						reply, _ = json.Marshal(map[string]any{"operation": "retained", "request": request["request"], "ok": true, "closed": 0})
					default:
						reply = line[:len(line)-1]
					}
					if _, err := connection.Write(append(reply, '\n')); err != nil {
						return
					}
					if request["operation"] == "hello" && !first {
						service.installed <- struct{}{}
					}
					if request["operation"] == "shutdown" {
						process.Process.Kill()
						return
					}
				}
			}(index == 0)
		}
	}()
	return service
}

// heldInstallation installs probe 0.2.0 with worker 0.1.0 in a new configuration folder, uses the registry of probe 0.2.0 and 0.3.0,
// starts the service of worker 0.1.0 and returns the folder, the sidecars and the plugin operations of the host, whose apply step
// declares the installed sidecars.
func heldInstallation(t *testing.T) (string, *host.Sidecars, *host.Plugins, *heldService) {
	t.Helper()
	config := t.TempDir()
	socket := filepath.Join(support.SocketParent(t), "s.sock")
	pidPath := filepath.Join(t.TempDir(), "installed.pid")
	first := writeHeldRegistry(t, t.TempDir(), socket, pidPath, "0.2.0")
	if _, err := sok.UseRegistry(config, first, sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.RunPluginAction(config, "install", "probe", sok.CoreVersion, mustCurrentPlatform(t), sok.Running{}); err != nil {
		t.Fatal(err)
	}
	if _, err := sok.UseRegistry(config, writeHeldRegistry(t, t.TempDir(), socket, pidPath, "0.2.0", "0.3.0"), sok.DefaultFetcher); err != nil {
		t.Fatal(err)
	}
	service := serveHeldService(t, config, socket, pidPath)
	declarations, err := host.InstalledSidecars(config)
	if err != nil {
		t.Fatal(err)
	}
	sidecars, err := host.NewSidecars(declarations, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sidecars.Stop)
	apply := func() error {
		declarations, err := host.InstalledSidecars(config)
		if err != nil {
			return err
		}
		return sidecars.Declare(declarations)
	}
	plugins, err := host.NewPlugins(config, func() host.PluginServices { return sidecars }, apply, func(host.PluginsChanged) {})
	if err != nil {
		t.Fatal(err)
	}
	return config, sidecars, plugins, service
}

func mustCurrentPlatform(t *testing.T) string {
	t.Helper()
	platform, err := sok.CurrentPlatform()
	if err != nil {
		t.Fatal(err)
	}
	return platform
}

const heldError = "plugin probe 0.3.0: sidecar " + heldWorker + " 0.2.0 waits for the end of its running service 0.1.0"

// heldState is the held list of pluginsState for the update of probe beside the service of worker 0.1.0.
func heldState(sessions *int) []sok.HeldOperation {
	running := "0.1.0"
	return []sok.HeldOperation{{Plugin: "probe", Action: "update", Version: "0.3.0", Error: heldError,
		Sidecars: []sok.HeldService{{Sidecar: heldWorker, Planned: "0.2.0", Running: &running, Sessions: sessions}}}}
}

func readHeld(t *testing.T, plugins *host.Plugins) []sok.HeldOperation {
	t.Helper()
	state, err := plugins.State()
	if err != nil {
		t.Fatal(err)
	}
	return state.Held
}

// contract: plugins.held.update-waits-and-runs-with-the-end-of-its-service
func TestAHeldUpdateIsListedAndRunsWithTheEndOfItsService(t *testing.T) {
	logged := recordText(support.CaptureLog(t))
	config, sidecars, plugins, service := heldInstallation(t)
	before, text := installedProbe(t, config)
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "update", Plugin: "probe"}); err == nil || err.Error() != heldError {
		t.Fatalf("the update beside the service returned %v, want %q", err, heldError)
	}
	if version, after := installedProbe(t, config); version != before || after != text {
		t.Fatalf("the held update changed installed.json to %s", after)
	}
	if held := readHeld(t, plugins); !reflect.DeepEqual(held, heldState(nil)) {
		t.Fatalf("the held list before the layouts is %+v", held)
	}
	for _, item := range []struct {
		request host.PluginsRunRequest
		want    string
	}{
		{host.PluginsRunRequest{Action: "update", Plugin: "probe", End: "yes"}, "end must be true"},
		{host.PluginsRunRequest{Action: "remove", Plugin: "probe", End: true}, "end does not apply to remove"},
		{host.PluginsRunRequest{Action: "update", Plugin: "probe", End: true}, "plugin probe: the sessions of sidecar " + heldWorker + " are not known"},
	} {
		if _, err := plugins.Run(item.request); err == nil || err.Error() != item.want {
			t.Fatalf("%+v returned %v, want %q", item.request, err, item.want)
		}
	}
	if _, err := sidecars.Retain([]host.RetainedSurface{}); err != nil {
		t.Fatal(err)
	}
	none := 0
	if held := readHeld(t, plugins); !reflect.DeepEqual(held, heldState(&none)) {
		t.Fatalf("the held list after the layouts is %+v", held)
	}
	if _, err := plugins.Run(host.PluginsRunRequest{Action: "update", Plugin: "probe", End: true}); err != nil {
		t.Fatal(err)
	}
	if state, err := sok.ReadInstalled(config); err != nil || state.Plugins["probe"].Version != "0.3.0" || state.Sidecars[heldWorker].Version != "0.2.0" {
		t.Fatalf("installed.json after the end records %+v (%v)", state, err)
	}
	if held := readHeld(t, plugins); len(held) != 0 {
		t.Fatalf("the held list after the update is %+v", held)
	}
	// The reconnection starts the installed service after the operation.
	<-service.installed
	if want := "sidecar " + heldWorker + ": service 0.1.0 ended for plugin probe 0.3.0"; !strings.Contains(logged.String(), want) {
		t.Fatalf("the log has no %q: %q", want, logged.String())
	}
}

// contract: plugins.held.update-at-start-keeps-a-held-candidate
func TestAnUpdateAtStartThatAServiceHoldsStaysAndIsListed(t *testing.T) {
	config, _, plugins, _ := heldInstallation(t)
	_, text := installedProbe(t, config)
	results := plugins.UpdateAtStart()
	if len(results) != 1 || !results[0].Held || results[0].Err == nil || results[0].Err.Error() != heldError {
		t.Fatalf("the update at start returned %+v", results)
	}
	if _, after := installedProbe(t, config); after != text {
		t.Fatalf("the held update at start changed installed.json to %s", after)
	}
	state, err := plugins.State()
	if err != nil {
		t.Fatal(err)
	}
	if len(state.StartUpdate) != 0 || !reflect.DeepEqual(state.Held, heldState(nil)) {
		t.Fatalf("the state after the held update at start is %+v held %+v", state.StartUpdate, state.Held)
	}
}
