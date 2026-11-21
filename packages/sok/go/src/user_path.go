package sok

// Reconciles the user PATH registration shared by the macOS hosts (docs/spec/cli.md#user-path-registration).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"

	"github.com/soksak-app/core/packages/sok/go/src/platform"
)

const (
	pathBlockStart = "# >>> soksak PATH >>>"
	pathBlockEnd   = "# <<< soksak PATH <<<"
	pathPosixBlock = pathBlockStart + "\n" +
		"case \":${PATH-}:\" in\n" +
		"  *\":$HOME/.local/bin:\"*) ;;\n" +
		"  *) export PATH=\"${PATH:+$PATH:}$HOME/.local/bin\" ;;\n" +
		"esac\n" + pathBlockEnd + "\n"
	pathFishBlock = pathBlockStart + "\n" +
		"fish_add_path --path --append \"$HOME/.local/bin\"\n" + pathBlockEnd + "\n"
)

type userPathRecord struct {
	Format int `json:"format"`
	Path   struct {
		Enabled  *bool    `json:"enabled"`
		Profiles []string `json:"profiles"`
	} `json:"path"`
}

type userPathFiles struct {
	record string
	public string
	target string
}

func pathsForUser(home string) userPathFiles {
	return userPathFiles{
		record: filepath.Join(home, "Library", "Application Support", "app.soksak", "agent-setup.json"),
		public: filepath.Join(home, ".local", "bin", "sok"),
		target: filepath.Join(home, ".local", "share", "soksak", "sok"),
	}
}

func userPathHome(environment AgentEnvironment) (string, error) {
	home, err := environment.home()
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(home) {
		return "", fmt.Errorf("HOME is not an absolute path: %s", home)
	}
	return home, nil
}

func readUserPathRecord(file string) (record userPathRecord, present bool, err error) {
	data, _, err := readPathFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		enabled := true
		record.Format, record.Path.Enabled, record.Path.Profiles = 1, &enabled, []string{}
		return record, false, nil
	}
	if err != nil {
		return record, false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	valid := decoder.Decode(&record) == nil
	_, trailing := decoder.Token()
	valid = valid && errors.Is(trailing, io.EOF) && record.Format == 1 &&
		record.Path.Enabled != nil && record.Path.Profiles != nil
	seen := map[string]bool{}
	for _, profile := range record.Path.Profiles {
		valid = valid && filepath.IsAbs(profile) && !seen[profile] && isPathProfile(profile)
		seen[profile] = true
	}
	if !valid {
		return record, true, fmt.Errorf("%s: expected user PATH registration format 1, found %s", file, lockReport(data))
	}
	return record, true, nil
}

func writeUserPathRecord(file string, record userPathRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return fileError(file, err)
	}
	return replaceFile(file, append(data, '\n'))
}

var errPathConflict = errors.New("conflicts with soksak PATH registration")

func userPathConflict(file string) error {
	return fileError(file, errPathConflict)
}

func readPathFile(file string) ([]byte, fs.FileMode, error) {
	info, err := os.Lstat(file)
	if err != nil {
		return nil, 0, fileError(file, err)
	}
	if !info.Mode().IsRegular() {
		return nil, 0, userPathConflict(file)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, 0, fileError(file, err)
	}
	return data, info.Mode().Perm(), nil
}

// linkDestination reads the exact target, with an empty target for an absent path. A regular file or directory is a conflict.
func linkDestination(file string) (string, error) {
	info, err := os.Lstat(file)
	if errors.Is(err, fs.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", fileError(file, err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return "", userPathConflict(file)
	}
	destination, err := os.Readlink(file)
	if err != nil {
		return "", fileError(file, err)
	}
	return destination, nil
}

func isSoksakExecutable(system platform.Platform, executable string) bool {
	return filepath.IsAbs(executable) && filepath.Base(executable) == "sok" && system.RegisteredSok(executable) == nil
}

func pathExecutable(system platform.Platform, environment AgentEnvironment) (string, error) {
	executable, err := findOnPath(environment.path(), "sok")
	if err != nil {
		return "", err
	}
	if executable != "" && !isSoksakExecutable(system, executable) {
		return "", userPathConflict(executable)
	}
	return executable, nil
}

