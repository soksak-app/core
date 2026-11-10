// Checks the memory of a document response (docs/spec/native-surfaces.md#document-regions): the host holds no whole copy of a
// plugin file while it answers a request, so the page receives every byte of a large file, no single allocation of the process
// reaches the size of the file, and the footprint of the process neither peaks nor stays at the size of the file. A core root
// answer sends the bytes of the resolver without a second whole copy.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <libproc.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/resource.h>
#include <unistd.h>
#import "private/malloc.h"
#import "support/event_wait.h"
#import "support/temporary_folder.h"
#import "support/view_import_map.h"
#import "document_view.h"
#import "webview_geometry.h"
#import "window_facts.h"

static const uint32_t typeAllocate = 2;
static const uint32_t typeDeallocate = 4;
// The size of a large file that a plugin ships.
static const size_t kFileBytes = 24 * 1024 * 1024;
static const size_t kCoreBytes = 16 * 1024 * 1024;
// An allocation of this size or more is far above the bytes of one chunk of a response.
static const size_t kWholeCopyBytes = 1024 * 1024;
static atomic_size_t largest = 0;

static void logger(uint32_t type, uintptr_t arg1, uintptr_t arg2, uintptr_t arg3, uintptr_t result, uint32_t skip) {
    (void)arg1; (void)result; (void)skip;
    if (!(type & typeAllocate)) return;
    size_t size = (type & typeDeallocate) ? arg3 : arg2;
    size_t seen = atomic_load(&largest);
    while (size > seen && !atomic_compare_exchange_weak(&largest, &seen, size)) {}
}

static int failures = 0;
// The weak reference to the closed region.
static id closedRegion;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}

// Waits for a JavaScript round trip with the document. Its reply comes after every message that the web content process of the
// document sent before it, so the work that the host does for the earlier messages of a load has run when it returns.
static void roundTrip(void *document, NSString *what) {
    __block BOOL answered = NO;
    [(WKWebView *)document evaluateJavaScript:@"null" completionHandler:^(id value, NSError *error) {
        (void)value; (void)error;
        answered = YES;
    }];
    eventWait(what, ^BOOL { return answered; });
}

// Whether the object of the weak reference has gone. The weak load autoreleases the object it returns, so it is read inside its
// own pool and does not hold the object itself.
static BOOL gone(id *reference) {
    BOOL alive;
    @autoreleasepool { alive = objc_loadWeak(reference) != nil; }
    return !alive;
}

static double footprintMiB(BOOL peak) {
    struct rusage_info_v4 usage;
    if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) { perror("proc_pid_rusage"); exit(1); }
    return (peak ? usage.ri_lifetime_max_phys_footprint : usage.ri_phys_footprint) / 1048576.0;
}

static NSDictionary *latest;

static void changed(void *context, const char *text) {
    (void)context;
    [latest release];
    latest = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:text length:strlen(text)] options:0 error:nil] retain];
}

static NSString *prepareFile(NSString *root, NSString *path) {
    NSString *file = [root stringByAppendingPathComponent:path];
    [[NSFileManager defaultManager] createDirectoryAtPath:file.stringByDeletingLastPathComponent
        withIntermediateDirectories:YES attributes:nil error:nil];
    return file;
}

static void writeFile(NSString *root, NSString *path, NSData *data) {
    [data writeToFile:prepareFile(root, path) atomically:YES];
}

static NSData *text(NSString *value) { return [value dataUsingEncoding:NSUTF8StringEncoding]; }

static uint8_t patternByte(size_t index) { return (uint8_t)(index * 31 + (index >> 16)); }

// Writes the pattern through a small buffer, so the check itself does not raise the peak footprint that it reads.
static void writePattern(NSString *root, NSString *path, size_t length) {
    FILE *file = fopen(prepareFile(root, path).fileSystemRepresentation, "wb");
    if (!file) { perror("fopen"); exit(1); }
    uint8_t buffer[64 * 1024];
    for (size_t index = 0; index < length;) {
        size_t count = MIN(length - index, sizeof buffer);
        for (size_t offset = 0; offset < count; offset++) buffer[offset] = patternByte(index + offset);
        if (fwrite(buffer, 1, count, file) != count) { perror("fwrite"); exit(1); }
        index += count;
    }
    fclose(file);
}

static uint32_t patternSum(size_t length) {
    uint32_t sum = 0;
    for (size_t index = 0; index < length; index++) sum = (sum + patternByte(index)) & 0xffffff;
    return sum;
}

static bool resolveCore(void *context, const char *plugin, const char *path, void **bytes, size_t *length, char **type) {
    (void)context; (void)plugin;
    if (strcmp(path, "/modules/probe/large.bin") != 0) return false;
    *length = kCoreBytes;
    uint8_t *written = malloc(kCoreBytes);
    for (size_t index = 0; index < kCoreBytes; index++) written[index] = patternByte(index);
    *bytes = written;
    *type = strdup("application/octet-stream");
    return true;
}

// The page reads the address and writes its length and the sum of its bytes to the title.
static NSString *readerPage(NSString *address) {
    return [NSString stringWithFormat:@"<!doctype html><meta charset=utf-8><title>loading</title><script type=module>"
        "const body = new Uint8Array(await (await fetch('%@')).arrayBuffer());"
        "let sum = 0; for (const value of body) sum = (sum + value) & 0xffffff;"
        "document.title = `read ${body.length} ${sum}`;"
        "</script>", address];
}

