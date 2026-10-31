use std::collections::BTreeMap;

/// Minimal JSON value that preserves the exact key order and string escaping of
/// JavaScript's `JSON.stringify`, which the package content hash depends on.
pub(super) enum Json {
    Str(String),
    Num(u64),
    Bool(bool),
    Arr(Vec<Json>),
    Obj(Vec<(&'static str, Json)>),
    Sorted(BTreeMap<String, String>),
}

impl Json {
    pub(super) fn str(value: impl Into<String>) -> Self {
        Self::Str(value.into())
    }

    pub(super) fn render(&self) -> String {
        let mut output = String::new();
        self.write(&mut output);
        output
    }

    fn write(&self, output: &mut String) {
        match self {
            Self::Str(value) => write_string(value, output),
            Self::Num(value) => output.push_str(&value.to_string()),
            Self::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Self::Arr(items) => {
                output.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    item.write(output);
                }
                output.push(']');
            }
            Self::Obj(entries) => {
                output.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write_string(key, output);
                    output.push(':');
                    value.write(output);
                }
                output.push('}');
            }
            Self::Sorted(fields) => {
                output.push('{');
                for (index, (key, value)) in fields.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write_string(key, output);
                    output.push(':');
                    write_string(value, output);
                }
                output.push('}');
            }
        }
    }
}

fn write_string(value: &str, output: &mut String) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\u{8}' => output.push_str("\\b"),
            '\u{c}' => output.push_str("\\f"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if (character as u32) < 0x20 => {
                output.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::Json;
    use std::collections::BTreeMap;

    #[test]
    fn renders_javascript_stringify_order_and_escapes() {
        let mut fields = BTreeMap::new();
        fields.insert("a".to_owned(), "line\n\"quote\"".to_owned());
        let value = Json::Obj(vec![
            ("second", Json::Num(2)),
            ("first", Json::Sorted(fields)),
            ("control", Json::Str("\u{1}".to_owned())),
        ]);
        assert_eq!(
            value.render(),
            "{\"second\":2,\"first\":{\"a\":\"line\\n\\\"quote\\\"\"},\"control\":\"\\u0001\"}"
        );
    }
}
