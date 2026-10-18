// The temporary folders of the checks. A check that writes files creates its folder with temporaryFolder, so the folder is
// removed on every exit path of the process (return from main and exit), also when the check fails.
#import <Foundation/Foundation.h>

/// Creates the new folder `<prefix>XXXXXX` in the folder that TMPDIR names and returns its path; a process without TMPDIR
/// fails with status 1. The folder
/// and its contents are removed when the process exits by returning from main or by exit(). A removal that fails is written
/// as `FAIL: the temporary folder <path> is not removed: <reason>` and ends the process with status 1. A folder that cannot
/// be created is written as a failure and ends the process with status 1.
NSString *temporaryFolder(NSString *prefix);
