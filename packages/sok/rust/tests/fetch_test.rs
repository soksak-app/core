//! Checks the rules for reading a location (docs/spec/installation.md#fetching) with a TLS server owned by the check. It uses no external network.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use soksak_sok::fetch::{Fetcher, Limit};

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

/// The response of the server for a path.
enum Reply {
    Body(Vec<u8>),
    Status(u16),
    Redirect(String),
    /// No answer: the server reads until the client closes the connection, so the time limit of the fetch is the only end of
    /// the read.
    Unanswered,
}

/// The TLS server owned by the check. It uses the certificate of a certificate authority that the check created.
struct Server {
    url: String,
    ca: Vec<u8>,
    /// The certificate authority that the --registry-ca check of the diagnostic build writes to a file.
    #[cfg(feature = "diagnostics")]
    ca_pem: String,
}

/// The certificate authority of the check and the TLS configuration of a server whose certificate it signed.
struct Certificates {
    config: Arc<rustls::ServerConfig>,
    ca: Vec<u8>,
    #[cfg(feature = "diagnostics")]
    ca_pem: String,
}

fn certificates() -> Certificates {
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
    Certificates {
        ca: ca.der().to_vec(),
        #[cfg(feature = "diagnostics")]
        ca_pem: ca.pem(),
        config,
    }
}

fn serve(handler: fn(&str) -> Reply) -> Server {
    let certificates = certificates();
    let config = certificates.config.clone();
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
                        // A server of the check. A client that closed its connection receives no response.
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
                    Reply::Unanswered => {
                        let mut rest = [0u8; 64];
                        // A server of the check. A read error is the end of the connection as well.
                        while matches!(tls.read(&mut rest), Ok(read) if read > 0) {}
                        return;
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
                // A server of the check. It cannot write to a connection that the client closed after the time limit.
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
        ca: certificates.ca,
        #[cfg(feature = "diagnostics")]
        ca_pem: certificates.ca_pem,
    }
}

/// A Fetcher that trusts the certificate authority of the server and uses small limits.
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
            Reply::Unanswered
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
    let dir = Folder::new("fetch");
    let file = dir.join("index.json");
    std::fs::write(&file, "{}").expect("index");
    assert_eq!(
        fetcher.read(&format!("file://{}", file.display()), fetcher.index),
        Ok(b"{}".to_vec())
    );
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
    let config = Folder::new("fetch-registry");
    let url = format!("{}/index.json", server.url);
    assert_eq!(
        soksak_sok::plugins::use_registry(&config, &url, &fetcher),
        Ok(url.clone())
    );
    assert_eq!(
        std::fs::read_to_string(config.join("plugins/registry.json")).expect("registry.json"),
        format!("{{\"format\":1,\"index\":\"{url}\"}}\n")
    );
}

// contract: host.arguments.registry-ca-in-diagnostic-builds
#[cfg(feature = "diagnostics")]
#[test]
fn a_diagnostic_build_trusts_the_registry_authorities_of_a_file() {
    let server = serve(|_| Reply::Body(b"index".to_vec()));
    let folder = Folder::new("fetch-ca");
    let authority = folder.join("ca.pem");
    std::fs::write(&authority, &server.ca_pem).expect("ca.pem");
    soksak_sok::fetch::use_registry_authorities(&authority).expect("authorities");
    let fetcher = Fetcher::default();
    assert_eq!(
        fetcher.read(&format!("{}/index.json", server.url), fetcher.index),
        Ok(b"index".to_vec())
    );
}

/// The smallest registry index that the checks of reading an index serve.
const EMPTY_INDEX: &[u8] =
    br#"{"format":1,"plugins":[],"sidecars":[],"packs":[],"revoked":{"plugins":[],"sidecars":[]}}"#;

/// The counts of an index server: the connections it accepted, the requests it read and the bodies it sent.
#[derive(Default)]
struct Counts {
    connections: AtomicUsize,
    requests: AtomicUsize,
    bodies: AtomicUsize,
}

/// A TLS server of the check that keeps each connection open for the next request. It serves EMPTY_INDEX with an ETag
/// and answers a request that sends that ETag with 304, and the path /unvalidated with 304. Each request is sent to
/// arrived before it is answered, and while held is true the answer waits.
struct IndexServer {
    url: String,
    ca: Vec<u8>,
    counts: Arc<Counts>,
    arrived: std::sync::mpsc::Receiver<()>,
    held: Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}

impl IndexServer {
    fn release(&self) {
        let (held, changed) = &*self.held;
        *held.lock().expect("held") = false;
        changed.notify_all();
    }
}

