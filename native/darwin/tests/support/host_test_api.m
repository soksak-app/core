#include "host_test_api.h"
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <string.h>
#include <Block.h>
#include <stdio.h>
#include <stdlib.h>
#include <notify.h>
#include "../../src/view_presentation_fault.h"

static void (*installedCounts)(uint64_t *, uint64_t *, uint64_t *);
static void (*installedSetter)(bool);
static bool stallFunctionsInstalled;

const char *sp_host_test_install_stall_functions(uintptr_t counts, uintptr_t setter) {
    if (stallFunctionsInstalled) return "host test stall functions are already installed";
    if (!counts) return "host test stall count function is missing";
    if (!setter) return "host test stall setter function is missing";
    installedCounts = (void (*)(uint64_t *, uint64_t *, uint64_t *))counts;
    installedSetter = (void (*)(bool))setter;
    stallFunctionsInstalled = true;
    return NULL;
}

static void requireStallFunctions(void) {
    if (stallFunctionsInstalled) return;
    fputs("host test stall functions are not installed\n", stderr);
    abort();
}

void sp_host_test_read_stall_counts(uint64_t *sent, uint64_t *sent_in_wait, uint64_t *answered) {
    requireStallFunctions();
    installedCounts(sent, sent_in_wait, answered);
}

void sp_host_test_set_send_in_next_wait(bool send) {
    requireStallFunctions();
    installedSetter(send);
}

static void runDirectly(void (^work)(void)) { work(); }
uintptr_t sp_host_test_direct_runner_address(void) { return (uintptr_t)runDirectly; }

#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <mach/mach.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>


#define SAMPLER_PHASES SP_HOST_TEST_SAMPLER_PHASES

static mach_port_t sampler_port;
static uintptr_t sampler_low;
static uintptr_t sampler_high;
static pthread_t sampler_thread;
static _Atomic int sampler_running;
static _Atomic int sampler_phase = -1;
static _Atomic uint64_t sampler_samples[SAMPLER_PHASES];
// The count of samples that sp_host_test_sampler_await_samples waits for in each phase, 0 for none, and the semaphore that the
// sample which reaches it signals.
static _Atomic uint64_t sampler_awaited[SAMPLER_PHASES];
static dispatch_semaphore_t sampler_sampled;
static _Atomic uint64_t sampler_outside[SAMPLER_PHASES];
static _Atomic uintptr_t sampler_first_outside[SAMPLER_PHASES];
static _Atomic uint64_t sampler_failures;
static _Atomic int sampler_last_error;

static kern_return_t sampler_stack_pointer(mach_port_t port, uintptr_t *sp) {
#if defined(__arm64__)
    arm_thread_state64_t state;
    mach_msg_type_number_t count = ARM_THREAD_STATE64_COUNT;
    kern_return_t result = thread_get_state(port, ARM_THREAD_STATE64, (thread_state_t)&state, &count);
    if (result == KERN_SUCCESS) *sp = (uintptr_t)arm_thread_state64_get_sp(state);
#elif defined(__x86_64__)
    x86_thread_state64_t state;
    mach_msg_type_number_t count = x86_THREAD_STATE64_COUNT;
    kern_return_t result = thread_get_state(port, x86_THREAD_STATE64, (thread_state_t)&state, &count);
    if (result == KERN_SUCCESS) *sp = (uintptr_t)state.__rsp;
#else
#error "the sampler reads the stack pointer of arm64 and x86_64 only"
#endif
    return result;
}

static void sampler_fail(kern_return_t result) {
    atomic_fetch_add(&sampler_failures, 1);
    atomic_store(&sampler_last_error, (int)result);
}

