// Checks that a temporary folder that cannot be removed at exit fails the process with a message that names each entry that
// remains, with its mode and flags (tests/support/temporary_folder.m). The test runs itself as a child that leaves an immutable
// file in its temporary folder, reads the message of the child, and removes the folder after it clears the flag. It also checks
// that a kept folder is moved at exit into the folder that NATIVE_TEST_EVIDENCE names, that a process without it removes the
// kept folder and fails, and that a folder removed before the exit is gone at once and frees its place, so a check that repeats
// creates more folders over its run than a process holds at a time.
#import <Foundation/Foundation.h>
#include <sys/stat.h>
#include <unistd.h>
#import "support/temporary_folder.h"

static int failures;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// The child: a folder with an immutable file, which the removal at exit cannot delete. It prints the folder path first.
static int child(void) {
    NSString *folder = temporaryFolder(@"soksak-temporary-folder-test-");
    NSString *file = [folder stringByAppendingPathComponent:@"held"];
    if (![@"held" writeToFile:file atomically:NO encoding:NSUTF8StringEncoding error:nil] || chmod(file.fileSystemRepresentation, 0444) != 0
        || chflags(file.fileSystemRepresentation, UF_IMMUTABLE) != 0) {
        fprintf(stderr, "the child cannot prepare %s\n", file.fileSystemRepresentation);
        return 2;
    }
    printf("%s\n", folder.fileSystemRepresentation);
    fflush(stdout);
    return 0;
}

// The kept child: a folder with one file, which the child keeps. It prints the folder path first.
static int keptChild(void) {
    NSString *folder = temporaryFolder(@"soksak-temporary-folder-kept-");
    if (![@"evidence" writeToFile:[folder stringByAppendingPathComponent:@"frame"] atomically:NO encoding:NSUTF8StringEncoding error:nil]) {
        fprintf(stderr, "the kept child cannot write into %s\n", folder.fileSystemRepresentation);
        return 2;
    }
    keepTemporaryFolder(folder);
    printf("%s\n", folder.fileSystemRepresentation);
    fflush(stdout);
    return 0;
}

// The removing child: creates and removes more folders than a process holds at a time, each with a file, and prints the path
// of the last one after its removal.
static int removedChild(void) {
    NSString *folder = nil;
    for (int i = 0; i < 100; i++) {
        folder = temporaryFolder(@"soksak-temporary-folder-removed-");
        if (![@"frame" writeToFile:[folder stringByAppendingPathComponent:@"frame"] atomically:NO encoding:NSUTF8StringEncoding
                error:nil]) {
            fprintf(stderr, "the removing child cannot write into %s\n", folder.fileSystemRepresentation);
            return 2;
        }
        removeTemporaryFolder(folder);
        if ([NSFileManager.defaultManager fileExistsAtPath:folder]) {
            fprintf(stderr, "the removed folder %s remains\n", folder.fileSystemRepresentation);
            return 3;
        }
    }
    printf("%s\n", folder.fileSystemRepresentation);
    fflush(stdout);
    return 0;
}

typedef struct {
    int status;
    NSString *folder;
    NSString *message;
} ChildRun;

// Runs this executable with the argument and the environment of this process changed by changes (NSNull removes a variable), and
// returns its status, the folder that it printed and its error output. A child that does not start ends this process.
static ChildRun runChild(const char *executable, NSString *argument, NSDictionary *changes) {
    NSTask *task = [[NSTask new] autorelease];
    task.executableURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:executable]];
    task.arguments = @[ argument ];
    NSMutableDictionary *environment = [[NSProcessInfo.processInfo.environment mutableCopy] autorelease];
    [changes enumerateKeysAndObjectsUsingBlock:^(NSString *name, id value, BOOL *stop) {
        (void)stop;
        if (value == NSNull.null) [environment removeObjectForKey:name];
        else environment[name] = value;
    }];
    task.environment = environment;
    NSPipe *output = [NSPipe pipe], *errors = [NSPipe pipe];
    task.standardOutput = output;
    task.standardError = errors;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        fprintf(stderr, "FAIL: the child %s does not start: %s\n", argument.UTF8String, error.localizedDescription.UTF8String);
        exit(1);
    }
    NSData *outputData = [output.fileHandleForReading readDataToEndOfFile];
    NSData *errorData = [errors.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    return (ChildRun){
        task.terminationStatus,
        [[[[NSString alloc] initWithData:outputData encoding:NSUTF8StringEncoding] autorelease]
            stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet],
        [[[NSString alloc] initWithData:errorData encoding:NSUTF8StringEncoding] autorelease],
    };
}

