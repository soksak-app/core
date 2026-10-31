// Checks that a temporary folder that cannot be removed at exit fails the process with a message that names each entry that
// remains, with its mode and flags (tests/support/temporary_folder.m). The test runs itself as a child that leaves an immutable
// file in its temporary folder, reads the message of the child, and removes the folder after it clears the flag.
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

int main(int argc, char **argv) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--child") == 0) return child();
    NSTask *task = [[NSTask new] autorelease];
    task.executableURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:argv[0]]];
    task.arguments = @[ @"--child" ];
    NSPipe *output = [NSPipe pipe], *errors = [NSPipe pipe];
    task.standardOutput = output;
    task.standardError = errors;
    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
        fprintf(stderr, "FAIL: the child does not start: %s\n", error.localizedDescription.UTF8String);
        return 1;
    }
    NSData *outputData = [output.fileHandleForReading readDataToEndOfFile];
    NSData *errorData = [errors.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    NSString *folder = [[[[NSString alloc] initWithData:outputData encoding:NSUTF8StringEncoding] autorelease]
        stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet];
    NSString *message = [[[NSString alloc] initWithData:errorData encoding:NSUTF8StringEncoding] autorelease];
    NSString *file = [folder stringByAppendingPathComponent:@"held"];

    check(task.terminationStatus == 1, [NSString stringWithFormat:@"a folder that is not removed ends the child with status 1 (status %d)",
        task.terminationStatus]);
    check([message containsString:[NSString stringWithFormat:@"FAIL: the temporary folder %@ is not removed", folder]],
        [NSString stringWithFormat:@"the message names the folder: %@", message]);
    check([message containsString:[NSString stringWithFormat:@"remains: %@ mode 0444 flags uchg", file]],
        [NSString stringWithFormat:@"the message names the entry that remains with its mode and flags: %@", message]);

    // The folder of the child is removed here, so the check leaves nothing behind whatever its result.
    if (folder.length > 0) {
        if (chflags(file.fileSystemRepresentation, 0) != 0 && errno != ENOENT) check(NO, @"the flag of the held file is cleared");
        NSError *removeError = nil;
        if ([NSFileManager.defaultManager fileExistsAtPath:folder])
            check([NSFileManager.defaultManager removeItemAtPath:folder error:&removeError],
                [NSString stringWithFormat:@"the folder of the child is removed (%@)", removeError]);
    }
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
