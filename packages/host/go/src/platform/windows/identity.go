//go:build windows

package windows

import (
	"fmt"
	"os"
	"regexp"

	sys "golang.org/x/sys/windows"
)

// directoryIdentityPattern is the form that DirectoryIdentity returns: the decimal volume serial number, a colon and the decimal file index.
var directoryIdentityPattern = regexp.MustCompile(`^[0-9]+:[0-9]+$`)

// DirectoryIdentityForm names the form that DirectoryIdentity returns.
func (implementation) DirectoryIdentityForm() string {
	return "<volume serial number>:<file index>"
}

// ValidDirectoryIdentity reports whether identity has the form that DirectoryIdentity returns.
func (implementation) ValidDirectoryIdentity(identity string) bool {
	return directoryIdentityPattern.MatchString(identity)
}

// DirectoryIdentity identifies a directory by the volume serial number and the file index.
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
