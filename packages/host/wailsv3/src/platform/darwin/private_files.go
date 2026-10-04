//go:build darwin

package darwin

import "os"

// CreatePrivateDirectories 는 path 에서 없는 디렉터리를 mode 0700 으로 만든다. 이미 있는 디렉터리의 권한은
// 바꾸지 않는다.
func (implementation) CreatePrivateDirectories(path string) error {
	return os.MkdirAll(path, 0o700)
}

// AppendPrivateFile 은 path 의 파일을 덧붙이기로 연다. 없으면 mode 0600 으로 만든다. 있는 파일의 권한은 바꾸지
// 않는다.
func (implementation) AppendPrivateFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

// CreatePrivateFile 은 path 에 mode 0600 의 새 파일을 만들어 쓰기로 연다. path 가 이미 있으면 os.ErrExist 인
// 오류다.
func (implementation) CreatePrivateFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
}

// SecureServiceDirectory 는 영구 service 디렉터리 path 의 권한을 0700 으로 바꾼다.
func (implementation) SecureServiceDirectory(path string) error {
	return os.Chmod(path, 0o700)
}

// PrivateDirectory 는 path 를 현재 사용자만 접근할 수 있는 디렉터리로 만들고, 이미 있으면 종류, 소유자, 권한을
// 확인한다.
func (implementation) PrivateDirectory(path string) error {
	return privateDirectory(path)
}