// The loop takes no lock and allocates nothing while the main thread is suspended, because the main thread may hold the lock
// of the allocator when it is suspended. The main thread reports no event when it switches stacks, so the loop samples on a
// fixed interval of 20 microseconds.
static void *sampler_loop(void *unused) {
    (void)unused;
    while (atomic_load(&sampler_running)) {
        int phase = atomic_load(&sampler_phase);
        if (phase >= 0 && phase < SAMPLER_PHASES) {
            kern_return_t result = thread_suspend(sampler_port);
            if (result != KERN_SUCCESS) {
                sampler_fail(result);
            } else {
                uintptr_t sp = 0;
                kern_return_t read = sampler_stack_pointer(sampler_port, &sp);
                kern_return_t resumed = thread_resume(sampler_port);
                if (read != KERN_SUCCESS) {
                    sampler_fail(read);
                } else {
                    uint64_t taken = atomic_fetch_add(&sampler_samples[phase], 1) + 1;
                    if (taken == atomic_load(&sampler_awaited[phase])) dispatch_semaphore_signal(sampler_sampled);
                    if (sp < sampler_low || sp > sampler_high) {
                        if (atomic_fetch_add(&sampler_outside[phase], 1) == 0) atomic_store(&sampler_first_outside[phase], sp);
                    }
                }
                if (resumed != KERN_SUCCESS) sampler_fail(resumed);
            }
        }
        usleep(20);
    }
    return NULL;
}

static pthread_t sampler_main;

// The main thread calls this, so that the sampler reads that thread; it returns 0 on any other thread.
int sp_host_test_sampler_capture_main(void) {
    if (!pthread_main_np()) return 0;
    sampler_main = pthread_self();
    return 1;
}

int sp_host_test_sampler_start(void) {
    pthread_t main = sampler_main;
    if (main == NULL) return -1;
    if (sampler_sampled == NULL) sampler_sampled = dispatch_semaphore_create(0);
    sampler_port = pthread_mach_thread_np(main);
    sampler_high = (uintptr_t)pthread_get_stackaddr_np(main);
    sampler_low = sampler_high - (uintptr_t)pthread_get_stacksize_np(main);
    atomic_store(&sampler_running, 1);
    int result = pthread_create(&sampler_thread, NULL, sampler_loop, NULL);
    if (result != 0) atomic_store(&sampler_running, 0);
    return result;
}

int sp_host_test_sampler_stop(void) {
    atomic_store(&sampler_phase, -1);
    atomic_store(&sampler_running, 0);
    return pthread_join(sampler_thread, NULL);
}

void sp_host_test_sampler_set_phase(int phase) { atomic_store(&sampler_phase, phase); }
uint64_t sp_host_test_sampler_phase_samples(int phase) { return atomic_load(&sampler_samples[phase]); }

void sp_host_test_sampler_await_samples(int phase, uint64_t count) {
    atomic_store(&sampler_awaited[phase], count);
    // A sample that reached the count before the store above is seen here; one after it signals.
    while (atomic_load(&sampler_samples[phase]) < count) dispatch_semaphore_wait(sampler_sampled, DISPATCH_TIME_FOREVER);
    atomic_store(&sampler_awaited[phase], 0);
}
uint64_t sp_host_test_sampler_phase_outside(int phase) { return atomic_load(&sampler_outside[phase]); }
uintptr_t sp_host_test_sampler_phase_first_outside(int phase) { return atomic_load(&sampler_first_outside[phase]); }
uint64_t sp_host_test_sampler_failure_count(void) { return atomic_load(&sampler_failures); }
int sp_host_test_sampler_failure_last(void) { return atomic_load(&sampler_last_error); }
uintptr_t sp_host_test_sampler_stack_low(void) { return sampler_low; }
uintptr_t sp_host_test_sampler_stack_high(void) { return sampler_high; }

// The recorder of the main run loop keeps each activity of the run loop while it is armed: the time on the clock of the heartbeat
// of the stall watch (CLOCK_UPTIME_RAW), the activity, whether the run loop runs in its default mode, at the start of a wait the
// time until the next timer of the mode, so a wake can be told from the timer that it fired, and the counts of the stall watch
// (sp_stall_counts), so a turn states whether the watch sent into the wait before it and whether a block of the watch ran in it.
// The observer is a C function and writes into a fixed array, so it runs no Go code on the main thread and allocates nothing.
#define RECORDER_CAPACITY SP_HOST_TEST_RECORDER_CAPACITY