int main(int argc, char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--child") == 0) return child();
    if (argc == 2 && strcmp(argv[1], "--kept-child") == 0) return keptChild();
    if (argc == 2 && strcmp(argv[1], "--removed-child") == 0) return removedChild();
    ChildRun held = runChild(argv[0], @"--child", @{});
    int status = held.status;
    NSString *folder = held.folder;
    NSString *message = held.message;
    NSString *file = [folder stringByAppendingPathComponent:@"held"];

    check(status == 1, [NSString stringWithFormat:@"a folder that is not removed ends the child with status 1 (status %d)", status]);
    check([message containsString:[NSString stringWithFormat:@"FAIL: the temporary folder %@ is not removed", folder]],
        [NSString stringWithFormat:@"the message names the folder: %@", message]);
    check([message containsString:[NSString stringWithFormat:@"remains: %@ mode 0444 flags uchg uid %u", file, getuid()]],
        [NSString stringWithFormat:@"the message names the entry that remains with its mode, flags and owner: %@", message]);
    // removefile reports the path with its symbolic links resolved: the temporary folder of macOS is under /private/var.
    char resolved[PATH_MAX];
    NSString *refusedFile = realpath(folder.fileSystemRepresentation, resolved)
        ? [[NSString stringWithUTF8String:resolved] stringByAppendingPathComponent:@"held"] : file;
    check([message containsString:[NSString stringWithFormat:@"refused: %@ errno %d (%s)", refusedFile, EPERM, strerror(EPERM)]],
        [NSString stringWithFormat:@"the message names the path that refused the removal with its error number: %@", message]);

    // The folder of the child is removed here, so the check leaves nothing behind whatever its result.
    if (folder.length > 0) {
        if (chflags(file.fileSystemRepresentation, 0) != 0 && errno != ENOENT) check(NO, @"the flag of the held file is cleared");
        NSError *removeError = nil;
        if ([NSFileManager.defaultManager fileExistsAtPath:folder])
            check([NSFileManager.defaultManager removeItemAtPath:folder error:&removeError],
                [NSString stringWithFormat:@"the folder of the child is removed (%@)", removeError]);
    }
    // The evidence folder lies in the temporary folder of this process, which removes it at exit with the kept folder in it.
    NSString *evidence = temporaryFolder(@"soksak-temporary-folder-evidence-");
    ChildRun kept = runChild(argv[0], @"--kept-child", @{ @"NATIVE_TEST_EVIDENCE": evidence });
    NSString *moved = [evidence stringByAppendingPathComponent:kept.folder.lastPathComponent];
    NSString *frame = [NSString stringWithContentsOfFile:[moved stringByAppendingPathComponent:@"frame"]
        encoding:NSUTF8StringEncoding error:nil];
    check(kept.status == 0 && kept.folder.length > 0, [NSString stringWithFormat:@"a kept folder ends the child with status 0 (status %d: %@)",
        kept.status, kept.message]);
    check([kept.message containsString:[NSString stringWithFormat:@"KEPT %@\n", moved]]
        && [frame isEqualToString:@"evidence"] && ![NSFileManager.defaultManager fileExistsAtPath:kept.folder],
        [NSString stringWithFormat:@"the exit moves a kept folder with its files into NATIVE_TEST_EVIDENCE and names it: %@", kept.message]);

    ChildRun unset = runChild(argv[0], @"--kept-child", @{ @"NATIVE_TEST_EVIDENCE": NSNull.null });
    check(unset.status == 1 && unset.folder.length > 0 && ![NSFileManager.defaultManager fileExistsAtPath:unset.folder]
        && [unset.message containsString:[NSString stringWithFormat:
            @"FAIL: NATIVE_TEST_EVIDENCE is not set, so the kept folder %@ is removed", unset.folder]],
        [NSString stringWithFormat:@"a process without NATIVE_TEST_EVIDENCE removes its kept folder and fails (status %d): %@",
            unset.status, unset.message]);

    ChildRun removed = runChild(argv[0], @"--removed-child", @{});
    check(removed.status == 0 && removed.folder.length > 0 && ![NSFileManager.defaultManager fileExistsAtPath:removed.folder],
        [NSString stringWithFormat:@"a folder removed before the exit is gone at once and frees its place for the next folder "
            "(status %d): %@", removed.status, removed.message]);
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
