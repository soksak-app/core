// Embeds the version of package.json and the displayName of sidecar.json, and links the core process identity library
// (docs/spec/process-identity.md): the fixture lives in the core checkout, so the folder native/darwin/process-identity of that
// checkout is its pinned build dependency, built with its own Makefile and linked statically.
use std::path::PathBuf;
use std::process::Command;

fn read_json(path: &PathBuf) -> serde_json::Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let package = root.join("package.json");
    let sidecar = root.join("sidecar.json");
    println!("cargo:rerun-if-changed={}", package.display());
    println!("cargo:rerun-if-changed={}", sidecar.display());
    let version = read_json(&package)["version"].as_str().expect("package.json has a version").to_string();
    let display = read_json(&sidecar)["displayName"].as_str().expect("sidecar.json has a displayName").to_string();
    println!("cargo:rustc-env=RASTERPROBE_VERSION={version}");
    println!("cargo:rustc-env=RASTERPROBE_DISPLAY_NAME={display}");

    let identity = root.join("../../../../native/darwin/process-identity");
    let identity = identity.canonicalize().unwrap_or_else(|error| panic!("{}: {error}", identity.display()));
    println!("cargo:rerun-if-changed={}", identity.join("src").display());
    println!("cargo:rerun-if-changed={}", identity.join("include").display());
    let status = Command::new("make")
        .arg("-C")
        .arg(&identity)
        .arg("build")
        .status()
        .unwrap_or_else(|error| panic!("make -C {} build: {error}", identity.display()));
    assert!(status.success(), "make -C {} build: {status}", identity.display());
    println!("cargo:rustc-link-search=native={}", identity.join("lib").display());
    println!("cargo:rustc-link-lib=static=soksak-process-identity");
    for framework in ["ApplicationServices", "CoreServices", "Foundation", "IOSurface", "CoreFoundation"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
}
