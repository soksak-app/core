# macOS process display identity

A child process that represents a declared sidecar registers its LaunchServices display name before initializing its domain runtime. A process declaration supplies the complete display identity URI; the display identity is separate from the package name, dependency key, executable path, and executable basename. The process keeps its executable path and bundle identity unchanged.

Core provides the macOS implementation at `native/darwin/process-identity` as the versioned private package `@soksak/native-process-identity-darwin` (version `0.0.20`). The package declares `os: ["darwin"]`; non-Darwin package managers skip it, and callers compile and invoke it only in Darwin builds. It contains a static library, public C header, and relocatable pkg-config metadata. Sidecar build systems pin the Git subdirectory as an explicit build dependency and statically link it; the resulting executable has no runtime dependency on the package, its static library, or a core checkout path. macOS system frameworks remain link dependencies.

For a sidecar, the host-supplied `display_name` is the exact declared `displayName` URI `soksak://sidecar/<id>`. The public function is:

```c
int soksak_process_set_display_name(
    const char *display_name,
    char *error,
    size_t error_capacity);
```

`display_name` must be a NUL-terminated ASCII URI with the exact prefix `soksak://sidecar/` and one lowercase identifier segment matching `[a-z][a-z0-9-]*`. The function returns `0` only after LaunchServices registration succeeds, the current process ASN is available, setting the display name succeeds, and a readback exactly matches the requested value. It returns nonzero for invalid arguments, invalid identity, or any LaunchServices failure. On failure, when `error` and `error_capacity` permit, it writes a NUL-terminated diagnostic naming the failed operation and status. Callers treat every nonzero result as startup failure and report the diagnostic; they do not continue with a generic process name.

The artifact's pkg-config file resolves include and static-library paths relative to its own installed location. Its package build does not read or link files through an absolute core checkout path. A packed-package consumer test installs the tarball separately, resolves pkg-config from the installed package, compiles and runs a static consumer, and verifies that the executable has no runtime dependency on the package path. The core owning native tests exercise the public API with invalid identities, injected registration/set failures, and mismatched readback, as well as a successful exact display-name registration. Sidecar repositories test startup behavior at their own boundary.
