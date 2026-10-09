package sok

// 애플리케이션 업데이트의 후보 선택과 release 준비(docs/spec/installation.md#application-update).

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// AppUpdate is the candidate of an application update: a core version that the registry index lists and its release.
type AppUpdate struct {
	Version string  `json:"version"`
	Release Release `json:"release"`
}

// AppUpdateState is the version of the running core and the candidate, or nil when none is available.
type AppUpdateState struct {
	Version   string     `json:"version"`
	Available *AppUpdate `json:"available"`
}

// CoreUpdateCandidate selects the newest version of `core` that is newer than the running core, is not revoked and has
// a release for key, `<platform>-<host>`; it is nil when there is none.
func CoreUpdateCandidate(index *Index, running, key string) *AppUpdate {
	if index.Core == nil {
		return nil
	}
	var best *AppUpdate
	for _, item := range index.Core.Versions {
		release, ok := item.Releases[key]
		if !ok || !newer(item.Version, running) {
			continue
		}
		if revoked := func() bool {
			for _, withdrawn := range index.Revoked.Core {
				if withdrawn.Version == item.Version {
					return true
				}
			}
			return false
		}(); revoked {
			continue
		}
		if best == nil || newer(item.Version, best.Version) {
			best = &AppUpdate{Version: item.Version, Release: release}
		}
	}
	return best
}

// ReadAppUpdateState reads the registry index and returns the candidate for key. A configuration directory without a
// registry fails with the error of readRegistry.
func ReadAppUpdateState(configDir, running, key string) (*AppUpdateState, error) {
	index, err := readRegistry(configDir)
	if err != nil {
		return nil, err
	}
	return &AppUpdateState{Version: running, Available: CoreUpdateCandidate(index, running, key)}, nil
}

// StageAppUpdate downloads the release of the candidate, checks its sha256, extracts the zip into
// `<configDir>/updates/<version>/` after removing that folder, checks that the folder holds one application bundle
// whose CFBundleShortVersionString is the version, and returns the path of the bundle. A failure removes the folder.
func StageAppUpdate(configDir string, update *AppUpdate) (string, error) {
	where := "application update " + update.Version
	data, err := readRelease(where, update.Release)
	if err != nil {
		return "", err
	}
	folder := filepath.Join(configDir, "updates", update.Version)
	if err := os.RemoveAll(folder); err != nil {
		return "", fmt.Errorf("%s: %w", where, err)
	}
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return "", fmt.Errorf("%s: %w", where, err)
	}
	fail := func(err error) (string, error) {
		if removed := os.RemoveAll(folder); removed != nil {
			err = fmt.Errorf("%w; the staged folder was not removed: %v", err, removed)
		}
		return "", fmt.Errorf("%s: %w", where, err)
	}
	current, err := platform.Current()
	if err != nil {
		return fail(err)
	}
	zipped := filepath.Join(folder, "release.zip")
	if err := os.WriteFile(zipped, data, 0o644); err != nil {
		return fail(err)
	}
	if err := current.ExtractBundle(zipped, folder); err != nil {
		return fail(err)
	}
	if err := os.Remove(zipped); err != nil {
		return fail(err)
	}
	bundles, err := filepath.Glob(filepath.Join(folder, "*.app"))
	if err != nil {
		return fail(err)
	}
	if len(bundles) != 1 {
		return fail(fmt.Errorf("the release holds %d application bundles, not one", len(bundles)))
	}
	got, err := current.BundleVersion(bundles[0])
	if err != nil {
		return fail(err)
	}
	if got != update.Version {
		return fail(fmt.Errorf("the bundle version is %s, not %s", got, update.Version))
	}
	return bundles[0], nil
}

// ReplaceOptions are the arguments of `sok app update`.
type ReplaceOptions struct {
	// PID is the process of the application that quits for the update.
	PID int
	// Bundle is the staged bundle of the new version, and Target is the bundle that the application runs from.
	Bundle, Target string
	// Arguments are the arguments of the application that starts again.
	Arguments []string
	// Timeout is how long ReplaceApp waits for the end of the process.
	Timeout time.Duration
}