typedef struct {
    uint64_t at;
    int64_t timer_in;
    int32_t activity;
    int32_t default_mode;
    int32_t has_timer;
    uint64_t sent_in_wait;
    uint64_t answered;
    _Atomic int32_t written;
} recorder_entry;

static recorder_entry recorder_entries[RECORDER_CAPACITY];
static _Atomic uint64_t recorder_next;
static _Atomic int recorder_armed;

static void recorder_observe(CFRunLoopObserverRef observer, CFRunLoopActivity activity, void *info) {
    (void)observer;
    (void)info;
    if (!atomic_load(&recorder_armed)) return;
    uint64_t index = atomic_fetch_add(&recorder_next, 1);
    if (index >= RECORDER_CAPACITY) return;
    recorder_entry *entry = &recorder_entries[index];
    entry->at = clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
    entry->activity = (int32_t)activity;
    CFRunLoopRef main = CFRunLoopGetMain();
    CFStringRef mode = CFRunLoopCopyCurrentMode(main);
    entry->default_mode = mode != NULL && CFEqual(mode, kCFRunLoopDefaultMode);
    entry->has_timer = 0;
    entry->timer_in = 0;
    if (activity == kCFRunLoopBeforeWaiting && mode != NULL) {
        CFAbsoluteTime fire = CFRunLoopGetNextTimerFireDate(main, mode);
        if (fire != 0) {
            entry->has_timer = 1;
            entry->timer_in = (int64_t)((fire - CFAbsoluteTimeGetCurrent()) * 1e9);
        }
    }
    if (mode != NULL) CFRelease(mode);
    uint64_t sent = 0;
    sp_host_test_read_stall_counts(&sent, &entry->sent_in_wait, &entry->answered);
    atomic_store_explicit(&entry->written, 1, memory_order_release);
}

// Installs the observer once, in the common modes of the main run loop, and arms the recorder with an empty array.
void sp_host_test_recorder_start(void) {
    requireStallFunctions();
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        CFRunLoopObserverRef observer = CFRunLoopObserverCreate(NULL, kCFRunLoopAllActivities, true, 0, recorder_observe, NULL);
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, kCFRunLoopCommonModes);
        CFRelease(observer);
    });
    atomic_store(&recorder_armed, 0);
    uint64_t used = atomic_load(&recorder_next);
    for (uint64_t index = 0; index < used && index < RECORDER_CAPACITY; index++) atomic_store(&recorder_entries[index].written, 0);
    atomic_store(&recorder_next, 0);
    atomic_store(&recorder_armed, 1);
}

// Disarms the recorder and returns the number of activities that it kept; an activity that the array could not hold is not kept.
uint64_t sp_host_test_recorder_stop(void) {
    atomic_store(&recorder_armed, 0);
    uint64_t used = atomic_load(&recorder_next);
    return used < RECORDER_CAPACITY ? used : RECORDER_CAPACITY;
}

uint64_t sp_host_test_recorder_dropped(void) {
    uint64_t used = atomic_load(&recorder_next);
    return used > RECORDER_CAPACITY ? used - RECORDER_CAPACITY : 0;
}

// Copies one kept activity; it returns 0 for an activity that the observer has not finished writing.
int sp_host_test_recorder_entry_at(uint64_t index, uint64_t *at, int32_t *activity, int32_t *default_mode, int32_t *has_timer,
    int64_t *timer_in, uint64_t *sent_in_wait, uint64_t *answered) {
    recorder_entry *entry = &recorder_entries[index];
    if (!atomic_load_explicit(&entry->written, memory_order_acquire)) return 0;
    *at = entry->at;
    *activity = entry->activity;
    *default_mode = entry->default_mode;
    *has_timer = entry->has_timer;
    *timer_in = entry->timer_in;
    *sent_in_wait = entry->sent_in_wait;
    *answered = entry->answered;
    return 1;
}

