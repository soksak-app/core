// sok 은 Wails 애플리케이션의 command line 이다(docs/spec/cli.md).
package main

import (
	"os"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/soksak-app/core/packages/sok/wailsv3/src/platform/windows"
)

func main() {
	// 식별자는 기본 설정 폴더와 경로 항목의 이름이다(docs/spec/projects.md#persistence).
	identifier, former := sok.Identity()
	os.Exit(sok.Run(os.Args[1:], os.Stdout, os.Stderr, sok.Options{Identifier: identifier, Former: former, PathsDir: "/etc/paths.d", CoreVersion: sok.CoreVersion}))
}
