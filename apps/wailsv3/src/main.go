// soksak 워크벤치를 실행하는 Wails v3 애플리케이션.
//
// 스테이징이 src/frontend/ 에 프런트엔드를 배치하고, 이 파일이 그 디렉터리를 포함한다.
// 창, 표면, 모달, 사이드카와 로컬 엔드포인트는 github.com/min-median-max/soksak/packages/host/wailsv3 패키지가 처리한다.
package main

import (
	"embed"
	"flag"
	"log"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

//go:embed all:frontend
var assets embed.FS

func main() {
	var options host.Options
	flag.StringVar(&options.ConfigDir, "config-dir", "", "Application configuration directory")
	flag.Parse()

	if err := host.Run(assets, options); err != nil {
		log.Fatal(err)
	}
}