#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurfaceRef.h>
#import <AppKit/AppKit.h>
#include <math.h>

static CFNumberRef number(int value) { return CFNumberCreate(NULL, kCFNumberIntType, &value); }

// frameCreate creates a BGRA surface that carries the nonce of a transfer image.
static IOSurfaceRef frameCreate(int width, int height, const unsigned char *nonce) {
	const void *keys[] = {kIOSurfaceWidth, kIOSurfaceHeight, kIOSurfaceBytesPerElement, kIOSurfacePixelFormat};
	const void *values[] = {number(width), number(height), number(4), number('BGRA')};
	CFDictionaryRef properties = CFDictionaryCreate(NULL, keys, values, 4, &kCFTypeDictionaryKeyCallBacks,
		&kCFTypeDictionaryValueCallBacks);
	for (int index = 0; index < 4; index++) CFRelease(values[index]);
	IOSurfaceRef surface = IOSurfaceCreate(properties);
	CFRelease(properties);
	if (!surface) return NULL;
	CFDataRef data = CFDataCreate(NULL, nonce, 16);
	IOSurfaceSetValue(surface, CFSTR("soksak.frame"), data);
	CFRelease(data);
	return surface;
}

void *sp_host_test_frame_create(int width, int height, const unsigned char *nonce) { return (void *)frameCreate(width, height, nonce); }
uint32_t sp_host_test_frame_id(void *frame) { return IOSurfaceGetID((IOSurfaceRef)frame); }
bool sp_host_test_frame_in_use(void *frame) { return IOSurfaceIsInUse((IOSurfaceRef)frame) != 0; }
void sp_host_test_frame_release(void *frame) { CFRelease((CFTypeRef)frame); }

#include <errno.h>
#include <mach/ndr.h>
#include <mach/thread_status.h>
#include <signal.h>
#include <spawn.h>
#include <string.h>
#include <sys/wait.h>

// The exception message of a task crash (mach_exc, MIG subsystem 2405): the crashing thread and task are port descriptors.
#define CRASH_RAISE_ID 2405
#define CRASH_REPLY_ID 2505

typedef struct {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t thread;
    mach_msg_port_descriptor_t task;
    NDR_record_t ndr;
    exception_type_t exception;
    mach_msg_type_number_t code_count;
    int64_t code[2];
    mach_msg_trailer_t trailer;
} crash_request;

typedef struct {
    mach_msg_header_t header;
    NDR_record_t ndr;
    kern_return_t result;
} crash_reply;

typedef struct {
    mach_port_t port;
    pid_t pid;
    pthread_t thread;
    _Atomic int handled;
    int failed;
} crash_service;

extern char **environ;

