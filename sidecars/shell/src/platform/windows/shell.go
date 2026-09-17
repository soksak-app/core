//go:build windows

package windows

import (
	"errors"
	"os/exec"

	"github.com/min-median-max/soksak/sidecars/shell/src/platform"
)

type implementation struct{}

func init() { platform.Register(implementation{}) }

var errMissing = errors.New("shell sessions are not implemented on windows")

func (implementation) Session() (*exec.Cmd, error)   { return nil, errMissing }
func (implementation) Setup() string                 { return "" }
func (implementation) DirectoryReport() string       { return "" }
func (implementation) Run(string) (*exec.Cmd, error) { return nil, errMissing }
func (implementation) Interrupt(int) error           { return errMissing }
func (implementation) Terminate(int) error           { return errMissing }
func (implementation) Children(int) (int, error)     { return 0, errMissing }
