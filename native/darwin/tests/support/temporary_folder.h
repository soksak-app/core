// The temporary folders of the checks. A check that writes files creates its folder with temporaryFolder, so the folder is
// removed on every exit path of the process (return from main and exit), also when the check fails, unless the check keeps it
// with keepTemporaryFolder.
#import <Foundation/Foundation.h>

/// Each data store under the folder ends first (sp_document_store_close), and a document that stays open fails the process.
/// Creates the new folder `<prefix>XXXXXX` in the folder that TMPDIR names and returns its path; a process without TMPDIR
/// fails with status 1. The folder
/// and its contents are removed when the process exits by returning from main or by exit(). A removal that fails is written
/// as `FAIL: the temporary folder <path> is not removed: <reason>` and ends the process with status 1. A folder that cannot
/// be created is written as a failure and ends the process with status 1.
NSString *temporaryFolder(NSString *prefix);

/// Keeps folder, which temporaryFolder created: when the process exits, the folder is moved into the folder that
/// NATIVE_TEST_EVIDENCE names instead of being removed, and the new path is written as `KEPT <path>`. native/darwin/Makefile sets
/// NATIVE_TEST_EVIDENCE to target/native-test-evidence of the repository. A check keeps the folders that hold the evidence of its
/// failure. A folder that cannot be moved, or a process without NATIVE_TEST_EVIDENCE, is written as a failure, the folder is
/// removed, and the process ends with status 1. A folder that temporaryFolder did not create fails the process with status 1.
void keepTemporaryFolder(NSString *folder);