// The service answers each crash exception with KERN_SUCCESS, so the system treats the exception as handled and writes no
// crash report. It ends when the owner destroys the port.
static void *crashServiceRun(void *argument) {
    crash_service *service = argument;
    for (;;) {
        crash_request request;
        memset(&request, 0, sizeof(request));
        kern_return_t result = mach_msg(&request.header, MACH_RCV_MSG, 0, sizeof(request), service->port, MACH_MSG_TIMEOUT_NONE,
            MACH_PORT_NULL);
        // The owner destroys the port to end the service; the receive then reports the port as changed or dead.
        if (result == MACH_RCV_PORT_DIED || result == MACH_RCV_PORT_CHANGED || result == MACH_RCV_INVALID_NAME) return NULL;
        if (result != KERN_SUCCESS || request.header.msgh_id != CRASH_RAISE_ID) {
            service->failed = 1;
            return NULL;
        }
        mach_port_deallocate(mach_task_self(), request.thread.name);
        mach_port_deallocate(mach_task_self(), request.task.name);
        // The count is set before the reply, so the owner reads it after the child has ended.
        atomic_fetch_add(&service->handled, 1);
        crash_reply reply;
        memset(&reply, 0, sizeof(reply));
        reply.header.msgh_bits = MACH_MSGH_BITS(MACH_MSGH_BITS_REMOTE(request.header.msgh_bits), 0);
        reply.header.msgh_size = sizeof(reply);
        reply.header.msgh_remote_port = request.header.msgh_remote_port;
        reply.header.msgh_local_port = MACH_PORT_NULL;
        reply.header.msgh_id = CRASH_REPLY_ID;
        reply.ndr = NDR_record;
        reply.result = KERN_SUCCESS;
        result = mach_msg(&reply.header, MACH_SEND_MSG, sizeof(reply), 0, MACH_PORT_NULL, MACH_MSG_TIMEOUT_NONE, MACH_PORT_NULL);
        if (result != KERN_SUCCESS) {
            service->failed = 1;
            return NULL;
        }
    }
}

// Starts path with the newline-separated arguments after it and NAME=VALUE in the environment, its standard output and standard
// error on output_fd, and its crash exceptions answered by a service. It returns NULL or an error message.
const char *sp_host_test_spawn_handled_crash(const char *path, const char *arguments, const char *environment, int output_fd,
    int *pid, uintptr_t *handle) {
    crash_service *service = calloc(1, sizeof(*service));
    if (!service) return "host test crash service allocation failed";
    if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &service->port) != KERN_SUCCESS) {
        free(service);
        return "host test crash port allocation failed";
    }
    if (mach_port_insert_right(mach_task_self(), service->port, service->port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS) {
        mach_port_destruct(mach_task_self(), service->port, -1, 0);
        free(service);
        return "host test crash port send right failed";
    }
    char *copy = strdup(arguments);
    size_t count = 0;
    if (*arguments) {
        count = 1;
        for (const char *character = arguments; *character; character++) {
            if (*character == '\n') count++;
        }
    }
    char **argv = calloc(count + 2, sizeof(char *));
    size_t environment_count = 0;
    while (environ[environment_count]) environment_count++;
    char **envp = calloc(environment_count + 2, sizeof(char *));
    if (!copy || !argv || !envp) {
        free(copy);
        free(argv);
        free(envp);
        mach_port_destruct(mach_task_self(), service->port, -1, 0);
        free(service);
        return "host test spawn allocation failed";
    }
    argv[0] = (char *)path;
    if (*copy) {
        char *token = copy;
        for (size_t index = 1;; index++) {
            char *end = strchr(token, '\n');
            if (end) *end = 0;
            argv[index] = token;
            if (!end) break;
            token = end + 1;
        }
    }
    for (size_t index = 0; index < environment_count; index++) envp[index] = environ[index];
    envp[environment_count] = (char *)environment;

    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    posix_spawn_file_actions_init(&actions);
    posix_spawnattr_init(&attributes);
    posix_spawn_file_actions_adddup2(&actions, output_fd, STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, output_fd, STDERR_FILENO);
    int error = posix_spawnattr_setexceptionports_np(&attributes, EXC_MASK_CRASH, service->port, EXCEPTION_DEFAULT | MACH_EXCEPTION_CODES,
        THREAD_STATE_NONE);
    if (!error) error = posix_spawn(&service->pid, path, &actions, &attributes, argv, envp);
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    free(copy);
    free(argv);
    free(envp);
    if (error) {
        mach_port_destruct(mach_task_self(), service->port, -1, 0);
        free(service);
        return "host test crash child could not be spawned";
    }
    error = pthread_create(&service->thread, NULL, crashServiceRun, service);
    if (error) {
        kill(service->pid, SIGKILL);
        waitpid(service->pid, NULL, 0);
        mach_port_destruct(mach_task_self(), service->port, -1, 0);
        free(service);
        return "host test crash service thread could not be created";
    }
    *pid = service->pid;
    *handle = (uintptr_t)service;
    return NULL;
}

