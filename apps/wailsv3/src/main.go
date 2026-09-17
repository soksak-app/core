// soksak 워크벤치를 실행하는 Wails v3 애플리케이션.
//
// 스테이징이 src/frontend/ 에 프런트엔드를 배치하고, 이 파일이 그 디렉터리를 포함한다.
// 창, 표면, 모달과 사이드카는 github.com/min-median-max/soksak/packages/host/wailsv3 패키지가 처리한다.
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
	observe := &options.Observe
	flag.BoolVar(&observe.Enabled, "observe", false, "register the observation service, which reports this window's number")
	flag.BoolVar(&observe.Zoom, "zoom", false, "maximise the window once the page is drawn")
	flag.StringVar(&observe.Resize, "resize", "", "give the window's content this size once the page is drawn, as width,height")
	flag.StringVar(&observe.Drive, "drive", "", "drag a boundary once the page is drawn, as wait,axis,line,dx,dy,ms,times")
	flag.StringVar(&observe.Click, "click", "", "press one element of the page once it is drawn, as ms,selector")
	flag.BoolVar(&observe.Transcript, "transcript", false, "write one line per host call and its answer to the log")
	flag.StringVar(&observe.Capture, "capture", "", "record this window into this directory while a drag runs")
	flag.Parse()

	if err := host.Run(assets, options); err != nil {
		log.Fatal(err)
	}
}
