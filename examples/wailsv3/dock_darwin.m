#import "../native/dock_menu_darwin.m"

extern void goDockNewWindow(void);
bool installDockMenu(void) { return appInstallDockMenu(^{ goDockNewWindow(); }); }
