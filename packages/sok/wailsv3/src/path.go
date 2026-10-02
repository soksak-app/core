package sok

// 이 command line 의 경로 항목(docs/spec/cli.md)을 쓰고 지운다. 항목은 paths.d 폴더의 <identifier> 파일이며 sok 이
// 있는 폴더를 한 줄로 담는다.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

func runPath(action string, stdout io.Writer, options Options) error {
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
		// 경로의 &, <, > 를 그대로 쓰도록 HTML escape 를 끈다. Rust 구현과 같은 출력이다.
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
