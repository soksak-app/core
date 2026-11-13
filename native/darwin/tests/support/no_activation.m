#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#import <stdio.h>
#import <stdlib.h>
#import <unistd.h>

// Checks of make test do not activate the application. Every check links this file, and a check fails at exit if the
// process is active. Checks of make test-app-activation call sp_test_declare_activation before they activate.
void sp_test_declare_activation(void);

static bool declared;

void sp_test_declare_activation(void) { declared = true; }

// Changes the exit code to 1 if the process of a check that did not declare activation is active at exit.
static void failWhenActive(void) {
    // NSApp.isActive answers for a virtual key window (input_virtual.h); the running application reads the system.
    if (declared || NSApp == nil || !NSRunningApplication.currentApplication.active) return;
    NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
    fprintf(stderr, "FAIL: the test process is active at exit; a make test check must not activate the application "
        "(process %d, frontmost application %d %s)\n", getpid(), front.processIdentifier,
        front.localizedName.UTF8String ?: "(none)");
    _exit(1);
}

// Launch Services sends the open-application Apple event to a process that it starts, and the handler of AppKit activates the
// application when the process dispatches that event: a check whose wait dispatches the events of the application
// (support/run_until.h, support/event_wait.h) would take the front from the application that a person uses. The check handles
// the event itself and opens nothing. AppKit reads the handlers that the application installs before the launch finishes, so the
// handler is installed when the launch is about to finish.
@interface SPCheckOpenApplication : NSObject
@end
@implementation SPCheckOpenApplication
- (void)handleOpenApplication:(NSAppleEventDescriptor *)event withReplyEvent:(NSAppleEventDescriptor *)reply {
    (void)event; (void)reply;
}
@end

// Writes each activation of the test process by the system when it happens, with its time since the start of the process, so
// that the output of a failing check shows which step of the check came before the activation.
// The time at which the process started its checks.
static CFTimeInterval began;

static void recordActivations(CFTimeInterval began) {
    [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification
        object:nil queue:nil usingBlock:^(NSNotification *note) {
            NSRunningApplication *activated = note.userInfo[NSWorkspaceApplicationKey];
            if (activated.processIdentifier != getpid()) return;
            fprintf(stderr, "ACTIVATED: the system activated the test process %.1fms after it started (process %d)\n",
                (CACurrentMediaTime() - began) * 1000, getpid());
        }];
}

// The handler and the record are installed when the launch is about to finish. The constructor registers for that with the C
// interface of the local notification center, which starts no thread, because a check that forks before it starts the
// application, such as application_log_fatal_test, needs a parent with one thread: the runtime ends a child whose parent had
// other threads when the child initializes a class.
static void prepareLaunch(CFNotificationCenterRef center, void *observer, CFNotificationName name, const void *object,
    CFDictionaryRef info) {
    (void)center; (void)observer; (void)name; (void)object; (void)info;
    static SPCheckOpenApplication *handler;
    handler = [[SPCheckOpenApplication alloc] init];
    [NSAppleEventManager.sharedAppleEventManager setEventHandler:handler
        andSelector:@selector(handleOpenApplication:withReplyEvent:) forEventClass:kCoreEventClass andEventID:kAEOpenApplication];
    recordActivations(began);
}

__attribute__((constructor)) static void install(void) {
    began = CACurrentMediaTime();
    CFNotificationCenterAddObserver(CFNotificationCenterGetLocalCenter(), NULL, prepareLaunch,
        CFSTR("NSApplicationWillFinishLaunchingNotification"), NULL, CFNotificationSuspensionBehaviorDeliverImmediately);
    atexit(failWhenActive);
}