int main(void) { @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSString *temporary = temporaryFolder(@"soksak-document-response-memory-");
    NSString *folder = [temporary stringByAppendingPathComponent:@"plugin"];
    sp_view_import_map_set(viewImportMapFixture().UTF8String);
    sp_core_root_set_resolver(resolveCore, NULL);
    writePattern(folder, @"ui/app/large.bin", kFileBytes);
    writeFile(folder, @"ui/app/empty.bin", [NSData data]);
    writeFile(folder, @"ui/app/index.html", text(readerPage(@"./large.bin")));
    writeFile(folder, @"ui/app/nothing.html", text(readerPage(@"./empty.bin")));
    writeFile(folder, @"ui/app/core.html", text(readerPage(@"soksak://core/modules/probe/large.bin")));

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100, 100, 500, 400)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    [window setReleasedWhenClosed:NO];
    window.contentView = [[[NSView alloc] initWithFrame:NSMakeRect(0, 0, 500, 400)] autorelease];
    WKWebView *main = [[[WKWebView alloc] initWithFrame:window.contentView.bounds] autorelease];
    [window.contentView addSubview:main];
    [window orderBack:nil];
    void *surface = sp_surface_create(sp_window_set_main_webview(main.window, main));
    webviewSetFrame(surface, 0, 0, 500, 400);
    webviewSetSurfaceHidden(surface, false);
    NSString *store = [temporary stringByAppendingPathComponent:@"store"];

    @autoreleasepool {
        double before = 0;
        double fileMiB = kFileBytes / 1048576.0;
        // The region and every autoreleased reference to it live in this pool, so the closed region is released at its end.
        @autoreleasepool {
            void *region = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", NULL, NULL, changed, NULL);
            check(region != NULL, @"a region is created");
            sp_document_place(region, 0, 0, 0, 0, true);

            check(sp_document_load(region, "soksak://probe/ui/app/nothing.html"), @"the page of an empty file starts a load");
            eventWait(@"the page reads an empty file", ^BOOL{ return [latest[@"title"] hasPrefix:@"read"]; });
            check([latest[@"title"] isEqual:@"read 0 0"], [NSString stringWithFormat:@"an empty file answers no bytes: %@", latest[@"title"]]);

            roundTrip(region, @"the region answers after the empty file");
            before = footprintMiB(NO);
            double peakBefore = footprintMiB(YES);
            atomic_store(&largest, 0);
            malloc_logger = logger;
            check(sp_document_load(region, "soksak://probe/ui/app/index.html"), @"the page of a large file starts a load");
            eventWait(@"the page reads a large file", ^BOOL{ return [latest[@"title"] hasPrefix:@"read 2"]; });
            malloc_logger = NULL;
            NSString *expected = [NSString stringWithFormat:@"read %zu %u", kFileBytes, patternSum(kFileBytes)];
            check([latest[@"title"] isEqual:expected],
                [NSString stringWithFormat:@"the page receives every byte of the file: %@, expected %@", latest[@"title"], expected]);
            size_t biggest = atomic_load(&largest);
            check(biggest < kWholeCopyBytes,
                [NSString stringWithFormat:@"the largest allocation of the response is %zu bytes, below %zu", biggest, kWholeCopyBytes]);

            roundTrip(region, @"the region answers after the large file");
            double peak = footprintMiB(YES);
            double after = footprintMiB(NO);
            check(peak - peakBefore < fileMiB * 0.75,
                [NSString stringWithFormat:@"the peak footprint rises by %.1f MiB for a file of %.0f MiB", peak - peakBefore, fileMiB]);
            check(after - before < fileMiB / 2,
                [NSString stringWithFormat:@"the footprint stays %.1f MiB above its start after a file of %.0f MiB", after - before, fileMiB]);
            objc_storeWeak(&closedRegion, (id)region);
            sp_document_close(region);
        }
        // WebKit can release the last references of a closed web view on a later turn of the main run loop. A reference that such
        // a turn autoreleases ends with the pool that each judgment drains.
        __block NSAutoreleasePool *turnPool = [NSAutoreleasePool new];
        eventWait(@"the last reference to the closed region goes", ^BOOL {
            [turnPool drain];
            turnPool = [NSAutoreleasePool new];
            return gone(&closedRegion);
        });
        [turnPool drain];
        double closed = footprintMiB(NO);
        check(closed - before < fileMiB / 2,
            [NSString stringWithFormat:@"the footprint stays %.1f MiB above its start after the region closes", closed - before]);

        void *view = sp_document_create(surface, store.fileSystemRepresentation, folder.fileSystemRepresentation, "probe", NULL, "", changed, NULL);
        check(view != NULL, @"a view is created");
        sp_document_place(view, 0, 0, 0, 0, true);
        [latest release];
        latest = nil;
        roundTrip(view, @"the new view answers");
        double corePeakBefore = footprintMiB(YES);
        check(sp_document_load(view, "soksak://probe/ui/app/core.html"), @"the page of a core file starts a load");
        eventWait(@"the page reads a core file", ^BOOL{ return [latest[@"title"] hasPrefix:@"read 16"]; });
        NSString *expectedCore = [NSString stringWithFormat:@"read %zu %u", kCoreBytes, patternSum(kCoreBytes)];
        check([latest[@"title"] isEqual:expectedCore],
            [NSString stringWithFormat:@"the page receives every byte of the core file: %@, expected %@", latest[@"title"], expectedCore]);
        roundTrip(view, @"the view answers after the core file");
        double coreRise = footprintMiB(YES) - corePeakBefore;
        double coreMiB = kCoreBytes / 1048576.0;
        check(coreRise < coreMiB * 1.75,
            [NSString stringWithFormat:@"the peak footprint rises by %.1f MiB for the %.0f MiB of the resolver, so they have no second whole copy", coreRise, coreMiB]);
        sp_document_close(view);
    }
    sp_surface_close(surface);
    [window close];
    if (failures) fprintf(stderr, "%d failures\n", failures);
    return failures ? 1 : 0;
}}
