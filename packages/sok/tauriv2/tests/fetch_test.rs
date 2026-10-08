//! 위치를 읽는 규칙(docs/spec/installation.md#fetching)을 검사 소유의 TLS server 로 검사한다. 외부 network 는 쓰지 않는다.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use soksak_sok::fetch::{Fetcher, Limit};

/// 경로에 대한 server 의 응답.
enum Reply {
    Body(Vec<u8>),
    Status(u16),
    Redirect(String),
    Slow(Duration, Vec<u8>),
}

/// 검사 소유의 TLS server. 검사가 만든 인증 기관의 인증서를 쓴다.
struct Server {
    url: String,
    ca: Vec<u8>,
    /// 진단 build 의 --registry-ca 검사가 파일로 쓰는 인증 기관.
    #[cfg(feature = "diagnostics")]
    ca_pem: String,
}

fn serve(handler: fn(&str) -> Reply) -> Server {
    let ca_key = KeyPair::generate().expect("ca key");
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).expect("ca params");
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = CertifiedIssuer::self_signed(ca_params, ca_key).expect("ca");
    let leaf_key = KeyPair::generate().expect("leaf key");
    let leaf = CertificateParams::new(vec!["127.0.0.1".to_string()])
        .expect("leaf params")
        .signed_by(&leaf_key, &ca)
        .expect("leaf");
    let config = Arc::new(
        rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("protocols")
        .with_no_client_auth()
        .with_single_cert(
            vec![leaf.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf_key.serialize_der())),
        )
        .expect("server config"),
    );
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let url = format!("https://{}", listener.local_addr().expect("address"));
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let config = config.clone();
            std::thread::spawn(move || {
                let connection = rustls::ServerConnection::new(config).expect("connection");
                let mut tls = rustls::StreamOwned::new(connection, stream);
                let mut request = String::new();
                {
                    let mut reader = BufReader::new(&mut tls);
                    loop {
                        let mut line = String::new();
                        // 검사 server 다. 연결을 끊은 client 는 응답을 받지 않는다.
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if request.is_empty() {
                            request = line;
                        }
                    }
                }
                let path = request.split(' ').nth(1).unwrap_or("/").to_string();
                let (status, location, body) = match handler(&path) {
                    Reply::Body(body) => (200, None, body),
                    Reply::Status(status) => (status, None, vec![]),
                    Reply::Redirect(target) => (302, Some(target), vec![]),
                    Reply::Slow(delay, body) => {
                        std::thread::sleep(delay);
                        (200, None, body)
                    }
                };
                let mut head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                    body.len()
                );
                if let Some(location) = location {
                    head.push_str(&format!("Location: {location}\r\n"));
                }
                head.push_str("\r\n");
                // 검사 server 다. 시간이 지나 client 가 끊은 연결에는 쓸 수 없다.
                let _ = tls.write_all(head.as_bytes());
                let _ = tls.write_all(&body);
                let _ = tls.flush();
                tls.conn.send_close_notify();
                let _ = tls.flush();
            });
        }
    });
    Server {
        url,
        ca: ca.der().to_vec(),
        #[cfg(feature = "diagnostics")]
        ca_pem: ca.pem(),
    }
}

/// server 의 인증 기관을 신뢰하고 작은 한도를 쓰는 Fetcher.
fn fetcher(server: &Server) -> Fetcher {
    let limit = Limit {
        bytes: 16,
        timeout: Duration::from_secs(1),
    };
    Fetcher {
        roots: Some(vec![server.ca.clone()]),
        index: limit,
        release: limit,
    }
}

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
    // 신뢰하지 않는 인증서는 연결하지 못한다.
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
        {
            if hops > 0 {
                return Reply::Redirect(format!("/hop/{}", hops - 1));
            }
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
    // 검사 뒤 정리다. 지우지 못한 폴더는 다음 검사에 영향을 주지 않는 고유 이름이다.
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
    // 검사 뒤 정리다. 지우지 못한 폴더는 다음 검사에 영향을 주지 않는 고유 이름이다.
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
    // 검사 뒤 정리다. 지우지 못한 폴더는 다음 검사에 영향을 주지 않는 고유 이름이다.
    let _ = std::fs::remove_dir_all(&folder);
}
