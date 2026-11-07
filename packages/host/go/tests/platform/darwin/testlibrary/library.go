//go:build darwin

// Package testlibrary loads explicitly configured native test artifacts.
package testlibrary

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

type loadedLibrary struct {
	handle uintptr
	err    error
}

var libraryMu sync.Mutex
var libraries = map[string]loadedLibrary{}

// Open requires an explicit absolute artifact path. Handles are retained for
// process lifetime; there is no source-tree search or alternate binding path.
func Open(variable string) (uintptr, error) {
	path, specified := os.LookupEnv(variable)
	if !specified || path == "" || !filepath.IsAbs(path) {
		return 0, fmt.Errorf("%s must name an absolute native library path", variable)
	}
	libraryMu.Lock()
	defer libraryMu.Unlock()
	if loaded, exists := libraries[path]; exists {
		return loaded.handle, loaded.err
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0, fmt.Errorf("%s native library %s: %w", variable, path, err)
	}
	if !info.Mode().IsRegular() {
		return 0, fmt.Errorf("%s native library %s is not a regular file", variable, path)
	}
	handle, err := purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		err = fmt.Errorf("%s load native library %s: %w", variable, path, err)
	}
	libraries[path] = loadedLibrary{handle, err}
	return handle, err
}

// Symbol returns a required native address without constructing a Go callback.
func Symbol(library uintptr, name string) (uintptr, error) {
	address, err := purego.Dlsym(library, name)
	if err != nil {
		return 0, fmt.Errorf("native test symbol %s: %w", name, err)
	}
	if address == 0 {
		return 0, fmt.Errorf("native test symbol %s has a null address", name)
	}
	return address, nil
}

// Error copies a borrowed, nullable native error string before returning.
func Error(message *byte) error {
	if message == nil {
		return nil
	}
	length := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(message), length)) != 0 {
		length++
	}
	return fmt.Errorf("native test registration: %s", string(unsafe.Slice(message, length)))
}
