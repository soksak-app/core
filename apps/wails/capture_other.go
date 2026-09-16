//go:build !darwin

package main

// macOS 만 구현되어 있다. Windows 는 Windows.Graphics.Capture, Linux 는 PipeWire
// 포털이 같은 자리에 해당한다.

func captureOpen(windowNumber int) {}

func captureStart(directory string) {}
func captureWait() bool             { return false }

func captureStop() int { return 0 }