fn serve_index(held: bool) -> IndexServer {
    let certificates = certificates();
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let url = format!("https://{}", listener.local_addr().expect("address"));
    let counts = Arc::new(Counts::default());
    let (arrive, arrived) = std::sync::mpsc::channel();
    let hold = Arc::new((std::sync::Mutex::new(held), std::sync::Condvar::new()));
    let (config, server_counts, server_hold) =
        (certificates.config.clone(), counts.clone(), hold.clone());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            server_counts.connections.fetch_add(1, Ordering::SeqCst);
            let (config, counts, hold, arrive) = (
                config.clone(),
                server_counts.clone(),
                server_hold.clone(),
                arrive.clone(),
            );
            std::thread::spawn(move || {
                let connection = rustls::ServerConnection::new(config).expect("connection");
                let mut tls = BufReader::new(rustls::StreamOwned::new(connection, stream));
                loop {
                    let (mut path, mut validated) = (None, false);
                    loop {
                        let mut line = String::new();
                        // A server of the check. A client that closed its connection ends the connection.
                        if tls.read_line(&mut line).unwrap_or(0) == 0 {
                            return;
                        }
                        if line == "\r\n" {
                            break;
                        }
                        if path.is_none() {
                            path = line.split(' ').nth(1).map(str::to_string);
                        } else if line.to_ascii_lowercase().starts_with("if-none-match:") {
                            validated = line.contains("\"v1\"");
                        }
                    }
                    counts.requests.fetch_add(1, Ordering::SeqCst);
                    // A server of the check. The check may have ended its receiver.
                    let _ = arrive.send(());
                    let (held, changed) = &*hold;
                    let mut waiting = held.lock().expect("held");
                    while *waiting {
                        waiting = changed.wait(waiting).expect("held");
                    }
                    drop(waiting);
                    let head = if path.as_deref() == Some("/unvalidated") {
                        "HTTP/1.1 304 X\r\n\r\n".to_string()
                    } else if validated {
                        "HTTP/1.1 304 X\r\nETag: \"v1\"\r\n\r\n".to_string()
                    } else {
                        counts.bodies.fetch_add(1, Ordering::SeqCst);
                        format!(
                            "HTTP/1.1 200 X\r\nETag: \"v1\"\r\nContent-Length: {}\r\n\r\n",
                            EMPTY_INDEX.len()
                        )
                    };
                    let stream = tls.get_mut();
                    // A server of the check. A client that closed its connection receives no answer.
                    let _ = stream.write_all(head.as_bytes());
                    if !validated && path.as_deref() != Some("/unvalidated") {
                        let _ = stream.write_all(EMPTY_INDEX);
                    }
                    let _ = stream.flush();
                }
            });
        }
    });
    IndexServer {
        url,
        ca: certificates.ca,
        counts,
        arrived,
        held: hold,
    }
}

/// A fetcher that trusts the index server and reads an index of up to 1 MiB.
fn index_fetcher(server: &IndexServer) -> Fetcher {
    let limit = Limit {
        bytes: 1 << 20,
        timeout: Duration::from_secs(5),
    };
    Fetcher {
        roots: Some(vec![server.ca.clone()]),
        index: limit,
        release: limit,
    }
}

// contract: fetch.https.reuses-the-connection
#[test]
fn reads_of_one_fetcher_reuse_the_connection() {
    let server = serve_index(false);
    let fetcher = index_fetcher(&server);
    for _ in 0..3 {
        soksak_sok::plugins::read_index_at(&format!("{}/index.json", server.url), &fetcher)
            .expect("index");
    }
    assert_eq!(
        (
            server.counts.connections.load(Ordering::SeqCst),
            server.counts.requests.load(Ordering::SeqCst)
        ),
        (1, 3),
        "connections and requests"
    );
}

// contract: fetch.https.answers-an-unchanged-index-without-a-body
#[test]
fn an_unchanged_index_is_answered_without_a_body() {
    let server = serve_index(false);
    let fetcher = index_fetcher(&server);
    let url = format!("{}/index.json", server.url);
    for _ in 0..3 {
        soksak_sok::plugins::read_index_at(&url, &fetcher).expect("index");
    }
    assert_eq!(
        (
            server.counts.requests.load(Ordering::SeqCst),
            server.counts.bodies.load(Ordering::SeqCst)
        ),
        (3, 1),
        "requests and bodies"
    );
    // A 304 answer to a request that sent no validator is not an index.
    let unvalidated = format!("{}/unvalidated", server.url);
    assert_eq!(
        soksak_sok::plugins::read_index_at(&unvalidated, &fetcher).map(|_| ()),
        Err(format!("{unvalidated}: HTTP 304"))
    );
}

// contract: fetch.https.shares-a-running-index-read
#[test]
fn a_read_that_starts_during_a_running_read_shares_it() {
    let server = serve_index(true);
    let fetcher = index_fetcher(&server);
    let url = format!("{}/index.json", server.url);
    let read = || {
        let (url, fetcher) = (url.clone(), fetcher.clone());
        std::thread::spawn(move || soksak_sok::plugins::read_index_at(&url, &fetcher).map(|_| ()))
    };
    let first = read();
    server
        .arrived
        .recv_timeout(Duration::from_secs(5))
        .expect("first request");
    let second = read();
    // The second read waits for the first: the fetcher reports it before the first answer is released.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while soksak_sok::fetch::index_read_waiters(&url) != 1 {
        if std::time::Instant::now() > deadline {
            let requests = server.counts.requests.load(Ordering::SeqCst);
            server.release();
            panic!(
                "waiters {} requests {requests}: the second read did not wait for the running read",
                soksak_sok::fetch::index_read_waiters(&url)
            );
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    server.release();
    assert_eq!(first.join().expect("first"), Ok(()));
    assert_eq!(second.join().expect("second"), Ok(()));
    assert_eq!(
        (
            server.counts.requests.load(Ordering::SeqCst),
            server.counts.bodies.load(Ordering::SeqCst)
        ),
        (1, 1),
        "one shared request"
    );
}
