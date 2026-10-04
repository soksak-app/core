//! 페이지가 보낸 host 호출 인자를 해석한다(docs/spec/native-host.md#host-calls). Tauri 의 인자 해석은 serde 의
//! 문장으로 거부하므로, 명령은 인자를 [Argument] 로 받아 이 decoder 로 해석하고 Wails host 의 인자 decoder 와
//! 같은 문장으로 거부한다.

use serde::de::{
    self, DeserializeOwned, DeserializeSeed, Expected, IntoDeserializer, Unexpected, Visitor,
};
use serde_json::Value;
use std::fmt;

/// 명령 인자 하나. 명령 인자 이름과 같은 key 의 값을 T 로 해석한다. 보내지 않은 인자는 null 이다.
pub struct Argument<T>(pub T);

const NULL: Value = Value::Null;

impl<'a, R: tauri::Runtime, T: DeserializeOwned> tauri::ipc::CommandArg<'a, R> for Argument<T> {
    fn from_command(
        command: tauri::ipc::CommandItem<'a, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let value = match command.message.payload() {
            tauri::ipc::InvokeBody::Json(Value::Object(arguments)) => {
                // 기본값: 보내지 않은 인자는 Wails host 처럼 null 로 해석한다.
                arguments.get(command.key).unwrap_or(&NULL)
            }
            tauri::ipc::InvokeBody::Json(other) => {
                return Err(format!(
                    "arguments of {} must be an object, not {}",
                    command.name,
                    kind(other)
                )
                .into())
            }
            tauri::ipc::InvokeBody::Raw(_) => {
                return Err(format!("arguments of {} must be JSON", command.name).into())
            }
        };
        decode(command.key, value).map(Argument).map_err(Into::into)
    }
}

/// 객체만 받는 선택 field 를 객체 값으로 읽는다. 객체가 아닌 값은 Wails host 의 map field 처럼 거부한다.
pub fn optional_object<'de, D: de::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    use serde::Deserialize;
    Option::<serde_json::Map<String, Value>>::deserialize(deserializer)
        .map(|object| object.map(Value::Object))
}

/// 이름이 name 인 인자 value 를 T 로 해석한다.
pub fn decode<T: DeserializeOwned>(name: &str, value: &Value) -> Result<T, String> {
    T::deserialize(Node(value)).map_err(|error| error.message(name))
}

/// JSON 값의 형식 이름.
pub(crate) fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "a string",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

/// 해석 실패. path 는 실패한 자리부터 인자 쪽으로 쌓은 `.field` 와 `[index]` 다.
#[derive(Debug)]
pub struct Error {
    path: Vec<String>,
    problem: String,
}

impl Error {
    fn problem(problem: String) -> Self {
        Error {
            path: Vec::new(),
            problem,
        }
    }

    fn mismatch(expected: &str, value: &Value) -> Self {
        Error::problem(format!("must be {expected}, not {}", kind(value)))
    }

    fn at(mut self, segment: String) -> Self {
        self.path.push(segment);
        self
    }

    fn message(&self, name: &str) -> String {
        let mut path = name.to_string();
        for segment in self.path.iter().rev() {
            path.push_str(segment);
        }
        format!("argument {path} {}", self.problem)
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message("value"))
    }
}

impl std::error::Error for Error {}

impl de::Error for Error {
    fn custom<M: fmt::Display>(message: M) -> Self {
        Error::problem(message.to_string())
    }

    fn missing_field(field: &'static str) -> Self {
        Error::problem("is missing".to_string()).at(format!(".{field}"))
    }

