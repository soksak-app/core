// 셸 사이드카. 표준 입력으로 요청을 받고 표준 출력으로 셸 출력을 보낸다.
// 형식은 docs/spec/sidecars.md 에 정의한다. 표준 입력이 닫히면 모든 셸을 종료하고 끝난다.
package main

import (
	"log"
	"os"

	"soksak/sidecars/shell/src/shell"
)

func main() {
	log.SetFlags(0)
	if err := shell.Serve(os.Stdin, os.Stdout); err != nil {
		log.Fatalf("shell sidecar: %v", err)
	}
}
