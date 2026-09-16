#import "dock_menu_darwin.h"

extern void goDockNewWindow(void);
bool installDockMenu(void) { return appInstallDockMenu(^{ goDockNewWindow(); }); }
