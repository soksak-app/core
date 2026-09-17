//go:build linux

package linux

import (
	"os"
	"strconv"
	"strings"
)

// Children 은 /proc/<pid>/stat 의 부모 프로세스 필드로 자식 프로세스 수를 센다.
func (implementation) Children(pid int) (int, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, err
	}
	count := 0
	for _, entry := range entries {
		if _, err := strconv.Atoi(entry.Name()); err != nil {
			continue
		}
		stat, err := os.ReadFile("/proc/" + entry.Name() + "/stat")
		if err != nil {
			continue
		}
		// 명령 이름은 괄호 안에 있고 공백을 포함할 수 있으므로 마지막 ')' 뒤를 나눈다.
		fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:]))
		if len(fields) > 1 && fields[1] == strconv.Itoa(pid) {
			count++
		}
	}
	return count, nil
}
