//! Application arguments (docs/spec/hosts.md#application-arguments). Both hosts read the arguments with the same rules
//! and wording.

/// The application arguments.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Arguments {
    /// The configuration directory. When it is absent, the identifier directory of this build under the user
    /// configuration directory is used.
    pub config_dir: Option<String>,
    /// --registry-ca of a diagnostic build. The PEM file of the certificate authority that the registry download
    /// trusts.
    #[cfg(feature = "diagnostics")]
    pub registry_ca: Option<String>,
}

/// Applies the arguments that were read before a window opens. --registry-ca of a diagnostic build sets the certificate
/// authority of the registry download. A release build has no argument to apply.
#[cfg_attr(not(feature = "diagnostics"), allow(unused_variables))]
pub fn apply_arguments(arguments: &Arguments) -> Result<(), String> {
    #[cfg(feature = "diagnostics")]
    if let Some(path) = &arguments.registry_ca {
        soksak_sok::fetch::use_registry_authorities(std::path::Path::new(path))
            .map_err(|error| format!("--registry-ca {error}"))?;
    }
    Ok(())
}

/// Reads the application arguments. An undeclared argument, a flag without a value and a flag given twice are errors.
pub fn parse_arguments(args: impl IntoIterator<Item = String>) -> Result<Arguments, String> {
    let mut parsed = Arguments::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let Some(flag) = arg.strip_prefix("--") else {
            return Err(format!("unknown argument {arg}"));
        };
        let (name, inline) = match flag.split_once('=') {
            Some((name, value)) => (name, Some(value.to_string())),
            None => (flag, None),
        };
        let target = match name {
            "config-dir" => &mut parsed.config_dir,
            #[cfg(feature = "diagnostics")]
            "registry-ca" => &mut parsed.registry_ca,
            _ => return Err(format!("unknown argument {arg}")),
        };
        let value = match inline {
            Some(value) => value,
            None => args
                .next()
                .ok_or_else(|| format!("--{name} needs a value"))?,
        };
        if value.is_empty() {
            return Err(format!("--{name} needs a value"));
        }
        if target.is_some() {
            return Err(format!("--{name} is given twice"));
        }
        *target = Some(value);
    }
    Ok(parsed)
}
