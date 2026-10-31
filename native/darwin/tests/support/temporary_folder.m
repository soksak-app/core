#import "temporary_folder.h"
#include <errno.h>
#include <fts.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Writes each entry that remains under a folder whose removal failed, with its permission bits and its file flags, so the
// failure names what refused the removal. An entry that cannot be read is written with its error.
static void writeRemainingEntries(const char *folder) {
    char *roots[] = { (char *)folder, NULL };
    // FTS_PHYSICAL lists a symbolic link itself, and each path starts with the folder path as the process created it.
    FTS *walk = fts_open(roots, FTS_PHYSICAL | FTS_NOCHDIR, NULL);
    if (!walk) {
        fprintf(stderr, "  remains: %s unreadable: %s\n", folder, strerror(errno));
        return;
    }
    for (;;) {
        // fts_read returns NULL at the end with errno 0 and on an error with errno set, so errno is cleared before each read.
        errno = 0;
        FTSENT *entry = fts_read(walk);
        if (!entry) break;
        if (entry->fts_info == FTS_DP) continue;
        if (entry->fts_info == FTS_DNR || entry->fts_info == FTS_ERR || entry->fts_info == FTS_NS) {
            fprintf(stderr, "  remains: %s unreadable: %s\n", entry->fts_path, strerror(entry->fts_errno));
            if (entry->fts_info != FTS_DNR) continue;
        }
        char *flags = fflagstostr(entry->fts_statp->st_flags);
        fprintf(stderr, "  remains: %s mode %04o flags %s\n", entry->fts_path, entry->fts_statp->st_mode & 07777,
            flags && flags[0] ? flags : "none");
        free(flags);
    }
    if (errno != 0) fprintf(stderr, "  remains: the walk of %s ended: %s\n", folder, strerror(errno));
    fts_close(walk);
}

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
            writeRemainingEntries(folders[i]);
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
