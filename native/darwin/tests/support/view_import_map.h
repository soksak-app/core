// The view import map of the checks. The map text is the map of the published view page cases (VIEW_PAGE_CASES, which the build
// defines as the path of packages/plugin-api/contract/view-page.json), so every check that serves a view page sets the map of
// the application that the plugin-api publishes.
#import <Foundation/Foundation.h>

/// Returns the map text of the published view page cases. A file that cannot be read or parsed ends the process with status 1.
NSString *viewImportMapFixture(void);
