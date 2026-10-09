package host

// The host calls of the application update (docs/spec/installation.md#application-update).

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// appHost is the host name of this application in the key of a core release.
const appHost = "wailsv3"

// ReadAppUpdateState reads the registry index and returns the candidate of an application that runs core version
// running for the release key.
func ReadAppUpdateState(configDir, running, key string) (*sok.AppUpdateState, error) {
	return sok.ReadAppUpdateState(configDir, running, key)
}

// StageAppUpdate prepares the candidate: it fails when version is not the candidate for key, so the host stages only
// the version that the registry index offers now.
func StageAppUpdate(configDir, running, key, version string) (string, error) {
	state, err := sok.ReadAppUpdateState(configDir, running, key)
	if err != nil {
		return "", err
	}
	if state.Available == nil || state.Available.Version != version {
		return "", fmt.Errorf("application update: %s is not the candidate of core %s", version, running)
	}
	return sok.StageAppUpdate(configDir, state.Available)
}

// appUpdateKey is the key of the core release of this application: its platform and host.
func appUpdateKey() (string, error) {
	platform, err := sok.CurrentPlatform()
	if err != nil {
		return "", err
	}
	return platform + "-" + appHost, nil
}

// AppUpdateStageRequest is the argument of the appUpdateStage call.
type AppUpdateStageRequest struct {
	Version string `json:"version"`
}

// AppUpdateStaged is the answer of appUpdateStage.
type AppUpdateStaged struct {
	Bundle string `json:"bundle"`
}

// appUpdateStaging allows one preparation at a time.
var appUpdateStaging sync.Mutex

// AppUpdateState is the page's appUpdateState call.
func (h *Host) AppUpdateState(ctx context.Context) (*sok.AppUpdateState, error) {
	key, err := appUpdateKey()
	if err != nil {
		return nil, err
	}
	return ReadAppUpdateState(h.configDir, sok.CoreVersion, key)
}

// AppUpdateStage is the page's appUpdateStage call: it downloads, checks and extracts the release of the candidate.
func (h *Host) AppUpdateStage(ctx context.Context, requestJSON json.RawMessage) (AppUpdateStaged, error) {
	request, err := argument[AppUpdateStageRequest]("request", requestJSON)
	if err != nil {
		return AppUpdateStaged{}, err
	}
	key, err := appUpdateKey()
	if err != nil {
		return AppUpdateStaged{}, err
	}
	if !appUpdateStaging.TryLock() {
		return AppUpdateStaged{}, fmt.Errorf("application update: another update is being prepared")
	}
	defer appUpdateStaging.Unlock()
	bundle, err := StageAppUpdate(h.configDir, sok.CoreVersion, key, request.Version)
	if err != nil {
		return AppUpdateStaged{}, err
	}
	return AppUpdateStaged{Bundle: bundle}, nil
}

// isBundleFolder reports whether the folder holds an application bundle, which has an Info.plist.
func isBundleFolder(path string) bool {
	info, err := os.Stat(filepath.Join(path, "Contents", "Info.plist"))
	return err == nil && info.Mode().IsRegular()
}

// PrepareAppUpdateStart checks the staged bundle and prepares the command that replaces the running bundle: sok runs
// from a copy under updates/ of the configuration directory, because the bundle that holds the running sok is replaced.
// The bundle must be a staged bundle under that folder, and the executable must run from an application bundle; the
// arguments are those of the application that starts again.
func PrepareAppUpdateStart(configDir, executable, bundle string, pid int, arguments []string) (*exec.Cmd, error) {
	updates := filepath.Join(configDir, "updates")
	relative, err := filepath.Rel(updates, bundle)
	if err != nil || strings.HasPrefix(relative, "..") || !strings.HasSuffix(bundle, ".app") {
		return nil, fmt.Errorf("application update: %s is not a staged bundle under %s", bundle, updates)
	}
	if !isBundleFolder(bundle) {
		return nil, fmt.Errorf("application update: %s is not an application bundle", bundle)
	}
	macOS := filepath.Dir(executable)
	target := filepath.Dir(filepath.Dir(macOS))
	if filepath.Base(macOS) != "MacOS" || !strings.HasSuffix(target, ".app") {
		return nil, fmt.Errorf("application update: %s does not run from an application bundle", executable)
	}
	data, err := os.ReadFile(filepath.Join(macOS, "sok"))
	if err != nil {
		return nil, fmt.Errorf("application update: %w", err)
	}
	copied := filepath.Join(updates, "sok")
	if err := os.WriteFile(copied, data, 0o755); err != nil {
		return nil, fmt.Errorf("application update: %w", err)
	}
	args := []string{"app", "update", "--wait", strconv.Itoa(pid), "--bundle", bundle, "--target", target}
	if len(arguments) > 0 {
		args = append(args, "--")
		args = append(args, arguments...)
	}
	command := exec.Command(copied, args...)
	current, err := platform.Current()
	if err != nil {
		return nil, fmt.Errorf("application update: %w", err)
	}
	if err := current.NewSession(command); err != nil {
		return nil, fmt.Errorf("application update: %w", err)
	}
	return command, nil
}

// AppUpdateApplyRequest is the argument of the appUpdateApply call.
type AppUpdateApplyRequest struct {
	Bundle string `json:"bundle"`
}

// AppUpdateApply is the page's appUpdateApply call: it prepares the command that replaces the bundle and quits the
// application as host.quit does. The command starts when the quit is certain, and the persistent services keep running.
func (h *Host) AppUpdateApply(ctx context.Context, requestJSON json.RawMessage) error {
	request, err := argument[AppUpdateApplyRequest]("request", requestJSON)
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("application update: %w", err)
	}
	command, err := PrepareAppUpdateStart(h.configDir, executable, request.Bundle, os.Getpid(), os.Args[1:])
	if err != nil {
		return err
	}
	h.mu.Lock()
	h.update = command
	h.mu.Unlock()
	go application.Get().Quit()
	return nil
}

// takeUpdate returns the command of the pending update, which the shutdown starts, and clears it.
func (h *Host) takeUpdate() *exec.Cmd {
	h.mu.Lock()
	defer h.mu.Unlock()
	command := h.update
	h.update = nil
	return command
}

// cancelUpdate drops the pending update when the quit that it began is cancelled.
func (h *Host) cancelUpdate() {
	h.mu.Lock()
	h.update = nil
	h.mu.Unlock()
}
