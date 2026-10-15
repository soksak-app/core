//! Checks the rules for reading a location (docs/spec/installation.md#fetching) with a TLS server owned by the check. It uses no external network.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use soksak_sok::fetch::Fetcher;

#[path = "tls_support_test.rs"]
mod tls_support_test;
use tls_support_test::{Reply, fetcher, serve};

// contract: fetch.https.reads-a-tls-response
#[test]
fn an_https_location_is_read_over_tls() {
    let server = serve(|_| Reply::Body(br#"{"format":1}"#.to_vec()));
    let fetcher = fetcher(&server);
    let url = format!("{}/index.json", server.url);
    assert_eq!(
        fetcher.read(&url, fetcher.index),
        Ok(br#"{"format":1}"#.to_vec())
    );
    // A certificate that is not trusted cannot connect.
    let error = Fetcher::default()
        .read(&url, fetcher.index)
        .expect_err("untrusted");
    assert!(
        error.starts_with(&format!("{url}: cannot connect: ")),
        "{error}"
    );
}

// contract: fetch.https.redirects-only-to-https
#[test]
fn redirects_are_followed_only_to_https() {
    let server = serve(|path| {
        if let Some(hops) = path
            .strip_prefix("/hop/")
            .and_then(|hops| hops.parse::<u32>().ok())
            && hops > 0
        {
            return Reply::Redirect(format!("/hop/{}", hops - 1));
        }
        if path == "/plain" {
            return Reply::Redirect("http://example.invalid/index.json".to_string());
        }
        Reply::Body(b"end".to_vec())
    });
    let fetcher = fetcher(&server);
    let at = |path: &str| format!("{}{path}", server.url);
    assert_eq!(
        fetcher.read(&at("/hop/5"), fetcher.index),
        Ok(b"end".to_vec())
    );
    assert_eq!(
        fetcher.read(&at("/hop/6"), fetcher.index),
        Err(format!("{}: more than 5 redirects", at("/hop/6")))
    );
    assert_eq!(
        fetcher.read(&at("/plain"), fetcher.index),
        Err(format!(
            "{}: redirect to http://example.invalid/index.json is not https",
            at("/plain")
        ))
    );
}

// contract: fetch.https.reports-status-size-and-timeout
#[test]
fn status_size_and_timeout_fail_with_their_texts() {
    static SLOW: AtomicUsize = AtomicUsize::new(0);
    let server = serve(|path| match path {
        "/missing" => Reply::Status(404),
        "/large" => Reply::Body(vec![b'x'; 17]),
        "/slow" => {
            SLOW.fetch_add(1, Ordering::SeqCst);
            Reply::Slow(Duration::from_millis(1500), b"late".to_vec())
        }
        _ => Reply::Body(vec![b'x'; 16]),
    });
    let fetcher = fetcher(&server);
    for (path, want) in [
        ("/missing", "HTTP 404"),
        ("/large", "larger than 16 bytes"),
        ("/slow", "timed out after 1 s"),
    ] {
        let url = format!("{}{path}", server.url);
        assert_eq!(
            fetcher.read(&url, fetcher.release),
            Err(format!("{url}: {want}"))
        );
    }
    assert_eq!(SLOW.load(Ordering::SeqCst), 1);
    assert_eq!(
        fetcher
            .read(&format!("{}/limit", server.url), fetcher.release)
            .map(|data| data.len()),
        Ok(16)
    );
}

// contract: fetch.url.rejects-other-schemes
#[test]
fn other_schemes_are_rejected() {
    let fetcher = Fetcher::default();
    for location in [
        "http://example.invalid/index.json",
        "ftp://example.invalid/index.json",
        "index.json",
        "https:index.json",
    ] {
        assert_eq!(
            fetcher.read(location, fetcher.index),
            Err(format!(
                "{location}: the URL must be https: or an absolute file: URL"
            ))
        );
    }
    let dir = std::env::temp_dir().join(format!("sok-fetch{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("folder");
    let file = dir.join("index.json");
    std::fs::write(&file, "{}").expect("index");
    assert_eq!(
        fetcher.read(&format!("file://{}", file.display()), fetcher.index),
        Ok(b"{}".to_vec())
    );
    // Cleanup after the check. A folder that cannot be removed has a unique name that does not affect the next check.
    let _ = std::fs::remove_dir_all(&dir);
}

// contract: fetch.https.reads-a-tls-response
#[test]
fn registry_use_records_an_https_index() {
    let server = serve(|_| {
        Reply::Body(
            br#"{"format":1,"plugins":[],"sidecars":[],"packs":[],"revoked":{"plugins":[],"sidecars":[]}}"#
                .to_vec(),
        )
    });
    let mut fetcher = fetcher(&server);
    fetcher.index.bytes = 1 << 20;
    let config = std::env::temp_dir().join(format!("sok-fetch-registry{}", std::process::id()));
    std::fs::create_dir_all(&config).expect("config");
    let url = format!("{}/index.json", server.url);
    assert_eq!(
        soksak_sok::plugins::use_registry(&config, &url, &fetcher),
        Ok(url.clone())
    );
    assert_eq!(
        std::fs::read_to_string(config.join("plugins/registry.json")).expect("registry.json"),
        format!("{{\"format\":1,\"index\":\"{url}\"}}\n")
    );
    // Cleanup after the check. A folder that cannot be removed has a unique name that does not affect the next check.
    let _ = std::fs::remove_dir_all(&config);
}

// contract: host.arguments.registry-ca-in-diagnostic-builds
#[cfg(feature = "diagnostics")]
#[test]
fn a_diagnostic_build_trusts_the_registry_authorities_of_a_file() {
    let server = serve(|_| Reply::Body(b"index".to_vec()));
    let folder = std::env::temp_dir().join(format!("sok-fetch-ca{}", std::process::id()));
    std::fs::create_dir_all(&folder).expect("folder");
    let authority = folder.join("ca.pem");
    std::fs::write(&authority, &server.ca_pem).expect("ca.pem");
    soksak_sok::fetch::use_registry_authorities(&authority).expect("authorities");
    let fetcher = Fetcher::default();
    assert_eq!(
        fetcher.read(&format!("{}/index.json", server.url), fetcher.index),
        Ok(b"index".to_vec())
    );
    // Cleanup after the check. A folder that cannot be removed has a unique name that does not affect the next check.
    let _ = std::fs::remove_dir_all(&folder);
}