// UserPathState reads the desired state and the effective command of the supplied login shell without writing files.
func UserPathState(environment AgentEnvironment) (SetupPart, error) {
	home, err := userPathHome(environment)
	if err != nil {
		return SetupPart{}, err
	}
	files := pathsForUser(home)
	record, _, err := readUserPathRecord(files.record)
	if err != nil {
		return SetupPart{}, err
	}
	part := SetupPart{Part: "path", File: files.public, State: "ok", Enabled: record.Path.Enabled}
	system, err := platform.Current()
	if err != nil {
		return SetupPart{}, err
	}
	if !*record.Path.Enabled {
		owned, err := userPathRemains(system, files, record.Path.Profiles)
		if err != nil {
			part.State, part.Error = "error", err.Error()
		} else if owned {
			part.State, part.Reason = "missing", "differs"
		}
		return part, nil
	}
	executable, err := pathExecutable(system, environment)
	switch {
	case err != nil:
		part.State, part.Error = "error", err.Error()
	case executable == "":
		part.State, part.Reason = "missing", "absent"
	default:
		part.File = executable
	}
	return part, nil
}

func userPathRemains(system platform.Platform, files userPathFiles, profiles []string) (bool, error) {
	public, err := linkDestination(files.public)
	if err == nil && public == files.target {
		return true, nil
	}
	// default: a file installed by someone else in the public folder does not belong to this registration.
	if err != nil && !errors.Is(err, errPathConflict) {
		return false, err
	}
	if public == "" && err == nil {
		target, err := linkDestination(files.target)
		if err != nil {
			return false, err
		}
		if target != "" {
			if !isSoksakExecutable(system, target) {
				return false, userPathConflict(files.target)
			}
			return true, nil
		}
	}
	for _, profile := range profiles {
		content, _, err := readPathFile(profile)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		_, found, err := withoutPathBlock(profile, content)
		if found || err != nil {
			return found, err
		}
	}
	return false, nil
}

func isPathProfile(file string) bool {
	switch filepath.Base(file) {
	case ".zshrc", ".bash_profile", ".bash_login", ".profile", ".bashrc", "soksak-path.fish":
		return true
	}
	return false
}

func userPathProfiles(environment AgentEnvironment, home, shell string) ([]string, error) {
	switch filepath.Base(shell) {
	case "zsh":
		directory := environment.Variables["ZDOTDIR"]
		if directory == "" {
			directory = home
		}
		if !filepath.IsAbs(directory) {
			return nil, fmt.Errorf("ZDOTDIR is not an absolute path: %s", directory)
		}
		return []string{filepath.Join(directory, ".zshrc")}, nil
	case "bash":
		login := filepath.Join(home, ".bash_profile")
		for _, name := range []string{".bash_profile", ".bash_login", ".profile"} {
			candidate := filepath.Join(home, name)
			if _, err := os.Lstat(candidate); err == nil {
				login = candidate
				break
			} else if !errors.Is(err, fs.ErrNotExist) {
				return nil, fileError(candidate, err)
			}
		}
		return []string{login, filepath.Join(home, ".bashrc")}, nil
	case "fish":
		directory := environment.Variables["XDG_CONFIG_HOME"]
		if !filepath.IsAbs(directory) {
			// default: a missing, empty or relative XDG_CONFIG_HOME selects the user's default XDG configuration folder.
			directory = filepath.Join(home, ".config")
		}
		return []string{filepath.Join(directory, "fish", "conf.d", "soksak-path.fish")}, nil
	}
	return nil, fmt.Errorf("the login shell %s does not support soksak PATH registration", shell)
}

func pathBlock(profile string) []byte {
	if filepath.Base(profile) == "soksak-path.fish" {
		return []byte(pathFishBlock)
	}
	return []byte(pathPosixBlock)
}

func withoutPathBlock(profile string, content []byte) ([]byte, bool, error) {
	block := pathBlock(profile)
	switch start, stops := bytes.Count(content, []byte(pathBlockStart)), bytes.Count(content, []byte(pathBlockEnd)); {
	case start == 0 && stops == 0:
		return content, false, nil
	case start != 1 || stops != 1:
		return nil, false, fmt.Errorf("%s: contains a modified soksak PATH block", profile)
	}
	index := bytes.Index(content, block)
	if index < 0 || index > 0 && content[index-1] != '\n' {
		return nil, false, fmt.Errorf("%s: contains a modified soksak PATH block", profile)
	}
	if bytes.Equal(content, block) {
		return nil, true, nil
	}
	end := index + len(block)
	if index > 0 {
		// Keep a separator when a later user edit added commands below the block and its removal would join two lines.
		if end == len(content) || index == 1 || content[index-2] == '\n' || content[end] == '\n' {
			index--
		}
	}
	remaining := make([]byte, 0, index+len(content)-end)
	remaining = append(remaining, content[:index]...)
	return append(remaining, content[end:]...), true, nil
}

