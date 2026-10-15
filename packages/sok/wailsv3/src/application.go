package sok

import (
	"fmt"
	"os"
	"path/filepath"

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
