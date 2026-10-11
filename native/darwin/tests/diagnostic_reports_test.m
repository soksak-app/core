#import <Foundation/Foundation.h>
#import "diagnostic_reports.h"

static int failures;
static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

int main(void) { @autoreleasepool {
    char *failure = NULL;
    char *directory = sp_diagnostic_reports_directory(&failure);
    check(directory != NULL && failure == NULL, @"the system names the folder of the crash reports");
    NSString *library = NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES).firstObject;
    NSString *expected = [library stringByAppendingPathComponent:@"Logs/DiagnosticReports"];
    check(directory && strcmp(directory, expected.fileSystemRepresentation) == 0, @"the folder is Logs/DiagnosticReports of the Library folder of the user");
    check(directory && directory[0] == '/', @"the folder is an absolute path");
    free(directory);
    return failures == 0 ? 0 : 1;
} }