func editUserPathProfile(profile string, install bool) (bool, error) {
	content, mode, err := readPathFile(profile)
	if errors.Is(err, fs.ErrNotExist) {
		if !install {
			return false, nil
		}
		if err := makePathParents(profile); err != nil {
			return false, err
		}
		if err := replaceFile(profile, pathBlock(profile)); err != nil {
			return false, err
		}
		return true, nil
	}
	if err != nil {
		return false, err
	}
	remaining, found, err := withoutPathBlock(profile, content)
	if err != nil || found == install {
		return false, err
	}
	if install {
		remaining = append(append(content, '\n'), pathBlock(profile)...)
	}
	if remaining == nil {
		if err := deletePathFile(profile); err != nil {
			return false, err
		}
		return true, nil
	}
	if err := replaceFileMode(profile, remaining, mode); err != nil {
		return false, err
	}
	return true, nil
}

func makePathParents(file string) error {
	parent := filepath.Dir(file)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fileError(parent, err)
	}
	return nil
}

func deletePathFile(file string) error {
	if err := os.Remove(file); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fileError(file, err)
	}
	return nil
}

// ConfigureUserPath persists an explicit desired state and reconciles it. A nil enabled value uses the stored state.
// The caller reads a fresh shell after a change before publishing the result.
func ConfigureUserPath(environment AgentEnvironment, shell, executable string, enabled *bool) (changed bool, err error) {
	home, err := userPathHome(environment)
	if err != nil {
		return false, err
	}
	if os.Geteuid() == 0 {
		return false, errors.New("user PATH registration cannot be changed as root")
	}
	system, err := platform.Current()
	if err != nil {
		return false, err
	}
	files := pathsForUser(home)
	_, present, err := readUserPathRecord(files.record)
	if err != nil {
		return false, err
	}
	if enabled == nil && !present {
		first, err := pathExecutable(system, environment)
		if first != "" || err != nil {
			return false, err
		}
	}
	lockPath := filepath.Join(filepath.Dir(files.record), "agent-setup.lock")
	if err := makePathParents(lockPath); err != nil {
		return false, err
	}
	lock, err := system.OpenAgentSetupLockFile(lockPath)
	if err != nil {
		return false, fileError(lockPath, err)
	}
	defer func() {
		if closeErr := lock.Close(); closeErr != nil {
			err = errors.Join(err, fileError(lockPath, closeErr))
		}
	}()
	if info, err := lock.Stat(); err != nil {
		return false, fileError(lockPath, err)
	} else if !info.Mode().IsRegular() {
		return false, userPathConflict(lockPath)
	}
	if err := system.LockFile(lock); err != nil {
		return false, err
	}
	record, present, err := readUserPathRecord(files.record)
	if err != nil {
		return false, err
	}
	if enabled != nil && (!present || *enabled != *record.Path.Enabled) {
		record.Path.Enabled = enabled
		if err := writeUserPathRecord(files.record, record); err != nil {
			return false, err
		}
		changed = true
	}
	if !*record.Path.Enabled {
		edited, err := disableUserPath(system, files, record)
		return changed || edited, err
	}
	edited, err := enableUserPath(system, files, record, environment, home, shell, executable)
	return changed || edited, err
}

func disableUserPath(system platform.Platform, files userPathFiles, record userPathRecord) (bool, error) {
	changed := false
	var failure error
	public, err := linkDestination(files.public)
	removeTarget := err == nil && (public == "" || public == files.target)
	if err == nil && public == files.target {
		err = deletePathFile(files.public)
		changed = err == nil
		removeTarget = changed
	}
	// default: a file installed by someone else in the public folder does not belong to this registration.
	if err != nil && !errors.Is(err, errPathConflict) {
		failure = err
	}
	if removeTarget {
		target, err := linkDestination(files.target)
		if err == nil && target != "" {
			if isSoksakExecutable(system, target) {
				err = deletePathFile(files.target)
				changed = changed || err == nil
			} else {
				err = userPathConflict(files.target)
			}
		}
		failure = errors.Join(failure, err)
	}
	retained := []string{}
	for _, profile := range record.Path.Profiles {
		edited, err := editUserPathProfile(profile, false)
		if err != nil {
			retained = append(retained, profile)
			failure = errors.Join(failure, err)
		} else {
			changed = changed || edited
		}
	}
	if !slices.Equal(retained, record.Path.Profiles) {
		record.Path.Profiles = retained
		err := writeUserPathRecord(files.record, record)
		changed = changed || err == nil
		failure = errors.Join(failure, err)
	}
	return changed, failure
}

