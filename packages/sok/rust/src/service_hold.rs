//! A plugin operation does not change the version of a persistent sidecar whose service runs
//! (docs/spec/persistent-services.md#updates).

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

use crate::files::file_error;
use crate::install::InstalledState;

/// The version that the live service of each persistent sidecar runs, by sidecar name. None is a service whose version the
/// caller does not read, as on the command line.
pub type Services = BTreeMap<String, Option<String>>;

/// The end of the live services of the named sidecars, which hold an operation.
pub type End<'a> = &'a dyn Fn(&[String]) -> Result<(), String>;

/// What a plugin operation knows of the running services. `end` ends the services that hold the operation after the releases
/// are extracted and before installed.json is written; None holds the operation.
#[derive(Default)]
pub struct Running<'a> {
    pub services: Services,
    pub end: Option<End<'a>>,
}

/// The version that state records for each sidecar, read before a plan changes state.
pub(crate) fn recorded_versions(state: &InstalledState) -> BTreeMap<String, String> {
    state
        .sidecars
        .iter()
        .map(|(name, sidecar)| (name.clone(), sidecar.version.clone()))
        .collect()
}

/// The sidecars, in name order, whose live service holds the operation of plugin id that leads to the planned state, with the
/// error of the first: a persistent sidecar that an enabled plugin of state names and whose live service runs another version
/// than state plans, or, for a service whose version is not read, a sidecar whose planned version differs from the version that
/// recorded holds.
pub(crate) fn held_by(
    id: &str,
    state: &InstalledState,
    recorded: &BTreeMap<String, String>,
    services: &Services,
) -> (Vec<String>, Option<String>) {
    let named: BTreeSet<&String> = state
        .plugins
        .values()
        .filter(|plugin| plugin.enabled)
        .flat_map(|plugin| plugin.sidecars.keys())
        .collect();
    let mut held = Vec::new();
    let mut first = None;
    for name in named {
        let Some(running) = services.get(name) else {
            continue;
        };
        // default: a sidecar that an enabled plugin names has a version in the planned state; none plans no version.
        let planned = state
            .sidecars
            .get(name)
            .map(|sidecar| sidecar.version.as_str())
            .unwrap_or_default();
        let unchanged = match running {
            Some(running) => running == planned,
            None => recorded.get(name).map(String::as_str) == Some(planned),
        };
        if unchanged {
            continue;
        }
        held.push(name.clone());
        if first.is_none() {
            first = Some(format!(
                "plugin {id} {}: sidecar {name} {planned} waits for the end of its running service {}",
                state
                    .plugins
                    .get(id)
                    .map(|plugin| plugin.version.as_str())
                    .unwrap_or_default(),
                running.as_deref().unwrap_or("unknown")
            ));
        }
    }
    (held, first)
}

/// Ends the services of held through running.end before the planned state is written, or returns the error of the hold when
/// the operation has no end.
pub(crate) fn end_held(
    held: &[String],
    holding: Option<String>,
    running: &Running<'_>,
) -> Result<(), String> {
    if held.is_empty() {
        return Ok(());
    }
    match running.end {
        Some(end) => end(held),
        // default: a hold always carries the error of its first sidecar.
        None => Err(holding.unwrap_or_default()),
    }
}

/// The live services of the persistent sidecars that state records: the service of a sidecar is live when the endpoint.json in
/// services/<executable name> names the process that published it. The command line reads no hello, so each version is None.
pub fn live_services(config_dir: &Path, state: &InstalledState) -> Result<Services, String> {
    let mut services = Services::new();
    for (name, sidecar) in &state.sidecars {
        let file = config_dir.join(&sidecar.path).join("sidecar.json");
        let data = std::fs::read(&file).map_err(|error| file_error(file.display(), &error))?;
        #[derive(serde::Deserialize)]
        struct Declaration {
            #[serde(default)]
            executable: String,
            #[serde(default)]
            transport: String,
        }
        let declaration: Declaration = serde_json::from_slice(&data)
            .map_err(|_| format!("{} is not valid JSON", file.display()))?;
        if declaration.transport != "persistent" {
            continue;
        }
        // default: an executable path without a final component names no service folder, which holds no endpoint.
        let executable = Path::new(&declaration.executable)
            .file_name()
            .unwrap_or_default();
        let endpoint = config_dir
            .join("services")
            .join(executable)
            .join("endpoint.json");
        if endpoint_live(&endpoint).map_err(|error| format!("sidecar {name}: {error}"))? {
            services.insert(name.clone(), None);
        }
    }
    Ok(services)
}

/// Whether the endpoint file at path names the process that published it. It reads the content and the modification time
/// through one descriptor, so the time is the time of the content (docs/spec/persistent-services.md#endpoint-publisher).
fn endpoint_live(path: &Path) -> Result<bool, String> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(file_error(path.display(), &error)),
    };
    let mut data = Vec::new();
    file.read_to_end(&mut data)
        .map_err(|error| file_error(path.display(), &error))?;
    let published = file
        .metadata()
        .and_then(|metadata| metadata.modified())
        .map_err(|error| file_error(path.display(), &error))?;
    #[derive(serde::Deserialize)]
    struct Endpoint {
        #[serde(default)]
        pid: u32,
    }
    let endpoint: Endpoint = serde_json::from_slice(&data)
        .map_err(|_| format!("{} is not valid JSON", path.display()))?;
    crate::platform::current()?.service_process_exists(endpoint.pid, published)
}
