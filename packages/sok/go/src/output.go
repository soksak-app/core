package sok

// The output of the commands: the platform key on which sok runs, the replacement of a file in one step, and JSON
// results.

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/soksak-app/core/packages/sok/go/src/platform"
)

// CurrentPlatform is the platform key on which sok runs.
func CurrentPlatform() (string, error) {
	current, err := platform.Current()
	if err != nil {
		return "", err
	}
	return current.Key()
}

// readJSONFile reads one JSON file of the folder into the value that the format check uses.
func readJSONFile(dir, name string) (any, error) {
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return nil, fileError(filepath.Join(dir, name), err)
	}
	value, err := DecodeJSON(data)
	if err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", filepath.Join(dir, name), err)
	}
	return value, nil
}

// printJSON writes the result with two-space indentation. It turns off HTML escaping so that &, < and > of a path are
// written unchanged.
func printJSON(stdout io.Writer, value any) error {
	encoder := json.NewEncoder(stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

// replaceFile writes data to a temporary file in the same folder and then renames it, which replaces path in one step.
func replaceFile(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return fileError(path, err)
	}
	_, err = temp.Write(data)
	// The data is on disk before the rename replaces the destination, so a crash cannot leave a cut file; the twin of
	// this package in the other language syncs the same way.
	if err == nil {
		err = temp.Sync()
	}
	if closeErr := temp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temp.Name(), path)
	}
	if err != nil {
		return withCleanup(fileError(path, err), temp.Name(), os.Remove)
	}
	return nil
}
