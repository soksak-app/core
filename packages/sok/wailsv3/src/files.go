package sok

// 파일 오류의 문구(docs/spec/cli.md). 두 구현은 같은 실패를 같은 문구로 보고한다.

import (
	"errors"
	"fmt"
	"io/fs"
	"syscall"
)

// fileError 는 path 의 파일 작업 실패를 "<path>: <이유>" 로 적는다. 이유는 운영체제 오류 문구이며 소문자로
// 시작한다. 원래 오류를 감싸므로 errors.Is(err, fs.ErrNotExist) 같은 검사는 그대로 쓴다.
func fileError(path string, err error) error {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		err = pathErr.Err
	}
	return fmt.Errorf("%s: %w", path, err)
}

// osReason 은 운영체제 오류의 이유 문구다. 시스템 호출 오류면 그 문구이고, 아니면 오류 문구 그대로다.
func osReason(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno.Error()
	}
	return err.Error()
}

// withCleanup 은 실패한 작업이 남긴 임시 경로를 remove 로 지운다. 지우지 못하면 원래 오류에 그 실패를
// "; cleanup <경로>: <이유>" 로 덧붙인다. 이미 없는 경로는 남은 것이 없으므로 지운 것과 같다.
func withCleanup(err error, temp string, remove func(string) error) error {
	if cleanupErr := remove(temp); cleanupErr != nil && !errors.Is(cleanupErr, fs.ErrNotExist) {
		return fmt.Errorf("%w; cleanup %w", err, fileError(temp, cleanupErr))
	}
	return err
}
