#import <Foundation/Foundation.h>
#import "diagnostic_reports.h"
#import "application_log.h"

char *sp_diagnostic_reports_directory(char **failure) {
    @autoreleasepool {
        NSArray<NSString *> *libraries = NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES);
        if (libraries.count == 0) {
            const char *reason = "the system names no Library folder for the user";
            sp_log_error("diagnostic reports", reason);
            *failure = strdup(reason);
            return NULL;
        }
        return strdup([[libraries[0] stringByAppendingPathComponent:@"Logs/DiagnosticReports"] fileSystemRepresentation]);
    }
}
