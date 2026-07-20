use std::fmt;
use std::marker::PhantomData;

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

pub const MAX_INPUT_JSON_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FILES: usize = 100_000;
pub const MAX_IMPORTS: usize = 1_000_000;
pub const MAX_MODULES: usize = 100_000;
pub const MAX_RULES: usize = 100_000;
pub const MAX_TAGS: usize = 100_000;
pub const MAX_STRING_BYTES: usize = 16 * 1024;
pub const MAX_REGEX_BYTES: usize = 4 * 1024;
pub const MAX_CONFIG_NESTING: usize = 64;
pub const MAX_REGEX_NESTING: usize = 64;
pub const MAX_PLACEHOLDERS_PER_MATCHER: usize = 64;

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
    Null,
    String(String),
    Strings(Vec<String>),
}

impl RuleValue {
    pub fn matchers(&self) -> &[String] {
        match self {
            Self::Null => &[],
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
                formatter.write_str("null, a wildcard string, or an array of wildcard strings")
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(RuleValue::Null)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(RuleValue::Null)
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
    pub encapsulation_pattern: Option<EncapsulationPattern>,
    #[serde(default)]
    pub enable_barrel_less: bool,
    #[serde(default)]
    pub exclude_root: bool,
    #[serde(default = "default_barrel_file_name")]
    pub barrel_file_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum EncapsulationPattern {
    String(String),
    Regex { source: String, flags: String },
}

impl EngineInput {
    pub fn validate(&self) -> Result<(), String> {
        check_count("files", self.files.len(), MAX_FILES)?;
        check_count("module paths", self.module_paths.len(), MAX_MODULES)?;
        check_string("rootDir", &self.root_dir)?;
        check_string("barrelFileName", &self.barrel_file_name)?;

        let mut import_count = 0usize;
        for (file_index, file) in self.files.iter().enumerate() {
            check_string(&format!("files[{file_index}].path"), &file.path)?;
            import_count = import_count
                .checked_add(file.imports.len())
                .ok_or_else(|| "import count overflowed".to_owned())?;
            for (import_index, import) in file.imports.iter().enumerate() {
                check_string(
                    &format!("files[{file_index}].imports[{import_index}].raw"),
                    &import.raw,
                )?;
                if let Some(path) = &import.resolved_path {
                    check_string(
                        &format!("files[{file_index}].imports[{import_index}].resolvedPath"),
                        path,
                    )?;
                }
            }
        }
        check_count("imports", import_count, MAX_IMPORTS)?;

        for (index, module) in self.module_paths.iter().enumerate() {
            check_string(&format!("modulePaths[{index}].path"), &module.path)?;
            if let Some(folder) = &module.encapsulated_folder {
                check_string(&format!("modulePaths[{index}].encapsulatedFolder"), folder)?;
            }
            if let Some(exports) = &module.exports {
                for (export_index, export) in exports.iter().enumerate() {
                    check_string(
                        &format!("modulePaths[{index}].exports[{export_index}]"),
                        export,
                    )?;
                }
            }
        }

        validate_tag_config(&self.module_config)?;
        validate_rules("depRules", &self.dep_rules)?;
        validate_rules("denyRules", &self.deny_rules)?;
        validate_external_rules(&self.external_rules)?;

        if let Some(pattern) = &self.encapsulation_pattern {
            match pattern {
                EncapsulationPattern::String(value) => {
                    check_string("encapsulationPattern", value)?;
                }
                EncapsulationPattern::Regex { source, flags } => {
                    crate::js_regex::compile(source, flags)?;
                }
            }
        }
        Ok(())
    }
}

fn validate_tag_config(config: &OrderedMap<ConfigValue>) -> Result<(), String> {
    let mut stack = vec![(config, 1usize)];
    let mut entry_count = 0usize;
    let mut tag_count = 0usize;
    while let Some((entries, depth)) = stack.pop() {
        if depth > MAX_CONFIG_NESTING {
            return Err(format!(
                "moduleConfig nesting exceeds the {MAX_CONFIG_NESTING} level limit"
            ));
        }
        entry_count = entry_count
            .checked_add(entries.0.len())
            .ok_or_else(|| "moduleConfig entry count overflowed".to_owned())?;
        check_count("moduleConfig entries", entry_count, MAX_RULES)?;
        for (matcher, value) in &entries.0 {
            check_string("moduleConfig matcher", matcher)?;
            if matcher.starts_with('/') && matcher.ends_with('/') && matcher.len() >= 2 {
                crate::js_regex::compile(&matcher[1..matcher.len() - 1], "")?;
            }
            let placeholder_count = count_placeholders(matcher);
            check_count(
                "placeholders in one moduleConfig matcher",
                placeholder_count,
                MAX_PLACEHOLDERS_PER_MATCHER,
            )?;
            match value {
                ConfigValue::String(tag) => {
                    check_string("moduleConfig tag", tag)?;
                    tag_count += 1;
                }
                ConfigValue::Strings(tags) => {
                    for tag in tags {
                        check_string("moduleConfig tag", tag)?;
                    }
                    tag_count = tag_count
                        .checked_add(tags.len())
                        .ok_or_else(|| "moduleConfig tag count overflowed".to_owned())?;
                }
                ConfigValue::Object(nested) => stack.push((nested, depth + 1)),
            }
            check_count("moduleConfig tags", tag_count, MAX_TAGS)?;
        }
    }
    Ok(())
}

fn validate_rules(name: &str, rules: &OrderedMap<RuleValue>) -> Result<(), String> {
    let matcher_count = rules.0.iter().try_fold(0usize, |count, (from, value)| {
        check_string(&format!("{name} key"), from)?;
        for matcher in value.matchers() {
            check_string(&format!("{name} matcher"), matcher)?;
        }
        count
            .checked_add(value.matchers().len())
            .ok_or_else(|| format!("{name} matcher count overflowed"))
    })?;
    check_count(name, rules.0.len().saturating_add(matcher_count), MAX_RULES)
}

fn validate_external_rules(rules: &OrderedMap<Vec<String>>) -> Result<(), String> {
    let mut count = rules.0.len();
    for (from, matchers) in &rules.0 {
        check_string("externalRules key", from)?;
        count = count
            .checked_add(matchers.len())
            .ok_or_else(|| "externalRules matcher count overflowed".to_owned())?;
        for matcher in matchers {
            check_string("externalRules matcher", matcher)?;
        }
    }
    check_count("externalRules", count, MAX_RULES)
}

fn count_placeholders(value: &str) -> usize {
    let bytes = value.as_bytes();
    let mut count = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        while bytes
            .get(end)
            .is_some_and(|byte| byte.is_ascii_alphabetic() || matches!(byte, b'-' | b'_'))
        {
            end += 1;
        }
        if end > index + 1 && bytes.get(end) == Some(&b'>') {
            count += 1;
            index = end + 1;
        } else {
            index += 1;
        }
    }
    count
}

fn check_count(name: &str, actual: usize, maximum: usize) -> Result<(), String> {
    if actual > maximum {
        Err(format!("{name} count {actual} exceeds the {maximum} limit"))
    } else {
        Ok(())
    }
}

fn check_string(name: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_STRING_BYTES {
        Err(format!(
            "{name} exceeds the {MAX_STRING_BYTES} byte string/path limit"
        ))
    } else {
        Ok(())
    }
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
