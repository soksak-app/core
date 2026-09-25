// 파일 사이드카. 표준 입력으로 요청을 받고 표준 출력으로 디렉터리 목록을 보낸다.
// 형식은 docs/spec/sidecars.md 의 files 에 정의한다. 표준 입력이 닫히면 끝난다.
package main

import (
	"log"
	"os"

	"github.com/min-median-max/soksak/sidecars/files/src/files"
)

func main() {
	log.SetFlags(0)
	if err := files.Serve(os.Stdin, os.Stdout); err != nil {
		log.Fatalf("files sidecar: %v", err)
	}
}
