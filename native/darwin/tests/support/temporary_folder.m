#import "temporary_folder.h"
#include <errno.h>
#include <fts.h>
#include <removefile.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Writes each entry that remains under a folder whose removal failed, with its permission bits, its file flags and its owner,
// so the failure names what refused the removal. An entry that cannot be read is written with its error.
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
        fprintf(stderr, "  remains: %s mode %04o flags %s uid %u\n", entry->fts_path, entry->fts_statp->st_mode & 07777,
            flags && flags[0] ? flags : "none", entry->fts_statp->st_uid);
        free(flags);
    }
    if (errno != 0) fprintf(stderr, "  remains: the walk of %s ended: %s\n", folder, strerror(errno));
    fts_close(walk);
}

// The folders that the process created, removed at exit in the order of creation.
static char *folders[64];
static int folderCount;

// Writes each path whose removal failed with the error number of its system call. removefile reports the entry itself,
// where the error of NSFileManager names only the folder that was asked to be removed.
static int writeRefusedEntry(removefile_state_t state, const char *path, void *context) {
    (void)context;
    int error = 0;
    if (removefile_state_get(state, REMOVEFILE_STATE_ERRNO, &error) != 0) error = errno;
    fprintf(stderr, "  refused: %s errno %d (%s)\n", path, error, strerror(error));
    return REMOVEFILE_PROCEED;
}

static void removeFolders(void) {
    BOOL failed = NO;
    for (int i = 0; i < folderCount; i++) {
        struct stat info;
        if (lstat(folders[i], &info) != 0 && errno == ENOENT) continue;
        removefile_state_t state = removefile_state_alloc();
        removefile_state_set(state, REMOVEFILE_STATE_ERROR_CALLBACK, writeRefusedEntry);
        int result = removefile(folders[i], state, REMOVEFILE_RECURSIVE);
        int error = errno;
        removefile_state_free(state);
        if (result != 0 || access(folders[i], F_OK) == 0) {
            // removefile returns 0 when its error callback lets it proceed past an entry, so the folder that still exists is the failure.
            fprintf(stderr, "FAIL: the temporary folder %s is not removed: %s\n", folders[i],
                result != 0 ? strerror(error) : "entries remain");
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
