// sok 은 Wails 애플리케이션의 command line 이다(docs/spec/cli.md).
package main

import (
	"os"

	"github.com/min-median-max/soksak/packages/sok/wailsv3/src"
	_ "github.com/min-median-max/soksak/packages/sok/wailsv3/src/platform/darwin"
	_ "github.com/min-median-max/soksak/packages/sok/wailsv3/src/platform/windows"
)

// identifier 는 Wails 애플리케이션의 식별자이며 기본 설정 폴더와 경로 항목의 이름이다(docs/spec/projects.md).
const identifier = "com.soksak.wails"

func main() {
	os.Exit(sok.Run(os.Args[1:], os.Stdout, os.Stderr, sok.Options{Identifier: identifier, PathsDir: "/etc/paths.d"}))
}
