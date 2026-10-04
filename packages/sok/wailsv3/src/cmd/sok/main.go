// sok 은 Wails 애플리케이션의 command line 이다(docs/spec/cli.md).
package main

import (
	"fmt"
	"os"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/linux"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/windows"
)

func main() {
	system, err := platform.Current()
	if err != nil {
		fmt.Fprintf(os.Stderr, "sok: %v\n", err)
		os.Exit(1)
	}
	paths, pathsErr := system.PathsDir()
	// 식별자는 기본 설정 폴더와 경로 항목의 이름이다(docs/spec/projects.md#persistence).
	identifier := sok.Identity()
	os.Exit(sok.Run(os.Args[1:], os.Stdout, os.Stderr, sok.Options{Identifier: identifier, PathsDir: paths, PathsError: pathsErr, CoreVersion: sok.CoreVersion}))
}
