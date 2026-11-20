// sok-swap-bundle STAGED TARGET: places the staging bundle STAGED at TARGET with one rename, so a launch of TARGET finds either the
// complete earlier bundle or the complete new one (docs/spec/hosts.md). When TARGET exists, renamex_np with RENAME_SWAP exchanges the
// two directories in one step and the earlier bundle is left at STAGED; otherwise rename moves STAGED to TARGET. Node and the
// command line tools of macOS have no call of renamex_np, so the build runs this tool. Both paths must lie on one file system.
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: sok-swap-bundle STAGED TARGET\n");
        return 2;
    }
    const char *staged = argv[1], *target = argv[2];
    struct stat status;
    if (lstat(staged, &status) != 0 || !S_ISDIR(status.st_mode)) {
        fprintf(stderr, "sok-swap-bundle: the staging bundle %s is not a directory\n", staged);
        return 1;
    }
    if (lstat(target, &status) == 0) {
        if (!S_ISDIR(status.st_mode)) {
            fprintf(stderr, "sok-swap-bundle: the target %s is not a directory\n", target);
            return 1;
        }
        if (renamex_np(staged, target, RENAME_SWAP) != 0) {
            fprintf(stderr, "sok-swap-bundle: cannot exchange %s and %s: %s\n", staged, target, strerror(errno));
            return 1;
        }
        return 0;
    }
    if (errno != ENOENT) {
        fprintf(stderr, "sok-swap-bundle: cannot read %s: %s\n", target, strerror(errno));
        return 1;
    }
    // RENAME_EXCL refuses a target that another build placed after the lstat, instead of replacing it.
    if (renamex_np(staged, target, RENAME_EXCL) != 0) {
        fprintf(stderr, "sok-swap-bundle: cannot move %s to %s: %s\n", staged, target, strerror(errno));
        return 1;
    }
    return 0;
}
