package sok

// Writes and removes the path entry of this command line (docs/spec/cli.md). The entry is the file <identifier> in the
// paths.d folder and holds the folder of sok in one line.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func runPath(action string, stdout io.Writer, options Options) error {
	if options.PathsError != nil {
		return options.PathsError
	}
	file := filepath.Join(options.PathsDir, options.Identifier)
	switch action {
	case "install":
		executable, err := os.Executable()
		if err != nil {
			return fmt.Errorf("the location of sok is unknown: %w", err)
		}
		executable, err = filepath.EvalSymlinks(executable)
		if err != nil {
			return fmt.Errorf("the location of sok is unknown: %w", err)
		}
		directory := filepath.Dir(executable)
		if err := os.WriteFile(file, []byte(directory+"\n"), 0o644); err != nil {
			return fmt.Errorf("cannot write %w; run sudo sok path install", fileError(file, err))
		}
		// Turns off HTML escaping so that &, < and > of a path are written unchanged. The output is the same as that of the
		// Rust implementation.
		encoder := json.NewEncoder(stdout)
		encoder.SetEscapeHTML(false)
		encoder.SetIndent("", "  ")
		return encoder.Encode(map[string]string{"path": file, "directory": directory})
	case "remove":
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("cannot remove %w; run sudo sok path remove", fileError(file, err))
		}
		_, err := fmt.Fprintln(stdout, "null")
		return err
	}
	return usage("unknown path action: %s", action)
}