    // serde 가 직접 만드는 형식 오류(내부 Content 를 거친 해석)를 이 decoder 의 형식 이름으로 쓴다.
    fn invalid_type(unexpected: Unexpected, expected: &dyn Expected) -> Self {
        let actual = match unexpected {
            Unexpected::Unit | Unexpected::Option => "null".to_string(),
            Unexpected::Bool(_) => "a boolean".to_string(),
            Unexpected::Unsigned(_) | Unexpected::Signed(_) | Unexpected::Float(_) => {
                "a number".to_string()
            }
            Unexpected::Char(_) | Unexpected::Str(_) => "a string".to_string(),
            Unexpected::Seq => "an array".to_string(),
            Unexpected::Map => "an object".to_string(),
            other => other.to_string(),
        };
        let expected = expected.to_string();
        let expected = match expected.as_str() {
            "f32" | "f64" | "i8" | "i16" | "i32" | "i64" | "u8" | "u16" | "u32" | "u64" => {
                "a number"
            }
            "a string" | "a borrowed string" => "a string",
            "a boolean" => "a boolean",
            "a sequence" => "an array",
            "a map" => "an object",
            _ if expected.starts_with("struct ") => "an object",
            _ => expected.as_str(),
        };
        Error::problem(format!("must be {expected}, not {actual}"))
    }
}

/// 해석할 JSON 값 하나.
struct Node<'de>(&'de Value);

impl<'de> Node<'de> {
    /// 정수 field 의 값. min 과 max 는 field 형식의 범위다.
    fn integer(&self, min: i128, max: i128) -> Result<i128, Error> {
        let Value::Number(number) = self.0 else {
            return Err(Error::mismatch("a number", self.0));
        };
        match number
            .as_i64()
            .map(i128::from)
            .or_else(|| number.as_u64().map(i128::from))
        {
            Some(value) if (min..=max).contains(&value) => Ok(value),
            _ => Err(Error::problem(format!(
                "must be an integer from {min} to {max}"
            ))),
        }
    }

    /// 객체를 field 로 읽는다. skip_null 이면 값이 null 인 field 를 건너뛴다.
    fn object<V: Visitor<'de>>(self, visitor: V, skip_null: bool) -> Result<V::Value, Error> {
        match self.0 {
            Value::Object(fields) => visitor.visit_map(Fields {
                fields: fields.iter(),
                key: None,
                skip_null,
            }),
            other => Err(Error::mismatch("an object", other)),
        }
    }
}

macro_rules! integer {
    ($method:ident, $visit:ident, $type:ty) => {
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
            let value = self.integer(i128::from(<$type>::MIN), i128::from(<$type>::MAX))?;
            visitor.$visit(value as $type)
        }
    };
}

