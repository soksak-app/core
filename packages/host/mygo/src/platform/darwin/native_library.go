//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

// The process owns the loaded code and its callback addresses until exit.
var nativeLibraryOnce sync.Once
var nativeLibraryHandle uintptr
var nativeLibraryError error

func nativeLibrary() (uintptr, error) {
	nativeLibraryOnce.Do(func() {
		path, err := nativeLibraryPath()
		if err != nil {
			nativeLibraryError = err
			return
		}
		nativeLibraryHandle, nativeLibraryError = purego.Dlopen(path, purego.RTLD_NOW|purego.RTLD_LOCAL)
		if nativeLibraryError != nil {
			nativeLibraryError = fmt.Errorf("load native library %s: %w", path, nativeLibraryError)
		}
	})
	return nativeLibraryHandle, nativeLibraryError
}

func nativeLibraryPath() (string, error) {
	path, specified := os.LookupEnv("SOKSAK_NATIVE_LIBRARY")
	if specified {
		if path == "" || !filepath.IsAbs(path) {
			return "", fmt.Errorf("SOKSAK_NATIVE_LIBRARY must name an absolute native library path")
		}
	} else {
		executable, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("locate native application executable: %w", err)
		}
		macos := filepath.Dir(executable)
		contents := filepath.Dir(macos)
		bundle := filepath.Dir(contents)
		if !filepath.IsAbs(executable) || filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(bundle) != ".app" {
			return "", fmt.Errorf("native library requires a standard .app/Contents/MacOS executable or absolute SOKSAK_NATIVE_LIBRARY")
		}
		path = filepath.Join(contents, "Frameworks", "libsoksak-darwin.dylib")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("native library %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("native library %s is not a regular file", path)
	}
	return path, nil
}

func requiredSymbol(library uintptr, name string) (uintptr, error) {
	address, err := purego.Dlsym(library, name)
	if err != nil {
		return 0, fmt.Errorf("native API %s: %w", name, err)
	}
	if address == 0 {
		return 0, fmt.Errorf("native API %s has a null address", name)
	}
	return address, nil
}

func callbackInstallError(message *byte) error {
	if message == nil {
		return nil
	}
	length := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(message), length)) != 0 {
		length++
	}
	return fmt.Errorf("native callback registration: %s", string(unsafe.Slice(message, length)))
}
