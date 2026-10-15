package sok

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// Located is an installed application that a locate entry found: its executable and the kind of the entry
// (docs/spec/installation.md#applications).
type Located struct {
	Path   string
	Method string
}

// LocateApplication tries each locate entry in order and returns the first application it finds: a bundle identifier
// through the metadata index of the platform, a name on the search path, or an absolute path of an executable file. The
// program, a path inside the installed folder, gives the executable of a found bundle. An entry that finds nothing
// passes to the next one; a failure of the platform is an error.
func LocateApplication(ways []map[string]string, program, search string) (Located, bool, error) {
	for index, way := range ways {
		switch {
		case way["bundle"] != "":
			current, err := platform.Current()
			if err != nil {
				return Located{}, false, fmt.Errorf("locate entry %d: %w", index, err)
			}
			bundle, found, err := current.ApplicationOfBundle(way["bundle"])
			if err != nil {
				return Located{}, false, fmt.Errorf("locate entry %d: %w", index, err)
			}
			if found {
				// The installed folder holds the bundle, so the program names the executable from the parent of the bundle.
				path := filepath.Join(filepath.Dir(bundle), program)
				if executableFile(path) {
					return Located{Path: path, Method: "bundle"}, true, nil
				}
			}
		case way["command"] != "":
			if path, ok := lookPath(way["command"], search); ok {
				return Located{Path: path, Method: "command"}, true, nil
			}
		case way["path"] != "":
			if executableFile(way["path"]) {
				return Located{Path: way["path"], Method: "path"}, true, nil
			}
		default:
			return Located{}, false, fmt.Errorf("locate entry %d is not one of bundle, command or path", index)
		}
	}
	return Located{}, false, nil
}

// lookPath finds an executable of the name in the folders of the search path. exec.LookPath reads PATH of the process
// and takes no search path, so the installer, which passes PATH, and the tests, which pass their own folders, use this.
func lookPath(name, search string) (string, bool) {
	for _, folder := range filepath.SplitList(search) {
		if folder == "" {
			continue
		}
		path := filepath.Join(folder, name)
		if executableFile(path) {
			return path, true
		}
	}
	return "", false
}

// executableFile reports whether the path is a regular file with an execute bit.
func executableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

// InstallApplicationRelease installs the application of a release recipe into the folder target, which does not exist
// yet: it downloads the release with the release limit of the fetcher, compares its SHA-256, and unpacks a zip with the
// bundle extraction of the platform, a tar.gz with its folders, files and symbolic links that stay inside the folder, or
// keeps the file as one executable named after the last segment of the address. A step that fails removes what it wrote
// and returns an error that names the step.
func InstallApplicationRelease(fetcher Fetcher, recipe map[string]string, target string) (err error) {
	address := recipe["url"]
	if err := CheckLocation(address); err != nil || !strings.HasPrefix(address, "https://") {
		return fmt.Errorf("application release %s: the address is not an https address", address)
	}
	data, err := fetcher.Read(address, fetcher.Release)
	if err != nil {
		return fmt.Errorf("application release download: %w", err)
	}
	digest := sha256.Sum256(data)
	if got := hex.EncodeToString(digest[:]); got != recipe["sha256"] {
		return fmt.Errorf("application release %s: sha256 %s is not %s", address, got, recipe["sha256"])
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fileError(filepath.Dir(target), err)
	}
	if _, err := os.Lstat(target); err == nil {
		return fmt.Errorf("application release: %s exists", target)
	}
	temp, err := os.MkdirTemp(filepath.Dir(target), "."+filepath.Base(target)+".*")
	if err != nil {
		return fileError(filepath.Dir(target), err)
	}
	defer func() {
		if err != nil {
			err = withCleanup(err, temp, os.RemoveAll)
		}
	}()
	switch recipe["unpack"] {
	case "zip":
		err = unpackZip(data, temp)
	case "tar.gz":
		err = unpackApplicationTar(data, temp)
	case "none":
		name := path.Base(strings.SplitN(address, "?", 2)[0])
		err = os.WriteFile(filepath.Join(temp, name), data, 0o755)
		if err == nil {
			err = os.Chmod(filepath.Join(temp, name), 0o755)
		}
	default:
		err = fmt.Errorf("unpack %q is not zip, tar.gz or none", recipe["unpack"])
	}
	if err != nil {
		return fmt.Errorf("application release unpack: %w", err)
	}
	if err := os.Rename(temp, target); err != nil {
		return fileError(target, err)
	}
	return nil
}

// unpackZip writes the zip next to the folder and extracts it with the bundle extraction of the platform, which keeps
// the modes, the symbolic links and the signature of an application bundle.
func unpackZip(data []byte, folder string) (err error) {
	file, err := os.CreateTemp(filepath.Dir(folder), ".release-*.zip")
	if err != nil {
		return fileError(filepath.Dir(folder), err)
	}
	defer func() {
		if removeErr := os.Remove(file.Name()); removeErr != nil && err == nil {
			err = fileError(file.Name(), removeErr)
		}
	}()
	if _, err := file.Write(data); err != nil {
		file.Close()
		return fileError(file.Name(), err)
	}
	if err := file.Close(); err != nil {
		return fileError(file.Name(), err)
	}
	current, err := platform.Current()
	if err != nil {
		return err
	}
	return current.ExtractBundle(file.Name(), folder)
}

// unpackApplicationTar extracts folders, regular files and symbolic links whose target stays inside the folder. An
// application release, unlike a plugin release, holds the symbolic links of its bundle.
func unpackApplicationTar(data []byte, folder string) error {
	zipped, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	reader := tar.NewReader(zipped)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(header.Name, "/")
		if name == "" || strings.HasPrefix(name, "/") || slices.Contains(strings.Split(name, "/"), "..") {
			return fmt.Errorf("release entry %s leaves the folder", header.Name)
		}
		where := filepath.Join(folder, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(where), 0o755); err != nil {
			return fileError(filepath.Dir(where), err)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(where, 0o755); err != nil {
				return fileError(where, err)
			}
		case tar.TypeReg:
			mode := os.FileMode(0o644)
			if header.Mode&0o111 != 0 {
				mode = 0o755
			}
			file, err := os.OpenFile(where, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				return fileError(where, err)
			}
			err = file.Chmod(mode)
			if err == nil {
				_, err = io.Copy(file, reader)
			}
			if closeErr := file.Close(); err == nil {
				err = closeErr
			}
			if err != nil {
				return fileError(where, err)
			}
		case tar.TypeSymlink:
			resolved := path.Clean(path.Join(path.Dir(name), header.Linkname))
			if path.IsAbs(header.Linkname) || resolved == ".." || strings.HasPrefix(resolved, "../") {
				return fmt.Errorf("release entry %s links outside the folder", name)
			}
			if err := os.Symlink(header.Linkname, where); err != nil {
				return fileError(where, err)
			}
		default:
			return fmt.Errorf("release entry %s is neither a folder, a regular file nor a symbolic link", header.Name)
		}
	}
}