// Waits for the child started by sp_host_test_spawn_handled_crash, ends its service and writes the raw wait status and the
// number of crash exceptions that the service answered. It returns NULL or an error message.
const char *sp_host_test_wait_handled_crash(uintptr_t handle, int *status, int *handled) {
    crash_service *service = (crash_service *)handle;
    pid_t reaped;
    do {
        reaped = waitpid(service->pid, status, 0);
    } while (reaped == -1 && errno == EINTR);
    mach_port_destruct(mach_task_self(), service->port, -1, 0);
    pthread_join(service->thread, NULL);
    *handled = atomic_load(&service->handled);
    int failed = service->failed;
    free(service);
    if (reaped == -1) return "host test crash child could not be waited for";
    if (failed) return "host test crash service failed";
    return NULL;
}

static const char *windowCreate(double width, double height, void **window, NSWindowStyleMask style, BOOL deferred) {
    if (!window) return "host test window result address is missing";
    *window = NULL;
    if (!pthread_main_np()) return "host test window creation requires the main thread";
    if (!(isfinite(width) && isfinite(height) && width > 0 && height > 0)) return "host test window size is not positive and finite";
    NSWindow *created = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, width, height)
                                                    styleMask:style
                                                      backing:NSBackingStoreBuffered
                                                        defer:deferred];
    created.releasedWhenClosed = NO;
    if (!created) return "host test window could not be created";
    created.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, width, height)] autorelease];
    *window = (void *)created;
    return NULL;
}

const char *sp_host_test_window_create(double width, double height, void **window) {
    return windowCreate(width, height, window, NSWindowStyleMaskBorderless, YES);
}

// The window that both frameworks give the host: a hidden title bar over a content view that fills the window, with the standard
// window buttons. Nothing orders it on screen.
const char *sp_host_test_window_create_titled(double width, double height, void **window) {
    const char *failure = windowCreate(width, height, window, NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
        | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable | NSWindowStyleMaskFullSizeContentView, NO);
    if (failure) return failure;
    NSWindow *created = (NSWindow *)*window;
    created.animationBehavior = NSWindowAnimationBehaviorNone;
    created.titlebarAppearsTransparent = YES;
    created.titleVisibility = NSWindowTitleHidden;
    return NULL;
}

#ifndef SP_HOST_TEST_FIXTURES
#error "SP_HOST_TEST_FIXTURES names the folder of the fixture pages (native/darwin/tests/fixtures)"
#endif

static const char mainLoadKey;

// The navigation delegate of the main web view of a test window: it keeps the result of the first navigation, which the wait of
// sp_host_test_webview_loaded reads.
@interface SPHostTestMainLoad : NSObject <WKNavigationDelegate> {
    dispatch_semaphore_t finished;
}
@property(nonatomic, copy) NSString *failure;
- (void)wait;
@end

@implementation SPHostTestMainLoad
- (instancetype)init {
    self = [super init];
    if (self) finished = dispatch_semaphore_create(0);
    return self;
}
- (void)dealloc {
    dispatch_release(finished);
    [_failure release];
    [super dealloc];
}
- (void)wait {
    dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
    dispatch_semaphore_signal(finished);
}
- (void)end:(NSError *)error {
    if (error) self.failure = [NSString stringWithFormat:@"the main page of the host test window did not load: %@", error.localizedDescription];
    dispatch_semaphore_signal(finished);
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation { [self end:nil]; }
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self end:error]; }
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error { [self end:error]; }
@end