func enableUserPath(system platform.Platform, files userPathFiles, record userPathRecord, environment AgentEnvironment, home, shell, executable string) (bool, error) {
	first, err := pathExecutable(system, environment)
	if err != nil || first != "" {
		return false, err
	}
	public, err := linkDestination(files.public)
	if err != nil {
		return false, err
	}
	if public != "" && public != files.target {
		return false, userPathConflict(files.public)
	}
	target, err := linkDestination(files.target)
	if err != nil {
		return false, err
	}
	if target != "" && !isSoksakExecutable(system, target) {
		return false, userPathConflict(files.target)
	}
	bin := filepath.Dir(files.public)
	var profiles []string
	if !slices.Contains(filepath.SplitList(environment.path()), bin) {
		profiles, err = userPathProfiles(environment, home, shell)
		if err != nil {
			return false, err
		}
	}
	targetCurrent := false
	if target != "" {
		if info, err := os.Stat(target); err == nil {
			if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
				return false, userPathConflict(files.target)
			}
			resolved, err := filepath.EvalSymlinks(target)
			if err != nil {
				return false, fileError(target, err)
			}
			if !isSoksakExecutable(system, resolved) {
				return false, userPathConflict(files.target)
			}
			if err := RequireWritableVolume(resolved); err != nil {
				return false, err
			}
			targetCurrent = true
		} else if !errors.Is(err, fs.ErrNotExist) {
			return false, fileError(target, err)
		}
	}
	changed := false
	if !targetCurrent {
		canonical, err := filepath.EvalSymlinks(executable)
		if err != nil {
			return false, fileError(executable, err)
		}
		if err := system.RegisteredSok(canonical); err != nil {
			return false, err
		}
		info, err := os.Stat(canonical)
		if err != nil {
			return false, fileError(canonical, err)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 || filepath.Base(canonical) != "sok" {
			return false, fmt.Errorf("%s: expected an executable sok", canonical)
		}
		if err := RequireWritableVolume(canonical); err != nil {
			return false, err
		}
		if err := updatePathTarget(files.target, target, canonical); err != nil {
			return false, err
		}
		changed = true
	}
	if profiles != nil {
		edited, err := reconcileUserPathProfiles(files.record, record, profiles)
		changed = changed || edited
		if err != nil {
			return changed, err
		}
	}
	if public == "" {
		if err := makePathParents(files.public); err != nil {
			return changed, err
		}
		if err := os.Symlink(files.target, files.public); err != nil {
			return changed, fileError(files.public, unwrapPath(err))
		}
		changed = true
	}
	return changed, nil
}

func reconcileUserPathProfiles(file string, record userPathRecord, profiles []string) (bool, error) {
	owned := slices.Clone(record.Path.Profiles)
	changed := false
	for _, profile := range profiles {
		if !slices.Contains(owned, profile) {
			owned = append(owned, profile)
		}
	}
	if !slices.Equal(owned, record.Path.Profiles) {
		record.Path.Profiles = owned
		if err := writeUserPathRecord(file, record); err != nil {
			return false, err
		}
		changed = true
	}
	for _, profile := range profiles {
		edited, err := editUserPathProfile(profile, true)
		changed = changed || edited
		if err != nil {
			return changed, err
		}
	}
	if !slices.Equal(owned, profiles) {
		for _, profile := range owned {
			if !slices.Contains(profiles, profile) {
				edited, err := editUserPathProfile(profile, false)
				changed = changed || edited
				if err != nil {
					return changed, err
				}
			}
		}
		record.Path.Profiles = profiles
		if err := writeUserPathRecord(file, record); err != nil {
			return changed, err
		}
		changed = true
	}
	return changed, nil
}

func updatePathTarget(file, previous, executable string) error {
	if err := makePathParents(file); err != nil {
		return err
	}
	if previous == "" {
		if err := os.Symlink(executable, file); err != nil {
			return fileError(file, unwrapPath(err))
		}
		return nil
	}
	directory, err := os.MkdirTemp(filepath.Dir(file), ".sok.")
	if err != nil {
		return fileError(file, err)
	}
	link := filepath.Join(directory, "sok")
	if err := os.Symlink(executable, link); err != nil {
		return withCleanup(fileError(file, unwrapPath(err)), directory, os.Remove)
	}
	if err := os.Rename(link, file); err != nil {
		return withCleanup(withCleanup(fileError(file, unwrapPath(err)), link, os.Remove), directory, os.Remove)
	}
	return deletePathFile(directory)
}
