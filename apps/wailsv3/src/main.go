// soksak 워크벤치를 실행하는 Wails v3 애플리케이션.
//
// 스테이징이 src/frontend/ 에 프런트엔드를 배치하고, 이 파일이 그 디렉터리를 포함한다.
// 창, 표면, 모달, 사이드카와 로컬 엔드포인트는 github.com/soksak-app/core/packages/host/wailsv3 패키지가 처리한다.
package main

import (
	"embed"
	"fmt"
	"log"
	"os"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	// 인자는 창을 열기 전에 읽는다. 잘못된 인자는 상태 2 로 끝낸다(docs/spec/hosts.md#application-arguments).
	options, err := host.ParseArguments(os.Args[1:])
	if err == nil {
		err = host.ApplyArguments(options)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := host.Run(assets, options); err != nil {
		log.Fatal(err)
	}
}
