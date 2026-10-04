//! registry index 와 archive 를 위치에서 읽는다(docs/spec/installation.md#fetching). 위치는 https: URL 이나 절대
//! file: URL 이다. https: 는 운영체제가 신뢰하는 인증 기관으로 TLS 를 쓰고, https: 로의 redirect 만 5 번까지 따라가며,
//! 200 이 아닌 응답, 한도보다 큰 본문, 한도보다 느린 요청을 정한 문장으로 거부한다. 아무것도 저장해 두지 않는다.

use std::time::{Duration, Instant};

use ureq::tls::{Certificate, RootCerts, TlsConfig};

use crate::files::file_error;
use crate::install::file_path;

/// 한 요청의 본문 크기와 시간의 한도.
#[derive(Clone, Copy, Debug)]
pub struct Limit {
    pub bytes: u64,
    pub timeout: Duration,
}

/// 위치를 읽는다. roots 가 None 이면 운영체제가 신뢰하는 인증 기관을 쓴다. 검사는 자기 인증 기관과 작은 한도를 준다.
#[derive(Clone, Debug)]
pub struct Fetcher {
    pub roots: Option<Vec<Vec<u8>>>,
    pub index: Limit,
    pub archive: Limit,
}

/// 따라가는 redirect 의 최대 수.
const MAX_REDIRECTS: usize = 5;

impl Default for Fetcher {
    /// 명세의 한도를 쓰는 Fetcher.
    fn default() -> Self {
        Fetcher {
            roots: None,
            index: Limit {
                bytes: 8 << 20,
                timeout: Duration::from_secs(60),
            },
            archive: Limit {
                bytes: 256 << 20,
                timeout: Duration::from_secs(600),
            },
        }
    }
}

/// 위치가 https: URL 이나 절대 file: URL 인지 검사한다.
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

/// 상대 Location 을 현재 URL 에 대해 푼다. 현재 URL 에 scheme 이 없으면 풀 수 없다.
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
    /// 위치의 본문을 limit 안에서 읽는다.
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
            // 한도와 같은 크기의 본문은 받으므로 한 byte 더 읽어 넘는지 본다.
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

    /// 요청 오류를 명세의 문장으로 바꾼다.
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
