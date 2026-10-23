#import <Foundation/Foundation.h>
#include <dlfcn.h>
#import "soksak_process_identity.h"
#import "private/process_identity_internal.h"

static int failures;
static int registerStatus;
static int setStatus;
static SPLSASNRef currentASN;
static CFTypeRef copiedName;
static NSUInteger registerCalls;
static NSUInteger asnCalls;
static NSUInteger setCalls;
static NSUInteger copyCalls;
static CFTypeRef setValue;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
static OSStatus registerApplication(CFDictionaryRef info, ProcessSerialNumber *serial) {
    (void)info; (void)serial; registerCalls++; return registerStatus;
}
static SPLSASNRef currentApplicationASN(void) { asnCalls++; return currentASN; }
static OSStatus setApplicationInformationItem(SPLSSessionID session, SPLSASNRef asn, CFStringRef key,
    CFTypeRef value, CFDictionaryRef *information) {
    (void)session; (void)asn; (void)key; (void)information; setCalls++;
    setValue = value ? CFRetain(value) : NULL; return setStatus;
}
static CFTypeRef copyApplicationInformationItem(SPLSSessionID session, SPLSASNRef asn, CFTypeRef key) {
    (void)session; (void)asn; (void)key; copyCalls++; return copiedName ? CFRetain(copiedName) : NULL;
}
static const SPProcessIdentityServices fakeServices = {
    .register_application = registerApplication,
    .current_application_asn = currentApplicationASN,
    .set_application_information_item = setApplicationInformationItem,
    .copy_application_information_item = copyApplicationInformationItem,
};
static void resetServices(void) {
    registerStatus = noErr; setStatus = noErr; currentASN = (SPLSASNRef)0x1;
    if (copiedName) CFRelease(copiedName);
    copiedName = CFStringCreateWithCString(kCFAllocatorDefault, "soksak://sidecar/probe", kCFStringEncodingASCII);
    registerCalls = asnCalls = setCalls = copyCalls = 0;
    if (setValue) CFRelease(setValue);
    setValue = NULL;
}

int main(void) { @autoreleasepool {
    void *symbol = dlsym(RTLD_DEFAULT, "soksak_process_set_display_name");
    check(symbol != NULL, @"the process identity API is linked");
    if (!symbol) return 1;
    typedef int (*SetDisplayName)(const char *, char *, size_t);
    SetDisplayName setDisplayName = (SetDisplayName)symbol;
    void *seamSymbol = dlsym(RTLD_DEFAULT, "sp_process_set_display_name_with_services");
    check(seamSymbol != NULL, @"the native test build exposes its injected service seam");
    if (!seamSymbol) return 1;
    typedef int (*SetWithServices)(const char *, char *, size_t, const SPProcessIdentityServices *);
    SetWithServices setWithServices = (SetWithServices)seamSymbol;
    char error[512] = {0};

    resetServices();
    check(setWithServices("soksak://sidecar/Probe", error, sizeof(error), &fakeServices) != 0 &&
        strstr(error, "invalid process display name") != NULL && registerCalls == 0,
        @"an invalid display name fails before LaunchServices registration");
    resetServices(); registerStatus = -5;
    check(setWithServices("soksak://sidecar/probe", error, sizeof(error), &fakeServices) == -5 &&
        strstr(error, "LaunchServices registration failed with status -5") != NULL && asnCalls == 0,
        @"a registration failure is returned with its operation and status");
    resetServices(); currentASN = NULL;
    check(setWithServices("soksak://sidecar/probe", error, sizeof(error), &fakeServices) != 0 &&
        strstr(error, "current process ASN") != NULL && setCalls == 0,
        @"a missing current process ASN is reported");
    resetServices(); setStatus = -7;
    check(setWithServices("soksak://sidecar/probe", error, sizeof(error), &fakeServices) == -7 &&
        strstr(error, "LaunchServices display name set failed with status -7") != NULL && copyCalls == 0,
        @"a display-name set failure is returned with its operation and status");
    resetServices();
    CFRelease(copiedName);
    copiedName = CFStringCreateWithCString(kCFAllocatorDefault, "soksak://sidecar/other", kCFStringEncodingASCII);
    check(setWithServices("soksak://sidecar/probe", error, sizeof(error), &fakeServices) != 0 &&
        strstr(error, "LaunchServices display name readback") != NULL,
        @"a mismatched display-name readback fails");
    resetServices();
    check(setWithServices("soksak://sidecar/probe", error, sizeof(error), &fakeServices) == 0 &&
        setValue != NULL && CFEqual(setValue, copiedName) && registerCalls == 1 && asnCalls == 1 && setCalls == 1 && copyCalls == 1,
        @"the service sequence sets and verifies the exact display name");

    memset(error, 0, sizeof(error));
    int status = setDisplayName("soksak://sidecar/probe", error, sizeof(error));
    check(status == 0, [NSString stringWithFormat:@"LaunchServices accepts the production display name: %s", error]);
    check(setDisplayName("soksak://sidecar/Bad", error, sizeof(error)) != 0 &&
        strstr(error, "invalid process display name") != NULL,
        @"the public API rejects an invalid display name with an explicit error");
    if (copiedName) CFRelease(copiedName);
    if (setValue) CFRelease(setValue);
    return failures ? 1 : 0;
} }