const char *sp_host_test_window_main_webview(uintptr_t windowHandle, const char *fixture, void **webview) {
    // The window is the handle that the production native API takes (uintptr_t), as the hosts pass it.
    void *window = (void *)windowHandle;
    if (!webview) return "host test main web view result address is missing";
    *webview = NULL;
    if (!pthread_main_np()) return "host test main web view creation requires the main thread";
    if (!window) return "host test window is missing";
    if (!fixture || fixture[0] == '\0' || strchr(fixture, '/') != NULL || strcmp(fixture, "..") == 0) {
        return "host test fixture name is not a file name of the fixture folder";
    }
    NSWindow *host = (NSWindow *)window;
    if (!host.contentView) return "host test window has no content view";
    NSURL *folder = [NSURL fileURLWithPath:@SP_HOST_TEST_FIXTURES isDirectory:YES];
    NSURL *page = [folder URLByAppendingPathComponent:[NSString stringWithUTF8String:fixture]];
    WKWebView *created = [[[WKWebView alloc] initWithFrame:host.contentView.bounds configuration:[[[WKWebViewConfiguration alloc] init] autorelease]] autorelease];
    if (!created) return "host test main web view could not be created";
    created.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    SPHostTestMainLoad *load = [[[SPHostTestMainLoad alloc] init] autorelease];
    created.navigationDelegate = load;
    objc_setAssociatedObject(created, &mainLoadKey, load, OBJC_ASSOCIATION_RETAIN);
    [host.contentView addSubview:created];
    if (![created loadFileURL:page allowingReadAccessToURL:folder]) return "host test main page could not start loading";
    *webview = (void *)created;
    return NULL;
}

const char *sp_host_test_webview_loaded(void *webview) {
    if (pthread_main_np()) return "host test main web view wait requires a thread that is not the main thread";
    if (!webview) return "host test main web view is missing";
    SPHostTestMainLoad *load = objc_getAssociatedObject((WKWebView *)webview, &mainLoadKey);
    if (!load) return "host test web view is not the main web view of a host test window";
    [load wait];
    return load.failure ? load.failure.UTF8String : NULL;
}

const char *sp_host_test_window_close(void *window) {
    if (!pthread_main_np()) return "host test window closing requires the main thread";
    if (!window) return "host test window is missing";
    NSWindow *object = (NSWindow *)window;
    [object close];
    [object release];
    return NULL;
}

// The fault point SOKSAK_FAULT_VIEW_PRESENTATION=hold of the production library holds the callback of each presentation wait of a
// web view until the release notification of its process (native/darwin/src/webview.m). Posting the release name of this process
// releases the callbacks of this process that are held and no later one.
const char *sp_host_test_view_presentation_release(void) {
    char name[64];
    sp_view_presentation_fault_release_name(getpid(), name, sizeof name);
    if (notify_post(name) != NOTIFY_STATUS_OK) return "host test release of the held presentations could not be posted";
    return NULL;
}

// The functions of the production library that the reads below call, installed by sp_host_test_install_production_functions.
static bool (*productionKeysWaitState)(void *owner, bool *decision, bool *modal);
static void (*productionKeysWaitOpen)(void *owner, bool decision);
static bool (*productionRegionRaster)(void *region, double *out);
static bool (*productionRegionPresent)(void *region, unsigned int token_id, const unsigned char *nonce, double width, double height,
    double scale, uint64_t generation, uint64_t raster, int sequence);
static bool (*productionEvent)(uint8_t eventClass, uint8_t level, const char *name, const char *fields_json);
static bool productionFunctionsInstalled;

const char *sp_host_test_install_production_functions(uintptr_t keys_wait_state, uintptr_t keys_wait_open, uintptr_t region_raster,
    uintptr_t region_present, uintptr_t event) {
    if (productionFunctionsInstalled) return "host test production functions are already installed";
    if (!keys_wait_state || !keys_wait_open || !region_raster || !region_present || !event) return "host test production function is missing";
    productionKeysWaitState = (bool (*)(void *, bool *, bool *))keys_wait_state;
    productionKeysWaitOpen = (void (*)(void *, bool))keys_wait_open;
    productionRegionRaster = (bool (*)(void *, double *))region_raster;
    productionRegionPresent = (bool (*)(void *, unsigned int, const unsigned char *, double, double, double, uint64_t, uint64_t, int))region_present;
    productionEvent = (bool (*)(uint8_t, uint8_t, const char *, const char *))event;
    productionFunctionsInstalled = true;
    return NULL;
}