impl<'de> de::Deserializer<'de> for Node<'de> {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.0 {
            Value::Null => visitor.visit_unit(),
            Value::Bool(value) => visitor.visit_bool(*value),
            Value::Number(number) => {
                if let Some(value) = number.as_u64() {
                    visitor.visit_u64(value)
                } else if let Some(value) = number.as_i64() {
                    visitor.visit_i64(value)
                } else {
                    // 기본값: JSON 수는 u64, i64, f64 중 하나이므로 앞의 둘이 아니면 f64 다.
                    visitor.visit_f64(number.as_f64().unwrap_or_default())
                }
            }
            Value::String(value) => visitor.visit_borrowed_str(value),
            Value::Array(items) => visitor.visit_seq(Items {
                items: items.iter(),
                index: 0,
            }),
            Value::Object(fields) => visitor.visit_map(Fields {
                fields: fields.iter(),
                key: None,
                skip_null: false,
            }),
        }
    }

    fn deserialize_bool<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.0 {
            Value::Bool(value) => visitor.visit_bool(*value),
            other => Err(Error::mismatch("a boolean", other)),
        }
    }

    integer!(deserialize_i8, visit_i8, i8);
    integer!(deserialize_i16, visit_i16, i16);
    integer!(deserialize_i32, visit_i32, i32);
    integer!(deserialize_i64, visit_i64, i64);
    integer!(deserialize_u8, visit_u8, u8);
    integer!(deserialize_u16, visit_u16, u16);
    integer!(deserialize_u32, visit_u32, u32);
    integer!(deserialize_u64, visit_u64, u64);

    fn deserialize_f32<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_f64(visitor)
    }

    fn deserialize_f64<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.0 {
            // 기본값: serde_json 의 수는 모두 f64 로 읽힌다.
            Value::Number(number) => visitor.visit_f64(number.as_f64().unwrap_or_default()),
            other => Err(Error::mismatch("a number", other)),
        }
    }

    fn deserialize_char<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_str(visitor)
    }

    fn deserialize_str<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.0 {
            Value::String(value) => visitor.visit_borrowed_str(value),
            other => Err(Error::mismatch("a string", other)),
        }
    }

    fn deserialize_string<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_str(visitor)
    }

    fn deserialize_bytes<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_any(visitor)
    }

    fn deserialize_byte_buf<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_any(visitor)
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.0 {
            Value::Null => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_unit<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.0 {
            Value::Null => visitor.visit_unit(),
            other => Err(Error::mismatch("null", other)),
        }
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.deserialize_unit(visitor)
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        // serde_json 의 RawValue 는 이 이름의 newtype 으로 원문을 요구한다. 값의 원문은 serde_json 이 만든다.
        if name == "$serde_json::private::RawValue" {
            return de::Deserializer::deserialize_newtype_struct(self.0, name, visitor)
                .map_err(<Error as de::Error>::custom);
        }
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.0 {
            Value::Array(items) => visitor.visit_seq(Items {
                items: items.iter(),
                index: 0,
            }),
            other => Err(Error::mismatch("an array", other)),
        }
    }

    // 고정 길이 배열([T; N])은 tuple 로 읽힌다. 길이가 다르면 거부한다.
    fn deserialize_tuple<V: Visitor<'de>>(self, len: usize, visitor: V) -> Result<V::Value, Error> {
        match self.0 {
            Value::Array(items) if items.len() != len => {
                Err(Error::problem(format!("must be an array of {len} items")))
            }
            _ => self.deserialize_seq(visitor),
        }
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.deserialize_seq(visitor)
    }

    fn deserialize_map<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.object(visitor, false)
    }

    // 구조체의 null field 는 빠진 field 다(docs/spec/native-host.md#host-calls).
    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.object(visitor, true)
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self.0 {
            Value::String(value) => visitor.visit_enum(value.as_str().into_deserializer()),
            other => Err(Error::mismatch("a string", other)),
        }
    }

    fn deserialize_identifier<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_str(visitor)
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        visitor.visit_unit()
    }
}

/// 배열의 원소. 오류에 원소의 번호를 붙인다.
struct Items<'de> {
    items: std::slice::Iter<'de, Value>,
    index: usize,
}

impl<'de> de::SeqAccess<'de> for Items<'de> {
    type Error = Error;

    fn next_element_seed<T: DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, Error> {
        let Some(item) = self.items.next() else {
            return Ok(None);
        };
        let index = self.index;
        self.index += 1;
        seed.deserialize(Node(item))
            .map(Some)
            .map_err(|error| error.at(format!("[{index}]")))
    }
}

/// 객체의 field. 오류에 field 이름을 붙인다.
struct Fields<'de> {
    fields: serde_json::map::Iter<'de>,
    key: Option<(&'de str, &'de Value)>,
    skip_null: bool,
}

impl<'de> de::MapAccess<'de> for Fields<'de> {
    type Error = Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Error> {
        let Some((key, value)) = self
            .fields
            .by_ref()
            .find(|(_, value)| !(self.skip_null && value.is_null()))
        else {
            return Ok(None);
        };
        self.key = Some((key.as_str(), value));
        seed.deserialize(de::value::BorrowedStrDeserializer::new(key))
            .map(Some)
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Error> {
        let Some((key, value)) = self.key.take() else {
            return Err(<Error as de::Error>::custom(
                "a value was read before its key",
            ));
        };
        seed.deserialize(Node(value))
            .map_err(|error| error.at(format!(".{key}")))
    }
}
