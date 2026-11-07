//go:build darwin

// Package darwin holds native support for the tests of the mygo host.
package darwin

import (
	"errors"
	"unsafe"
)

// Frame is a supplier's transfer image: an IOSurface carrying its region nonce.
type Frame struct {
	surface unsafe.Pointer
}

// NewFrame creates a native frame. Standalone frame consumers initialize test
// support on demand and receive any artifact or binding error explicitly.
func NewFrame(width, height int, nonce [16]byte) (*Frame, error) {
	if err := InstallTestSupport(); err != nil {
		return nil, err
	}
	surface := supportFunctions.SpHostTestFrameCreate(int32(width), int32(height), &nonce[0])
	if surface == nil {
		return nil, errors.New("cannot create an IOSurface")
	}
	return &Frame{surface: surface}, nil
}

// ID is the global identifier carried by a transfer token.
func (frame *Frame) ID() uint32 { return supportFunctions.SpHostTestFrameId(frame.surface) }

// InUse reports whether a window-server layer presents the frame.
func (frame *Frame) InUse() bool { return supportFunctions.SpHostTestFrameInUse(frame.surface) }

// Close releases the supplier's native reference.
func (frame *Frame) Close() { supportFunctions.SpHostTestFrameRelease(frame.surface) }
