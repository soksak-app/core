//go:build !windows

package main

import (
	"fmt"
	"os"
	"syscall"
)

func directoryIdentity(_ string, info os.FileInfo) (string, error) {
	stat := info.Sys().(*syscall.Stat_t)
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}
