#import "temporary_folder.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// The folders that the process created, removed at exit in the order of creation.
static char *folders[64];
static int folderCount;

static void removeFolders(void) {
    BOOL failed = NO;
    for (int i = 0; i < folderCount; i++) {
        NSString *path = [NSString stringWithUTF8String:folders[i]];
        if (![NSFileManager.defaultManager fileExistsAtPath:path]) continue;
        NSError *error = nil;
        if (![NSFileManager.defaultManager removeItemAtPath:path error:&error]) {
            fprintf(stderr, "FAIL: the temporary folder %s is not removed: %s\n", folders[i], error.localizedDescription.UTF8String);
            failed = YES;
        }
    }
    if (failed) _exit(1);
}

NSString *temporaryFolder(NSString *prefix) {
    if (folderCount == (int)(sizeof folders / sizeof folders[0])) {
        fprintf(stderr, "FAIL: a check creates more than %d temporary folders\n", folderCount);
        exit(1);
    }
    // NSTemporaryDirectory returns the folder of the user and ignores TMPDIR, so a run that gives the check its own
    // temporary folder (make temp-audit) would not see the folders of the check.
    NSString *parent = NSProcessInfo.processInfo.environment[@"TMPDIR"];
    if (parent.length == 0) {
        fprintf(stderr, "FAIL: TMPDIR is not set, so the check has no temporary folder\n");
        exit(1);
    }
    NSString *pattern = [parent stringByAppendingPathComponent:[prefix stringByAppendingString:@"XXXXXX"]];
    char *path = strdup(pattern.fileSystemRepresentation);
    if (mkdtemp(path) == NULL) {
        fprintf(stderr, "FAIL: the temporary folder %s is not created: %s\n", path, strerror(errno));
        exit(1);
    }
    if (folderCount == 0) atexit(removeFolders);
    folders[folderCount++] = path;
    return [NSString stringWithUTF8String:path];
}
