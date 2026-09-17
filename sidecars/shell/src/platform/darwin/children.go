//go:build darwin

package darwin

/*
#include <libproc.h>
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// Children 은 libproc 의 proc_listchildpids 로 자식 프로세스 수를 센다.
func (implementation) Children(pid int) (int, error) {
	var ids [256]C.int
	count := C.proc_listchildpids(C.int(pid), unsafe.Pointer(&ids[0]), C.int(len(ids))*C.int(unsafe.Sizeof(ids[0])))
	if count < 0 {
		return 0, fmt.Errorf("list children of %d failed", pid)
	}
	return int(count), nil
}
