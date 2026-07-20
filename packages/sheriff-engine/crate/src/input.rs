use std::fmt;
use std::marker::PhantomData;

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone)]
pub struct OrderedMap<T>(pub Vec<(String, T)>);

impl<T> Default for OrderedMap<T> {
    fn default() -> Self {
        Self(Vec::new())
    }
}

impl<'de, T> Deserialize<'de> for OrderedMap<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct OrderedMapVisitor<T>(PhantomData<T>);

        impl<'de, T> Visitor<'de> for OrderedMapVisitor<T>
        where
            T: Deserialize<'de>,
        {
            type Value = OrderedMap<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an object")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(OrderedMap(entries))
            }
        }

        deserializer.deserialize_map(OrderedMapVisitor(PhantomData))
    }
}

#[derive(Debug, Clone)]
pub enum ConfigValue {
    String(String),
    Strings(Vec<String>),
    Object(OrderedMap<ConfigValue>),
}

impl<'de> Deserialize<'de> for ConfigValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ConfigValueVisitor;

        impl<'de> Visitor<'de> for ConfigValueVisitor {
            type Value = ConfigValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a tag string, string array, or nested matcher object")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(ConfigValue::String(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(ConfigValue::String(value))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
                while let Some(value) = sequence.next_element::<String>()? {
                    values.push(value);
                }
                Ok(ConfigValue::Strings(values))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(ConfigValue::Object(OrderedMap(entries)))
            }
        }

        deserializer.deserialize_any(ConfigValueVisitor)
    }
}

#[derive(Debug, Clone)]
pub enum RuleValue {
    String(String),
    Strings(Vec<String>),
}

impl RuleValue {
    pub fn matchers(&self) -> &[String] {
        match self {
            Self::String(value) => std::slice::from_ref(value),
            Self::Strings(values) => values,
        }
    }
}

impl<'de> Deserialize<'de> for RuleValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct RuleValueVisitor;

        impl<'de> Visitor<'de> for RuleValueVisitor {
            type Value = RuleValue;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a wildcard string or an array of wildcard strings")
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(RuleValue::String(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(RuleValue::String(value))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
                while let Some(value) = sequence.next_element::<String>()? {
                    values.push(value);
                }
                Ok(RuleValue::Strings(values))
            }
        }

        deserializer.deserialize_any(RuleValueVisitor)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInput {
    pub schema_version: u32,
    pub root_dir: String,
    pub files: Vec<InputFile>,
    #[serde(default)]
    pub module_config: OrderedMap<ConfigValue>,
    #[serde(default, alias = "barrels")]
    pub module_paths: Vec<InputModulePath>,
    pub auto_tagging: bool,
    #[serde(default)]
    pub dep_rules: OrderedMap<RuleValue>,
    #[serde(default)]
    pub deny_rules: OrderedMap<RuleValue>,
    #[serde(default)]
    pub external_rules: OrderedMap<Vec<String>>,
    #[serde(default)]
    pub encapsulation_pattern: Option<String>,
    #[serde(default)]
    pub enable_barrel_less: Option<bool>,
    #[serde(default)]
    pub exclude_root: bool,
    #[serde(default = "default_barrel_file_name")]
    pub barrel_file_name: String,
}

fn default_barrel_file_name() -> String {
    "index.ts".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputFile {
    pub path: String,
    #[serde(default)]
    pub imports: Vec<InputImport>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputImport {
    pub raw: String,
    pub kind: ImportKind,
    #[serde(default)]
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportKind {
    Module,
    External,
    Unresolvable,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputModulePath {
    pub path: String,
    pub is_barrel: bool,
    #[serde(default)]
    pub encapsulated_folder: Option<String>,
    #[serde(default)]
    pub exports: Option<Vec<String>>,
}