static char eventRefusal[160];

const char *sp_host_test_emit_event(uint8_t event_class, uint8_t level, const char *name, const char *fields) {
    if (!productionFunctionsInstalled) return "host test production functions are not installed";
    if (!name || !fields) return "host test event name or fields are missing";
    if (productionEvent(event_class, level, name, fields)) return NULL;
    snprintf(eventRefusal, sizeof eventRefusal, "the native library refused the event %s (class %u, level %u)", name, event_class, level);
    return eventRefusal;
}

static const char *requireProduction(void) {
    if (!pthread_main_np()) return "host test read of the production library requires the main thread";
    if (!productionFunctionsInstalled) return "host test production functions are not installed";
    return NULL;
}

static void countRegions(NSView *view, Class region, uint64_t *count) {
    if ([view isKindOfClass:region]) (*count)++;
    for (NSView *child in view.subviews) countRegions(child, region, count);
}

const char *sp_host_test_window_image_regions(uintptr_t windowHandle, uint64_t *count) {
    // The window is the handle that the production native API takes (uintptr_t), as the hosts pass it.
    void *window = (void *)windowHandle;
    if (!count) return "host test image region count address is missing";
    *count = 0;
    if (!pthread_main_np()) return "host test read of the production library requires the main thread";
    if (!window) return "host test window is missing";
    Class region = NSClassFromString(@"SPImageRegion");
    if (!region) return "host test read of the production library requires the production library in the process";
    NSView *content = ((NSWindow *)window).contentView;
    if (!content) return "host test window has no content view";
    countRegions(content, region, count);
    return NULL;
}

const char *sp_host_test_window_keys_wait(uintptr_t windowHandle, bool *waiting, bool *decision, bool *modal) {
    // The window is the handle that the production native API takes (uintptr_t), as the hosts pass it.
    void *window = (void *)windowHandle;
    if (!waiting || !decision || !modal) return "host test key wait result address is missing";
    *waiting = *decision = *modal = false;
    const char *refused = requireProduction();
    if (refused) return refused;
    if (!window) return "host test window is missing";
    *waiting = productionKeysWaitState(window, decision, modal);
    return NULL;
}

const char *sp_host_test_window_open_key_wait(uintptr_t windowHandle, bool decision) {
    // The window is the handle that the production native API takes (uintptr_t), as the hosts pass it.
    void *window = (void *)windowHandle;
    const char *refused = requireProduction();
    if (refused) return refused;
    if (!window) return "host test window is missing";
    productionKeysWaitOpen(window, decision);
    return NULL;
}

static char presentRefusal[160];

const char *sp_host_test_region_present_lease(void *region, uint64_t generation, uint64_t raster, int sequence) {
    const char *refused = requireProduction();
    if (refused) return refused;
    if (!region) return "host test region is missing";
    double native[3] = {0};
    if (!productionRegionRaster(region, native)) return "host test region has no native raster: it is not placed in a laid-out surface";
    unsigned char nonce[16];
    arc4random_buf(nonce, sizeof nonce);
    void *frame = sp_host_test_frame_create((int)native[0], (int)native[1], nonce);
    if (!frame) return "host test frame could not be created";
    bool accepted = productionRegionPresent(region, sp_host_test_frame_id(frame), nonce, native[0], native[1], native[2], generation, raster, sequence);
    sp_host_test_frame_release(frame);
    if (accepted) return NULL;
    snprintf(presentRefusal, sizeof presentRefusal, "host test region refused the frame of generation %llu, raster %llu, sequence %d",
        (unsigned long long)generation, (unsigned long long)raster, sequence);
    return presentRefusal;
}
