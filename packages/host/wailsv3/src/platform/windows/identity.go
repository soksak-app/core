//go:build windows

package windows

import (
	"fmt"
	"os"

	sys "golang.org/x/sys/windows"
)

// DirectoryIdentity 는 볼륨 일련번호와 파일 인덱스로 디렉터리를 식별한다.
func (implementation) DirectoryIdentity(path string, _ os.FileInfo) (string, error) {
	name, err := sys.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := sys.CreateFile(name, 0, sys.FILE_SHARE_READ|sys.FILE_SHARE_WRITE|sys.FILE_SHARE_DELETE, nil, sys.OPEN_EXISTING, sys.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer sys.CloseHandle(handle)
	var info sys.ByHandleFileInformation
	if err := sys.GetFileInformationByHandle(handle, &info); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d", info.VolumeSerialNumber, uint64(info.FileIndexHigh)<<32|uint64(info.FileIndexLow)), nil
}
