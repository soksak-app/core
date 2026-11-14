#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <errno.h>
#import "soksak_process_identity.h"
#import "private/process_identity_internal.h"

static int failures;

static void check(BOOL condition, NSString *message) {
    fprintf(condition ? stdout : stderr, "%s: %s\n", condition ? "PASS" : "FAIL", message.UTF8String);
    if (!condition) failures++;
}
// The fault point SOKSAK_FAULT_PROCESS_IDENTITY of the diagnostics build replaces the result of one LaunchServices call after the
// real call ran; each case sets it for the failure that the real LaunchServices does not produce on demand.
static void setFault(const char *fault) {
    if (fault) setenv("SOKSAK_FAULT_PROCESS_IDENTITY", fault, 1);
    else unsetenv("SOKSAK_FAULT_PROCESS_IDENTITY");
}

int main(void) { @autoreleasepool {
    void *symbol = dlsym(RTLD_DEFAULT, "soksak_process_set_display_name");
    check(symbol != NULL, @"the process identity API is linked");
    if (!symbol) return 1;
    typedef int (*SetDisplayName)(const char *, char *, size_t);
    SetDisplayName setDisplayName = (SetDisplayName)symbol;
    char error[512] = {0};

    // This case runs before any other registration of the process, so the observation shows the first listed name: the process
    // registers with the check-in dictionary of the production API and the real LaunchServices lists the display name.
    CFStringRef probe = CFSTR("soksak://sidecar/probe");
    CFDictionaryRef info = sp_process_copy_check_in_information(probe);
    check(info != NULL && _RegisterApplication(info, NULL) == noErr, @"the real LaunchServices registers the process with the production check-in dictionary");
    if (info) CFRelease(info);
    CFTypeRef registeredName = _LSCopyApplicationInformationItem(SPLSDefaultSessionID, _LSGetCurrentApplicationASN(), _kLSDisplayNameKey);
    check(registeredName != NULL && CFGetTypeID(registeredName) == CFStringGetTypeID() && CFEqual(registeredName, probe),
        [NSString stringWithFormat:@"LaunchServices lists the process with its display name from its registration: found %@", registeredName]);
    if (registeredName) CFRelease(registeredName);

    // A fault that follows the failing call is never reached, so an error that names the failing call shows that the later calls did not run.
    setFault("register:-5");
    check(setDisplayName("soksak://sidecar/Probe", error, sizeof(error)) != 0 &&
        strstr(error, "invalid process display name") != NULL,
        @"an invalid display name fails before LaunchServices registration");
    setFault("register:-5,asn,set:-7,readback:none");
    check(setDisplayName("soksak://sidecar/probe", error, sizeof(error)) == -5 &&
        strstr(error, "LaunchServices registration failed with status -5") != NULL,
        [NSString stringWithFormat:@"a registration failure is returned with its operation and status, before the ASN is read: %s", error]);
    setFault("asn,set:-7,readback:none");
    check(setDisplayName("soksak://sidecar/probe", error, sizeof(error)) != 0 &&
        strstr(error, "current process ASN") != NULL,
        [NSString stringWithFormat:@"a missing current process ASN is reported before the display name is set: %s", error]);
    setFault("set:-7,readback:none");
    check(setDisplayName("soksak://sidecar/probe", error, sizeof(error)) == -7 &&
        strstr(error, "LaunchServices display name set failed with status -7") != NULL,
        [NSString stringWithFormat:@"a display-name set failure is returned with its operation and status, before the readback: %s", error]);
    setFault("readback:string:soksak://sidecar/other");
    check(setDisplayName("soksak://sidecar/probe", error, sizeof(error)) != 0 &&
        strstr(error, "LaunchServices display name readback found \"soksak://sidecar/other\", expected \"soksak://sidecar/probe\"") != NULL,
        [NSString stringWithFormat:@"a mismatched display-name readback fails and names the value it found: %s", error]);
    setFault("readback:none");
    check(setDisplayName("soksak://sidecar/probe", error, sizeof(error)) == EIO &&
        strstr(error, "LaunchServices display name readback found no value") != NULL,
        [NSString stringWithFormat:@"a display-name readback without a value names the missing value: %s", error]);
    setFault("readback:boolean");
    check(setDisplayName("soksak://sidecar/probe", error, sizeof(error)) == EIO &&
        strstr(error, "LaunchServices display name readback found a value of type CFBoolean") != NULL,
        [NSString stringWithFormat:@"a display-name readback of another type names the type: %s", error]);

    setFault(NULL);
    memset(error, 0, sizeof(error));
    // LaunchServices applies the check-in dictionary only at the first registration, so a name that differs from the first one is
    // listed only when the set call of the sequence made it exact.
    CFStringRef second = CFSTR("soksak://sidecar/second");
    check(setDisplayName("soksak://sidecar/second", error, sizeof(error)) == 0,
        [NSString stringWithFormat:@"LaunchServices accepts the production display name: %s", error]);
    CFTypeRef verified = _LSCopyApplicationInformationItem(SPLSDefaultSessionID, _LSGetCurrentApplicationASN(), _kLSDisplayNameKey);
    check(verified != NULL && CFGetTypeID(verified) == CFStringGetTypeID() && CFEqual(verified, second),
        @"the real LaunchServices readback holds the exact display name that the sequence set");
    if (verified) CFRelease(verified);
    check(setDisplayName("soksak://sidecar/Bad", error, sizeof(error)) != 0 &&
        strstr(error, "invalid process display name") != NULL,
        @"the public API rejects an invalid display name with an explicit error");
    return failures ? 1 : 0;
} }
