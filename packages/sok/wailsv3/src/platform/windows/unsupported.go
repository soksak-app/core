//go:build windows

package windows

import (
	"errors"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

type windows struct{}

func init() { platform.Register(windows{}) }

func (windows) ProcessRunning(int) error {
	return errors.New("process check is not implemented on windows")
}

func (windows) Key() (string, error) {
	return "", errors.New("platform key is not implemented on windows")
}

func (windows) PathsDir() (string, error) {
	return "", errors.New("path entries are not implemented on windows")
}
