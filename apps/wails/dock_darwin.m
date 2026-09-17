#import "dock_menu.h"

extern void goDockNewWindow(void);
bool installDockMenu(void) { return appInstallDockMenu(^{ goDockNewWindow(); }); }
