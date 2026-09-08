package main

/*
#include <stdbool.h>
bool installDockMenu(void);
*/
import "C"

import (
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

var dockNewWindow func()

func setupDockMenu(host *Host) {
	dockNewWindow = host.WindowNew
	application.Get().Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		application.InvokeSync(func() {
			if !C.installDockMenu() {
				log.Fatal("failed to register the Dock menu")
			}
		})
	})
}

//export goDockNewWindow
func goDockNewWindow() { go dockNewWindow() }
