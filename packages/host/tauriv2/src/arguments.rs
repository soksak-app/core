//! Decodes the arguments of a host call that the page sent (docs/spec/native-host.md#host-calls). Tauri rejects an
//! argument with the wording of serde, so a command receives its arguments as [Argument] and decodes them with this
//! decoder, which rejects an argument with the same wording as the argument decoder of the Wails host.

use serde::de::{
    self, DeserializeOwned, DeserializeSeed, Expected, IntoDeserializer, Unexpected, Visitor,
};
use serde_json::Value;
use std::fmt;

/// One command argument. It decodes the value of the key that equals the command argument name as T. An argument that
/// was not sent is null.
pub struct Argument<T>(pub T);

const NULL: Value = Value::Null;

impl<'a, R: tauri::Runtime, T: DeserializeOwned> tauri::ipc::CommandArg<'a, R> for Argument<T> {
    fn from_command(
        command: tauri::ipc::CommandItem<'a, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let value = match command.message.payload() {
            tauri::ipc::InvokeBody::Json(Value::Object(arguments)) => {
                // default: an argument that was not sent decodes as null, as in the Wails host.
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

/// Reads an optional field that accepts only an object as an object value. A value that is not an object is rejected,
/// as the map field of the Wails host does.
pub fn optional_object<'de, D: de::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    use serde::Deserialize;
    Option::<serde_json::Map<String, Value>>::deserialize(deserializer)
        .map(|object| object.map(Value::Object))
}

/// Decodes the argument value with the name name as T.
pub fn decode<T: DeserializeOwned>(name: &str, value: &Value) -> Result<T, String> {
    T::deserialize(Node(value)).map_err(|error| error.message(name))
}

/// The type name of a JSON value.
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

/// A decoding failure. path is the `.field` and `[index]` segments accumulated from the failed position toward the
/// argument.
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

    // Uses the type error that serde creates itself (decoding through the internal Content) as the type name of this
    // decoder.
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

/// One JSON value to decode.
struct Node<'de>(&'de Value);

impl<'de> Node<'de> {
    /// The value of an integer field. min and max are the range of the field type.
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

    /// Reads an object as fields. When skip_null is set, a field whose value is null is skipped.
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
                    // default: a JSON number is one of u64, i64 and f64, so a number that is neither of the first two
                    // is f64.
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
            // default: every number of serde_json is read as f64.
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
        // The RawValue of serde_json requires the original text through a newtype of this name. serde_json creates the
        // original text of the value.
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

    // A fixed-length array ([T; N]) is read as a tuple. A different length is rejected.
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

    // A null field of a struct is a missing field (docs/spec/native-host.md#host-calls).
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

/// An array element. The error names the index of the element.
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

/// An object field. The error names the field.
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