// isBundle reports whether the folder holds an application bundle, which has an Info.plist.
func isBundle(path string) bool {
	info, err := os.Stat(filepath.Join(path, "Contents", "Info.plist"))
	return err == nil && info.Mode().IsRegular()
}

// ReplaceApp replaces the bundle Target with Bundle after the process PID has ended and starts the application through
// open (docs/spec/installation.md#application-update). It copies the new bundle beside the target first, so a failure
// before the move leaves the target as it was, and it restores the earlier bundle and starts it when the new one cannot
// start.
func ReplaceApp(options ReplaceOptions, open func(bundle string, arguments []string) error) error {
	for _, check := range []struct{ name, path string }{{"bundle", options.Bundle}, {"target", options.Target}} {
		if !isBundle(check.path) {
			return fmt.Errorf("application update: the %s %s is not an application bundle", check.name, check.path)
		}
	}
	if filepath.Clean(options.Bundle) == filepath.Clean(options.Target) {
		return fmt.Errorf("application update: the bundle and the target are the same folder %s", options.Target)
	}
	current, err := platform.Current()
	if err != nil {
		return err
	}
	ended, err := current.WaitProcessEnd(options.PID, options.Timeout)
	if err != nil {
		return fmt.Errorf("application update: %w", err)
	}
	if !ended {
		return fmt.Errorf("application update: process %d did not end within %s", options.PID, options.Timeout)
	}
	next, previous := options.Target+".new", options.Target+".previous"
	for _, stale := range []string{next, previous} {
		if err := os.RemoveAll(stale); err != nil {
			return fmt.Errorf("application update: %w", err)
		}
	}
	if err := current.CopyBundle(options.Bundle, next); err != nil {
		return errors.Join(fmt.Errorf("application update: copy the bundle: %w", err), os.RemoveAll(next))
	}
	if err := os.Rename(options.Target, previous); err != nil {
		return errors.Join(fmt.Errorf("application update: move the target aside: %w", err), os.RemoveAll(next))
	}
	if err := os.Rename(next, options.Target); err != nil {
		return errors.Join(fmt.Errorf("application update: move the new bundle: %w", err), os.Rename(previous, options.Target), os.RemoveAll(next))
	}
	if err := open(options.Target, options.Arguments); err != nil {
		restored := errors.Join(os.RemoveAll(options.Target), os.Rename(previous, options.Target))
		if restored == nil {
			restored = open(options.Target, options.Arguments)
		}
		return errors.Join(fmt.Errorf("application update: start the new bundle: %w", err), restored)
	}
	return errors.Join(os.RemoveAll(previous), os.RemoveAll(options.Bundle))
}

// runApp runs `sok app update --wait <pid> --bundle <path> --target <path> [-- <argument>...]`.
func runApp(args []string, stdout io.Writer) error {
	if len(args) == 0 || args[0] != "update" {
		return usage("unknown command: app %s", strings.Join(args, " "))
	}
	args = args[1:]
	var arguments []string
	if at := slices.Index(args, "--"); at >= 0 {
		args, arguments = args[:at], args[at+1:]
	}
	parsed, err := parse(args)
	if err != nil {
		return err
	}
	if len(parsed.positionals) > 0 {
		return usage("unexpected argument %s", parsed.positionals[0])
	}
	wait, err := parsed.required("wait")
	if err != nil {
		return err
	}
	pid, err := strconv.Atoi(wait)
	if err != nil || pid <= 0 {
		return usage("--wait must be the pid of a process")
	}
	bundle, err := parsed.required("bundle")
	if err != nil {
		return err
	}
	target, err := parsed.required("target")
	if err != nil {
		return err
	}
	current, err := platform.Current()
	if err != nil {
		return err
	}
	if err := ReplaceApp(ReplaceOptions{PID: pid, Bundle: bundle, Target: target, Arguments: arguments, Timeout: time.Minute}, current.OpenApplication); err != nil {
		return err
	}
	return printJSON(stdout, map[string]string{"target": target})
}
