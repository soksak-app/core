package sok

// 파일 오류의 문구(docs/spec/cli.md). 두 구현은 같은 실패를 같은 문구로 보고한다.

import (
	"errors"
	"fmt"
	"io/fs"
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
