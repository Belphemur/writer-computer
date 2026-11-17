//! The wire shape of a query cell, written once for the generated TypeScript.
//!
//! [`Cell`](super::query::Cell) serializes by hand (`Value::to_json` plus `display`), so a derive
//! cannot describe it. These types are that shape as plain data: `Cell`'s `specta::Type` points
//! here, and the test below feeds every [`Value`] variant through `to_json` into
//! [`CellValueWire`], so a change to `to_json` that this description does not follow fails there.
//! Nothing constructs them at runtime.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A Bases value in its tagged JSON form (`Value::to_json`): `type` is the engine's type name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CellValueWire {
    Null,
    Boolean {
        value: bool,
    },
    /// `null` for NaN and infinity (JSON has no such number).
    Number {
        value: Option<f64>,
    },
    String {
        value: String,
    },
    Html {
        value: String,
    },
    Image {
        value: String,
    },
    Icon {
        value: String,
    },
    /// An ISO string: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss...`.
    #[serde(rename_all = "camelCase")]
    Date {
        value: String,
        has_time: bool,
    },
    Duration {
        value: DurationWire,
    },
    List {
        value: Vec<CellValueWire>,
    },
    Object {
        value: BTreeMap<String, CellValueWire>,
    },
    Link {
        value: LinkWire,
    },
    /// A vault-relative path.
    File {
        value: String,
    },
    Regexp {
        value: RegexpWire,
    },
    Error {
        value: ErrorWire,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct DurationWire {
    pub months: i64,
    pub millis: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct LinkWire {
    /// Link text without brackets, heading or alias.
    pub target: String,
    pub display: Option<String>,
    /// Vault-relative path the link resolves to, `null` when unresolved.
    pub resolved: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct RegexpWire {
    pub source: String,
    pub flags: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct ErrorWire {
    pub kind: String,
    pub message: String,
}

/// A value plus the display string the engine computed for it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct CellWire {
    #[serde(flatten)]
    pub value: CellValueWire,
    pub display: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bases::datetime::DurationValue;
    use crate::bases::query::Cell;
    use crate::bases::value::{
        DateValue, ErrorKind, ErrorValue, FileValue, LinkValue, RegexpValue, Value,
    };

    /// One value of every variant (nested lists and objects included).
    fn every_variant() -> Vec<Value> {
        vec![
            Value::Null,
            Value::Bool(true),
            Value::Number(1.5),
            Value::Number(f64::NAN),
            Value::String("s".into()),
            Value::Html("<b>".into()),
            Value::Image("a.png".into()),
            Value::Icon("star".into()),
            Value::Date(DateValue {
                ms: 86_400_000,
                has_time: true,
            }),
            Value::Duration(DurationValue {
                months: 1,
                millis: 2,
            }),
            Value::List(vec![Value::Bool(false), Value::Null]),
            Value::Object(vec![("k".to_string(), Value::String("v".into()))]),
            Value::Link(LinkValue {
                target: "T".into(),
                display: None,
                resolved: Some("T.md".into()),
            }),
            Value::File(FileValue {
                path: "a/b.md".into(),
            }),
            Value::Regexp(RegexpValue::new("a+", "i").unwrap()),
            Value::Error(ErrorValue::new(ErrorKind::Type, "bad")),
        ]
    }

    #[test]
    fn every_cell_value_the_engine_writes_is_a_cell_wire_and_round_trips() {
        let variants = every_variant();
        let names: std::collections::BTreeSet<_> = variants.iter().map(Value::type_name).collect();
        assert_eq!(names.len(), 15, "one value per engine type: {names:?}");
        for v in variants {
            let cell = Cell::new(v.clone());
            let json = serde_json::to_value(&cell).unwrap();
            let wire: CellWire = serde_json::from_value(json.clone())
                .unwrap_or_else(|e| panic!("{json} is not a CellWire: {e}"));
            assert_eq!(
                serde_json::to_value(&wire).unwrap(),
                json,
                "{} does not round-trip",
                v.type_name()
            );
        }
    }
}
