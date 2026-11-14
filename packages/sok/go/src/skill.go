package sok

// Writes the agent skill into the skill folder of each agent folder that exists (docs/spec/cli.md#agent-skill).

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// SkillFile is one skill file that an install wrote (`written`) or found equal to the skill text (`current`).
type SkillFile struct {
	File  string `json:"file"`
	State string `json:"state"`
}

// NoAgentFolderError is the failure of a skill install without an agent folder. `sok mcp` and the host bring the skill current
// without it being an error.
type NoAgentFolderError struct{ Folders []string }

func (e *NoAgentFolderError) Error() string {
	return fmt.Sprintf("no agent folder: neither %s is a directory; sok skill print writes the skill to standard output", strings.Join(e.Folders, " nor "))
}

// SkillWriteError is a skill file that an install could not write, with the reason of the operating system.
type SkillWriteError struct {
	File string
	Err  error
}

func (e *SkillWriteError) Error() string { return e.File + ": " + e.Err.Error() }

func (e *SkillWriteError) Unwrap() error { return e.Err }

// SkillWriteErrors are the skill files that an install could not write, in the order of the agent folders.
type SkillWriteErrors []*SkillWriteError

func (e SkillWriteErrors) Error() string {
	texts := make([]string, len(e))
	for n, failure := range e {
		texts[n] = failure.Error()
	}
	return strings.Join(texts, "; ")
}

func (e SkillWriteErrors) Unwrap() []error {
	errs := make([]error, len(e))
	for n, failure := range e {
		errs[n] = failure
	}
	return errs
}

// skillFolder is one agent folder that exists, with its skill file and the canonical path of its skill folder.
type skillFolder struct {
	file      string
	canonical string
}

// agentFolders are the agent folders in their order: <home>/.claude, $CLAUDE_CONFIG_DIR when it is set and not empty, and
// <home>/.agents.
func (s Setup) agentFolders() ([]string, error) {
	home, err := s.Environment.home()
	if err != nil {
		return nil, err
	}
	folders := []string{filepath.Join(home, ".claude")}
	if dir := s.Environment.claudeConfigDir(); dir != "" {
		folders = append(folders, dir)
	}
	return append(folders, filepath.Join(home, ".agents")), nil
}

// skillFolders are the skill folders of the agent folders that are directories after symbolic links are followed, each canonical
// skill folder once at its first place.
func (s Setup) skillFolders() ([]skillFolder, []string, error) {
	folders, err := s.agentFolders()
	if err != nil {
		return nil, nil, err
	}
	var found []skillFolder
	seen := map[string]bool{}
	for _, folder := range folders {
		info, err := os.Stat(folder)
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) || (err == nil && !info.IsDir()) {
			continue
		}
		if err != nil {
			return nil, nil, fileError(folder, err)
		}
		dir := filepath.Join(folder, "skills", skillName)
		canonical, err := canonicalPath(dir)
		if err != nil {
			return nil, nil, err
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		found = append(found, skillFolder{file: filepath.Join(dir, "SKILL.md"), canonical: canonical})
	}
	return found, folders, nil
}

// canonicalPath resolves the symbolic links of the longest existing part of the path and keeps the missing rest as it is.
func canonicalPath(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", fileError(path, err)
	}
	parent := filepath.Dir(path)
	if parent == path {
		return path, nil
	}
	resolved, err = canonicalPath(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(path)), nil
}

// InstallSkills writes the skill file of each agent folder that exists and leaves a current one unchanged. It creates the missing
// skill folders of every agent folder before it writes a file, because an agent follows changes of its skills folder only when
// that folder existed at the start of its session. A skill file that it cannot write does not stop the others: it returns the files
// that it wrote or found current with SkillWriteErrors that name each other skill file. No agent folder is a *NoAgentFolderError.
func (s Setup) InstallSkills() ([]SkillFile, error) {
	folders, agentFolders, err := s.skillFolders()
	if err != nil {
		return nil, err
	}
	if len(folders) == 0 {
		return nil, &NoAgentFolderError{Folders: agentFolders}
	}
	failed := make([]*SkillWriteError, len(folders))
	for n, folder := range folders {
		if err := os.MkdirAll(filepath.Dir(folder.file), 0o755); err != nil {
			failed[n] = &SkillWriteError{File: folder.file, Err: unwrapPath(err)}
		}
	}
	files := []SkillFile{}
	var failures SkillWriteErrors
	for n, folder := range folders {
		if failed[n] != nil {
			failures = append(failures, failed[n])
			continue
		}
		state, err := writeSkill(folder.file)
		if err != nil {
			failures = append(failures, &SkillWriteError{File: folder.file, Err: err})
			continue
		}
		files = append(files, SkillFile{File: folder.file, State: state})
	}
	if failures != nil {
		return files, failures
	}
	return files, nil
}

// writeSkill writes the skill text to file through a temporary file of its folder, renamed over the file at mode 0644, unless the
// file already holds it. Its error is the reason of the operating system without the path of the file.
func writeSkill(file string) (string, error) {
	current, err := os.ReadFile(file)
	if err == nil && bytes.Equal(current, []byte(SkillText)) {
		return "current", nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", unwrapPath(err)
	}
	temp, err := os.CreateTemp(filepath.Dir(file), ".SKILL.md.*")
	if err != nil {
		return "", unwrapPath(err)
	}
	_, err = temp.WriteString(SkillText)
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(temp.Name(), 0o644)
	}
	if err == nil {
		err = os.Rename(temp.Name(), file)
	}
	if err != nil {
		return "", withCleanup(unwrapPath(err), temp.Name(), os.Remove)
	}
	return "written", nil
}

// skillState is the state of one skill file for the setup check.
func skillState(file string) (state, reason string, err error) {
	current, err := os.ReadFile(file)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "missing", "absent", nil
	case err != nil:
		return "", "", fileError(file, err)
	case bytes.Equal(current, []byte(SkillText)):
		return "ok", "", nil
	}
	return "missing", "differs", nil
}

// unwrapPath is the reason of a path error without its path, which the error that reports it names.
func unwrapPath(err error) error {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err
	}
	var linkErr *os.LinkError
	if errors.As(err, &linkErr) {
		return linkErr.Err
	}
	return err
}
