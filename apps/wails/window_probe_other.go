//go:build !darwin

package main

import "log"

func observeNative(string) { log.Print("observe: native inspection is unavailable on this platform") }
