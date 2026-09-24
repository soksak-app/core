//go:build darwin

package darwin

/*
#include <errno.h>
#include <libproc.h>
#include <sys/proc_info.h>
*/
import "C"

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

// member 는 프로세스 그룹의 구성원 하나다.
type member struct {
	pid int
	// zombie 는 끝났고 아직 회수되지 않은 프로세스다.
	zombie bool
	// exiting 은 exit() 을 처리하는 중인 프로세스다.
	exiting bool
}

// szomb 는 sys/proc.h 의 좀비 상태 값이다.
const szomb = 5

// members 는 libproc 로 프로세스 그룹의 구성원과 상태를 읽는다. 읽는 동안 회수된 프로세스는 결과에 없다.
func members(group int) ([]member, error) {
	var ids [256]C.int
	size := C.proc_listpids(C.PROC_PGRP_ONLY, C.uint32_t(group), unsafe.Pointer(&ids[0]), C.int(len(ids))*C.int(unsafe.Sizeof(ids[0])))
	if size < 0 {
		return nil, fmt.Errorf("list process group %d failed", group)
	}
	var result []member
	for _, id := range ids[:int(size)/int(unsafe.Sizeof(ids[0]))] {
		if id <= 0 {
			continue
		}
		var info C.struct_proc_bsdinfo
		// PROC_PIDTBSDINFO 는 인자가 0 이면 좀비에 ESRCH 로 답하고, 1 이면 좀비도 찾는다.
		read, err := C.proc_pidinfo(id, C.PROC_PIDTBSDINFO, 1, unsafe.Pointer(&info), C.int(unsafe.Sizeof(info)))
		if read == C.int(unsafe.Sizeof(info)) {
			result = append(result, member{
				pid:     int(id),
				zombie:  info.pbi_status == szomb,
				exiting: info.pbi_flags&C.PROC_FLAG_INEXIT != 0,
			})
			continue
		}
		// 목록을 읽은 뒤 회수된 프로세스는 정보를 주지 않는다. 그 밖의 실패는 상태를 모르는 것이다.
		if errors.Is(err, syscall.ESRCH) {
			continue
		}
		return nil, fmt.Errorf("read process %d of group %d: %v", int(id), group, err)
	}
	return result, nil
}
