//! The TLS server that a check owns and a Fetcher that trusts it, shared by the checks that read https locations. It uses no
//! external network.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, IsCa, KeyPair};
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use soksak_sok::fetch::{Fetcher, Limit};

/// The response of the server for a path.
pub enum Reply {
    Body(Vec<u8>),
    Status(u16),
    Redirect(String),
    Slow(Duration, Vec<u8>),
}

/// The TLS server owned by the check. It uses the certificate of a certificate authority that the check created.
pub struct Server {
    pub url: String,
    pub ca: Vec<u8>,
    /// The certificate authority that the --registry-ca check of the diagnostic build writes to a file.
    #[cfg(feature = "diagnostics")]
    pub ca_pem: String,
}

pub fn serve(handler: impl Fn(&str) -> Reply + Send + Sync + 'static) -> Server {
    let handler = Arc::new(handler);
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
            let handler = handler.clone();
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
        ca: ca.der().to_vec(),
        #[cfg(feature = "diagnostics")]
        ca_pem: ca.pem(),
    }
}

/// A Fetcher that trusts the certificate authority of the server and uses small limits.
pub fn fetcher(server: &Server) -> Fetcher {
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
