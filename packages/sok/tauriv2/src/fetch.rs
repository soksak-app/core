//! Reads a registry index and a release from a location (docs/spec/installation.md#fetching). A location is an https: URL or an absolute
//! file: URL. https: uses TLS with the certificate authorities that the operating system trusts, follows only redirects to https: up to 5 times,
//! and rejects a response other than 200, a body over the limit and a request slower than the limit with the specified sentences. It stores nothing.

use std::time::{Duration, Instant};

use ureq::tls::{Certificate, RootCerts, TlsConfig};

use crate::files::file_error;
use crate::install::file_path;

/// The limits of body size and time of one request.
#[derive(Clone, Copy, Debug)]
pub struct Limit {
    pub bytes: u64,
    pub timeout: Duration,
}

/// Reads the location. When roots is None it uses the certificate authorities that the operating system trusts. A check passes its own certificate authority and small limits.
#[derive(Clone, Debug)]
pub struct Fetcher {
    pub roots: Option<Vec<Vec<u8>>>,
    pub index: Limit,
    pub release: Limit,
}

/// The maximum number of redirects that are followed.
const MAX_REDIRECTS: usize = 5;

/// The certificate authority that the host of a diagnostic build sets with --registry-ca (docs/spec/hosts.md#application-arguments).
#[cfg(feature = "diagnostics")]
static REGISTRY_AUTHORITIES: std::sync::OnceLock<Vec<Vec<u8>>> = std::sync::OnceLock::new();

/// Makes registry fetching trust only the certificate authorities in the PEM file at path. The host of a diagnostic build calls it for --registry-ca.
#[cfg(feature = "diagnostics")]
pub fn use_registry_authorities(path: &std::path::Path) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|error| file_error(path.display(), &error))?;
    let mut authorities = vec![];
    for item in ureq::tls::parse_pem(&data) {
        if let ureq::tls::PemItem::Certificate(certificate) =
            item.map_err(|error| format!("{}: {error}", path.display()))?
        {
            authorities.push(certificate.der().to_vec());
        }
    }
    if authorities.is_empty() {
        return Err(format!("{}: the file holds no certificate", path.display()));
    }
    REGISTRY_AUTHORITIES.set(authorities).map_err(|_| {
        format!(
            "{}: the registry authorities are already set",
            path.display()
        )
    })
}

impl Default for Fetcher {
    /// A Fetcher with the limits of the specification. In a diagnostic build it trusts only the certificate authority that --registry-ca sets, when there is one.
    fn default() -> Self {
        #[cfg(feature = "diagnostics")]
        let roots = REGISTRY_AUTHORITIES.get().cloned();
        #[cfg(not(feature = "diagnostics"))]
        let roots = None;
        Fetcher {
            roots,
            index: Limit {
                bytes: 8 << 20,
                timeout: Duration::from_secs(60),
            },
            release: Limit {
                bytes: 256 << 20,
                timeout: Duration::from_secs(600),
            },
        }
    }
}

/// Checks that the location is an https: URL or an absolute file: URL.
pub fn check_location(location: &str) -> Result<(), String> {
    let other = || format!("{location}: the URL must be https: or an absolute file: URL");
    if let Some(rest) = location.strip_prefix("https://") {
        return match rest.split(['/', '?', '#']).next() {
            Some(host) if !host.is_empty() => Ok(()),
            _ => Err(other()),
        };
    }
    if location.starts_with("file:") {
        return file_path(location)
            .map(|_| ())
            .map_err(|error| format!("{location}: {error}"));
    }
    Err(other())
}

/// Resolves a relative Location against the current URL. It cannot resolve it when the current URL has no scheme.
fn resolve(current: &str, location: &str) -> Option<String> {
    if location.contains("://") {
        return Some(location.to_string());
    }
    let (scheme, rest) = current.split_once("://")?;
    let authority = rest.split('/').next()?;
    if location.starts_with('/') {
        return Some(format!("{scheme}://{authority}{location}"));
    }
    let path = &rest[authority.len()..];
    let directory = match path.rfind('/') {
        Some(end) => &path[..end + 1],
        None => "",
    };
    Some(format!("{scheme}://{authority}{directory}{location}"))
}

impl Fetcher {
    /// Reads the body of the location within limit.
    pub fn read(&self, location: &str, limit: Limit) -> Result<Vec<u8>, String> {
        check_location(location)?;
        if location.starts_with("file:") {
            let path = file_path(location).map_err(|error| format!("{location}: {error}"))?;
            return std::fs::read(&path).map_err(|error| file_error(&path, &error));
        }
        let roots = match &self.roots {
            Some(certificates) => RootCerts::new_with_certs(
                &certificates
                    .iter()
                    .map(|der| Certificate::from_der(der).to_owned())
                    .collect::<Vec<_>>(),
            ),
            None => RootCerts::PlatformVerifier,
        };
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(TlsConfig::builder().root_certs(roots).build())
            .max_redirects(0)
            .max_redirects_will_error(false)
            .http_status_as_error(false)
            .build()
            .into();
        let deadline = Instant::now() + limit.timeout;
        let timed_out = || format!("{location}: timed out after {} s", limit.timeout.as_secs());
        let mut current = location.to_string();
        for redirect in 0..=MAX_REDIRECTS + 1 {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .ok_or_else(timed_out)?;
            let request = agent
                .get(&current)
                .config()
                .timeout_global(Some(remaining))
                .build();
            let mut response = request
                .call()
                .map_err(|error| self.failure(location, &error, &timed_out))?;
            let status = response.status().as_u16();
            if (300..400).contains(&status) {
                if let Some(target) = response
                    .headers()
                    .get("location")
                    // default: a location that is not text counts as absent, and the status check below reports the redirect as an HTTP error.
                    .and_then(|value| value.to_str().ok())
                {
                    let Some(target) = resolve(&current, target) else {
                        return Err(format!("{location}: redirect to {target} is not https"));
                    };
                    if !target.starts_with("https://") {
                        return Err(format!("{location}: redirect to {target} is not https"));
                    }
                    if redirect == MAX_REDIRECTS {
                        return Err(format!("{location}: more than {MAX_REDIRECTS} redirects"));
                    }
                    current = target;
                    continue;
                }
            }
            if status != 200 {
                return Err(format!("{location}: HTTP {status}"));
            }
            // A body of exactly the limit size is accepted, so the code reads one byte more to see whether the body exceeds the limit.
            let larger = || format!("{location}: larger than {} bytes", limit.bytes);
            let data = response
                .body_mut()
                .with_config()
                .limit(limit.bytes + 1)
                .read_to_vec()
                .map_err(|error| match error {
                    ureq::Error::BodyExceedsLimit(_) => larger(),
                    error => self.failure(location, &error, &timed_out),
                })?;
            if data.len() as u64 > limit.bytes {
                return Err(larger());
            }
            return Ok(data);
        }
        Err(format!("{location}: more than {MAX_REDIRECTS} redirects"))
    }

    /// Converts a request error to the sentence of the specification.
    fn failure(
        &self,
        location: &str,
        error: &ureq::Error,
        timed_out: &dyn Fn() -> String,
    ) -> String {
        match error {
            ureq::Error::Timeout(_) => timed_out(),
            error => format!("{location}: cannot connect: {error}"),
        }
    }
}
