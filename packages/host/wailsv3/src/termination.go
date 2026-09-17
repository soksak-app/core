package host

import "github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"

// OnTermination 은 운영체제의 종료 요청을 받으면 quit 를 한 번 호출하게 한다. 그 뒤의 종료
// 요청은 운영체제의 기본 동작으로 프로세스를 끝낸다.
func OnTermination(quit func()) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	return system.OnTermination(quit)
}
