//! 애플리케이션 인자(docs/spec/hosts.md#application-arguments). 두 host 는 같은 규칙과 문장으로 인자를 읽는다.

/// 애플리케이션 인자.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Arguments {
    /// 설정 디렉터리. 없으면 사용자 설정 디렉터리 아래 이 build 의 식별자 디렉터리를 쓴다.
    pub config_dir: Option<String>,
}

/// 애플리케이션 인자를 읽는다. 선언하지 않은 인자, 값 없는 flag, 두 번 준 flag 는 오류다.
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
