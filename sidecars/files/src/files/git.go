package files

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// GitEntry 는 git 상태가 있는 경로 하나다. 경로는 root 기준이다.
type GitEntry struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

// notRepository 는 git 이 저장소 밖에서 실행되었을 때의 종료 코드다.
const notRepository = 128

// GitStatus 는 root 의 git 상태를 root 기준 경로로 반환한다. root 가 저장소 안에 있지 않거나 git 이
// 설치되지 않았으면 빈 목록이다(docs/spec/sidecars.md#files). 다른 실패는 오류다.
func GitStatus(root string) ([]GitEntry, error) {
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	top, err := git(base, "rev-parse", "--show-toplevel")
	if err != nil {
		var exit *exec.ExitError
		if errors.Is(err, exec.ErrNotFound) || (errors.As(err, &exit) && exit.ExitCode() == notRepository) {
			return []GitEntry{}, nil
		}
		return nil, err
	}
	topDir, err := filepath.EvalSymlinks(strings.TrimSpace(string(top)))
	if err != nil {
		return nil, err
	}
	out, err := git(base, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	entries := []GitEntry{}
	fields := strings.Split(string(out), "\x00")
	for i := 0; i < len(fields); i++ {
		field := fields[i]
		if len(field) < 4 {
			continue
		}
		code, path := field[:2], field[3:]
		// 이름 바꾸기와 복사는 다음 필드에 원래 경로를 둔다.
		if code[0] == 'R' || code[0] == 'C' {
			i++
		}
		status := statusOf(code)
		if status == "" {
			continue
		}
		rel, err := filepath.Rel(base, filepath.Join(topDir, path))
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		entries = append(entries, GitEntry{Path: filepath.ToSlash(rel), Status: status})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return entries, nil
}

// statusOf 는 porcelain v1 의 두 글자 상태를 트리 상태로 바꾼다. 무시된 파일은 빈 문자열이다.
func statusOf(code string) string {
	switch {
	case code == "??":
		return "untracked"
	case code == "!!":
		return ""
	case code[0] == 'R':
		return "renamed"
	case code[0] == 'A':
		return "added"
	case code[0] == 'D' || code[1] == 'D':
		return "deleted"
	default:
		return "modified"
	}
}

func git(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
		}
		return nil, err
	}
	return out, nil
}
