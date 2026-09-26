//go:build darwin

package darwin

/*
#cgo CFLAGS: -x objective-c -fmodules
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#cgo pkg-config: soksak-darwin
#include <stdlib.h>
#include "clipboard.h"
*/
import "C"

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"unsafe"

	"github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
)

func clipboardJSON(value *C.char) (map[string]any, error) {
	if value == nil {
		return nil, fmt.Errorf("clipboard native call returned null")
	}
	defer C.free(unsafe.Pointer(value))
	var result map[string]any
	if err := json.Unmarshal([]byte(C.GoString(value)), &result); err != nil {
		return nil, fmt.Errorf("invalid clipboard response: %w", err)
	}
	return result, nil
}

func clipboardStatus(result map[string]any) error {
	if result["status"] == "error" {
		return fmt.Errorf("%v", result["error"])
	}
	if result["status"] != "ok" {
		return fmt.Errorf("clipboard operation was not accepted")
	}
	return nil
}

func (implementation) ClipboardRead(kind string) (platform.ClipboardValue, error) {
	board := C.sp_clipboard_open(nil)
	if board == nil {
		return platform.ClipboardValue{}, fmt.Errorf("cannot open system clipboard")
	}
	defer C.sp_clipboard_close(board)
	var pointer *C.char
	switch kind {
	case "text":
		pointer = C.sp_clipboard_read_text(board)
	case "png":
		pointer = C.sp_clipboard_read_png(board)
	case "fileURLs":
		pointer = C.sp_clipboard_read_file_urls(board)
	default:
		return platform.ClipboardValue{}, fmt.Errorf("unsupported clipboard type %s", kind)
	}
	result, err := clipboardJSON(pointer)
	if err != nil {
		return platform.ClipboardValue{}, err
	}
	// 기본값: 문자열이 아닌 status 는 빈 문자열이 되어 아래 clipboardStatus 가 받아들이지 않은 오류로 알린다.
	status, _ := result["status"].(string)
	if status == "absent" {
		return platform.ClipboardValue{}, nil
	}
	if err := clipboardStatus(result); err != nil {
		return platform.ClipboardValue{}, err
	}
	value := platform.ClipboardValue{Present: true, Type: kind}
	switch kind {
	case "text":
		var ok bool
		value.Text, ok = result["text"].(string)
		if !ok {
			return platform.ClipboardValue{}, fmt.Errorf("clipboard text is invalid")
		}
	case "png":
		encoded, ok := result["base64"].(string)
		if !ok {
			return platform.ClipboardValue{}, fmt.Errorf("clipboard PNG is invalid")
		}
		value.PNG, err = base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(value.PNG) > 16*1024*1024 {
			return platform.ClipboardValue{}, fmt.Errorf("clipboard PNG is invalid or too large")
		}
	case "fileURLs":
		items, ok := result["urls"].([]any)
		if !ok {
			return platform.ClipboardValue{}, fmt.Errorf("clipboard file URLs are invalid")
		}
		for _, item := range items {
			url, ok := item.(string)
			if !ok {
				return platform.ClipboardValue{}, fmt.Errorf("clipboard file URL is invalid")
			}
			value.URLs = append(value.URLs, url)
		}
	}
	return value, nil
}

func (implementation) ClipboardWriteText(text string) error {
	board := C.sp_clipboard_open(nil)
	if board == nil {
		return fmt.Errorf("cannot open system clipboard")
	}
	defer C.sp_clipboard_close(board)
	value := C.CString(text)
	defer C.free(unsafe.Pointer(value))
	result, err := clipboardJSON(C.sp_clipboard_write_text(board, value))
	if err != nil {
		return err
	}
	return clipboardStatus(result)
}

func (implementation) ClipboardWritePNG(bytes []byte) error {
	if len(bytes) > 16*1024*1024 {
		return fmt.Errorf("clipboard PNG exceeds 16 MiB")
	}
	board := C.sp_clipboard_open(nil)
	if board == nil {
		return fmt.Errorf("cannot open system clipboard")
	}
	defer C.sp_clipboard_close(board)
	var pointer *C.uchar
	if len(bytes) > 0 {
		pointer = (*C.uchar)(unsafe.Pointer(&bytes[0]))
	}
	result, err := clipboardJSON(C.sp_clipboard_write_png(board, pointer, C.size_t(len(bytes))))
	if err != nil {
		return err
	}
	return clipboardStatus(result)
}
