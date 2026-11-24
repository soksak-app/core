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

/// A persistent sidecar whose live service holds a plugin operation: planned is the version that the operation plans, and
/// running the version that the service runs, None when the caller does not read it.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct HeldSidecar {
    pub sidecar: String,
    pub planned: String,
    pub running: Option<String>,
}

/// A held plugin operation: the plugin, its planned version, the sidecars whose services hold it in name order and the error of
/// the hold, which names the first (docs/spec/persistent-services.md#updates).
#[derive(Clone, Debug, PartialEq)]
pub struct Held {
    pub plugin: String,
    pub version: String,
    pub sidecars: Vec<HeldSidecar>,
    pub error: String,
}

/// The end of the services of a held operation.
pub type End<'a> = &'a dyn Fn(&Held) -> Result<(), String>;

/// What a plugin operation knows of the running services. `end` ends the services of a held operation after the releases are
/// extracted and before installed.json is written; None holds the operation before it extracts anything, and `held`, when it is
/// set, receives the held operation before the operation fails with its error.
#[derive(Default)]
pub struct Running<'a> {
    pub services: Services,
    pub end: Option<End<'a>>,
    pub held: Option<&'a dyn Fn(&Held)>,
}

/// The version that state records for each sidecar, read before a plan changes state.
pub(crate) fn recorded_versions(state: &InstalledState) -> BTreeMap<String, String> {
    state
        .sidecars
        .iter()
        .map(|(name, sidecar)| (name.clone(), sidecar.version.clone()))
        .collect()
}

/// The operation of plugin id that leads to the planned state when a live service holds it, and None otherwise: the service of
/// a persistent sidecar that an enabled plugin of state names holds it when it runs another version than state plans, or, for a
/// service whose version is not read, when the planned version differs from the version that recorded holds.
pub(crate) fn held_by(
    id: &str,
    state: &InstalledState,
    recorded: &BTreeMap<String, String>,
    services: &Services,
) -> Option<Held> {
    let named: BTreeSet<&String> = state
        .plugins
        .values()
        .filter(|plugin| plugin.enabled)
        .flat_map(|plugin| plugin.sidecars.keys())
        .collect();
    let mut sidecars = Vec::new();
    for name in named {
        let Some(running) = services.get(name) else {
            continue;
        };
        let planned = state
            .sidecars
            .get(name)
            .map(|sidecar| sidecar.version.clone())
            // default: a sidecar that an enabled plugin names has a version in the planned state; none plans no version.
            .unwrap_or_default();
        let unchanged = match running {
            Some(running) => *running == planned,
            None => recorded.get(name) == Some(&planned),
        };
        if !unchanged {
            sidecars.push(HeldSidecar {
                sidecar: name.clone(),
                planned,
                running: running.clone(),
            });
        }
    }
    let first = sidecars.first()?;
    let version = state
        .plugins
        .get(id)
        .map(|plugin| plugin.version.clone())
        // default: the plugin of the operation is in its planned state.
        .unwrap_or_default();
    let error = format!(
        "plugin {id} {version}: sidecar {} {} waits for the end of its running service {}",
        first.sidecar,
        first.planned,
        // default: a service whose hello reported no version runs a version that is not known.
        first.running.as_deref().unwrap_or("unknown")
    );
    Some(Held {
        plugin: id.to_string(),
        version,
        sidecars,
        error,
    })
}

/// Ends the services of a held operation through running.end before the planned state is written, or, without an end, gives the
/// operation to running.held and returns the error of the hold.
pub(crate) fn end_held(held: Option<&Held>, running: &Running<'_>) -> Result<(), String> {
    let Some(held) = held else {
        return Ok(());
    };
    if let Some(end) = running.end {
        return end(held);
    }
    if let Some(give) = running.held {
        give(held);
    }
    Err(held.error.clone())
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
        let executable = Path::new(&declaration.executable)
            .file_name()
            // default: an executable path without a final component names no service folder, which holds no endpoint.
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
