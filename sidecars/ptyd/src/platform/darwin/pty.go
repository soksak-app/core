//go:build darwin

package darwin

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// PTYPair는 마스터와 슬레이브 PTY 파일 디스크립터를 나타낸다.
type PTYPair struct {
	Master *os.File
	Slave  *os.File
}

// AllocatePTY는 새 PTY 쌍을 할당한다.
func AllocatePTY() (*PTYPair, error) {
	// 마스터 PTY 파일 열기 (/dev/ptmx)
	master, err := os.OpenFile("/dev/ptmx", os.O_RDWR, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}

	// TIOCPTYGRANT - 슬레이브를 현재 프로세스에 부여
	if err := ioctlInt(master, syscall.TIOCPTYGRANT, 0); err != nil {
		master.Close()
		return nil, fmt.Errorf("TIOCPTYGRANT: %w", err)
	}

	// TIOCPTYUNLK - 슬레이브 잠금 해제
	if err := ioctlInt(master, syscall.TIOCPTYUNLK, 0); err != nil {
		master.Close()
		return nil, fmt.Errorf("TIOCPTYUNLK: %w", err)
	}

	// TIOCPTYGNAME - 슬레이브 이름 얻기 (최대 128바이트)
	var slaveName [128]byte
	if err := ioctlPtr(master, syscall.TIOCPTYGNAME, unsafe.Pointer(&slaveName)); err != nil {
		master.Close()
		return nil, fmt.Errorf("TIOCPTYGNAME: %w", err)
	}

	// C 문자열을 Go 문자열로 변환
	var slaveNameStr string
	for i := range slaveName {
		if slaveName[i] == 0 {
			slaveNameStr = string(slaveName[:i])
			break
		}
	}
	if slaveNameStr == "" {
		master.Close()
		return nil, fmt.Errorf("failed to get slave PTY name")
	}

	// 슬레이브 PTY 파일 열기
	slave, err := os.OpenFile(slaveNameStr, os.O_RDWR, 0)
	if err != nil {
		master.Close()
		return nil, fmt.Errorf("open slave %s: %w", slaveNameStr, err)
	}

	return &PTYPair{
		Master: master,
		Slave:  slave,
	}, nil
}

// SetWindowSize는 PTY 윈도우 크기를 설정한다.
func SetWindowSize(pty *PTYPair, cols, rows int) error {
	// winsize 구조체: 행, 열, xpixel, ypixel (각 2바이트, 총 8바이트)
	var ws [4]uint16
	ws[0] = uint16(rows)
	ws[1] = uint16(cols)
	// xpixel, ypixel은 0으로 둔다

	if err := ioctlPtr(pty.Master, syscall.TIOCSWINSZ, unsafe.Pointer(&ws)); err != nil {
		return fmt.Errorf("TIOCSWINSZ: %w", err)
	}
	return nil
}

// ioctlInt는 정수 인자를 받는 ioctl을 호출한다.
func ioctlInt(f *os.File, cmd, arg int) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(f.Fd()), uintptr(cmd), uintptr(arg))
	if errno != 0 {
		return errno
	}
	return nil
}

// ioctlPtr는 포인터 인자를 받는 ioctl을 호출한다.
func ioctlPtr(f *os.File, cmd uintptr, arg unsafe.Pointer) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(f.Fd()), cmd, uintptr(arg))
	if errno != 0 {
		return errno
	}
	return nil
}

// Close는 PTY 쌍을 닫는다.
func (p *PTYPair) Close() error {
	var errMaster, errSlave error
	if p.Master != nil {
		errMaster = p.Master.Close()
	}
	if p.Slave != nil {
		errSlave = p.Slave.Close()
	}
	if errMaster != nil {
		return errMaster
	}
	return errSlave
}
