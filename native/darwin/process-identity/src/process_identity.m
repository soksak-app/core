#import <Foundation/Foundation.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#import "soksak_process_identity.h"
#import "private/process_identity_internal.h"

static void setError(char *error, size_t capacity, const char *operation, int status) {
    if (error == NULL || capacity == 0) return;
    snprintf(error, capacity, "%s failed with status %d", operation, status);
}

static BOOL validDisplayName(const char *name) {
    static const char prefix[] = "soksak://sidecar/";
    if (name == NULL || strncmp(name, prefix, sizeof(prefix) - 1) != 0) return NO; // silent: this predicate rejects names that the caller reports as invalid.
    const unsigned char *id = (const unsigned char *)name + sizeof(prefix) - 1;
    if (*id < 'a' || *id > 'z') return NO; // silent: this predicate rejects ids that the caller reports as invalid.
    for (; *id; id++) {
        if ((*id >= 'a' && *id <= 'z') || (*id >= '0' && *id <= '9') || *id == '-') continue;
        return NO; // silent: this predicate rejects characters that the caller reports as an invalid display name.
    }
    return YES;
}

#ifdef SOKSAK_PROCESS_IDENTITY_DIAGNOSTICS
// The fault point SOKSAK_FAULT_PROCESS_IDENTITY is a comma-separated list of the failures that the real LaunchServices does not
// produce on demand: register:<status> and set:<status> replace the status that the call returned, asn replaces the current
// process ASN with none, and readback:none, readback:boolean and readback:string:<name> replace the value that the readback
// returned. The real calls run before a fault replaces their result. Only the diagnostics build reads it. fault returns whether
// the list names the fault and copies its argument (empty when it has none) into value.
static bool fault(const char *name, char *value, size_t capacity) {
    const char *list = getenv("SOKSAK_FAULT_PROCESS_IDENTITY");
    size_t length = strlen(name);
    while (list != NULL && *list) {
        const char *end = strchr(list, ',');
        size_t itemLength = end ? (size_t)(end - list) : strlen(list);
        if (itemLength >= length && strncmp(list, name, length) == 0 && (itemLength == length || list[length] == ':')) {
            size_t argument = itemLength == length ? 0 : itemLength - length - 1;
            if (argument >= capacity) argument = capacity - 1;
            memcpy(value, list + (itemLength == length ? itemLength : length + 1), argument);
            value[argument] = '\0';
            return true;
        }
        list = end ? end + 1 : NULL;
    }
    return false;
}
#endif

// The check-in dictionary carries the display name, so LaunchServices lists the process with that name from the moment
// it registers it. A registration without the name lists the executable name until the set call, and a process
// that reads the list in that interval receives the executable name. LaunchServices applies the dictionary only at the
// first registration of a process; the set call makes the name exact for a process that is already registered.
static CFDictionaryRef copyCheckInInformation(CFStringRef requested) {
    const void *infoKeys[] = {_kLSDisplayNameKey};
    const void *infoValues[] = {requested};
    return CFDictionaryCreate(kCFAllocatorDefault, infoKeys, infoValues, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
}

int soksak_process_set_display_name(const char *display_name, char *error, size_t error_capacity) {
    if (error && error_capacity) error[0] = '\0';
    if (!validDisplayName(display_name)) {
        setError(error, error_capacity, "invalid process display name", EINVAL);
        return EINVAL;
    }
    CFStringRef requested = CFStringCreateWithCString(kCFAllocatorDefault, display_name, kCFStringEncodingASCII);
    if (requested == NULL) {
        setError(error, error_capacity, "creating process display name", EINVAL);
        return EINVAL;
    }
    CFDictionaryRef info = copyCheckInInformation(requested);
    if (info == NULL) {
        setError(error, error_capacity, "creating LaunchServices check-in information", ENOMEM);
        CFRelease(requested);
        return ENOMEM;
    }
    OSStatus status = _RegisterApplication(info, NULL);
    CFRelease(info);
#ifdef SOKSAK_PROCESS_IDENTITY_DIAGNOSTICS
    char argument[256];
    if (fault("register", argument, sizeof(argument))) status = (OSStatus)atoi(argument);
#endif
    if (status != noErr) {
        setError(error, error_capacity, "LaunchServices registration", (int)status);
        CFRelease(requested);
        return (int)status;
    }
    SPLSASNRef asn = _LSGetCurrentApplicationASN();
#ifdef SOKSAK_PROCESS_IDENTITY_DIAGNOSTICS
    if (fault("asn", argument, sizeof(argument))) asn = NULL;
#endif
    if (asn == NULL) {
        setError(error, error_capacity, "current process ASN", EINVAL);
        CFRelease(requested);
        return EINVAL;
    }
    status = _LSSetApplicationInformationItem(SPLSDefaultSessionID, asn, _kLSDisplayNameKey, requested, NULL);
#ifdef SOKSAK_PROCESS_IDENTITY_DIAGNOSTICS
    if (fault("set", argument, sizeof(argument))) status = (OSStatus)atoi(argument);
#endif
    if (status != noErr) {
        setError(error, error_capacity, "LaunchServices display name set", (int)status);
        CFRelease(requested);
        return (int)status;
    }
    CFTypeRef copied = _LSCopyApplicationInformationItem(SPLSDefaultSessionID, asn, _kLSDisplayNameKey);
#ifdef SOKSAK_PROCESS_IDENTITY_DIAGNOSTICS
    if (fault("readback", argument, sizeof(argument))) {
        if (copied) CFRelease(copied);
        if (strcmp(argument, "none") == 0) copied = NULL;
        else if (strcmp(argument, "boolean") == 0) copied = CFRetain(kCFBooleanTrue);
        else if (strncmp(argument, "string:", 7) == 0) {
            copied = CFStringCreateWithCString(kCFAllocatorDefault, argument + 7, kCFStringEncodingASCII);
        } else {
            if (error && error_capacity) snprintf(error, error_capacity, "unknown readback fault %s", argument);
            CFRelease(requested);
            return EINVAL;
        }
    }
#endif
    BOOL matches = copied != NULL && CFGetTypeID(copied) == CFStringGetTypeID() && CFEqual(copied, requested);
    // The error names the value that LaunchServices returned, so a failed readback shows whether the value was missing,
    // of another type or another name. The caller holds no autorelease pool, so the text is built in one.
    if (!matches && error && error_capacity) @autoreleasepool {
        NSString *found = copied == NULL ? @"no value"
            : CFGetTypeID(copied) != CFStringGetTypeID()
                ? [NSString stringWithFormat:@"a value of type %@", CFBridgingRelease(CFCopyTypeIDDescription(CFGetTypeID(copied)))]
                : [NSString stringWithFormat:@"\"%@\"", (__bridge NSString *)copied];
        snprintf(error, error_capacity, "LaunchServices display name readback found %s, expected \"%s\"", found.UTF8String, display_name);
    }
    if (copied) CFRelease(copied);
    CFRelease(requested);
    if (!matches) return EIO;
    return 0;
}

#ifdef SOKSAK_PROCESS_IDENTITY_TESTING
CFDictionaryRef sp_process_copy_check_in_information(CFStringRef display_name) {
    return copyCheckInInformation(display_name);
}
#endif
