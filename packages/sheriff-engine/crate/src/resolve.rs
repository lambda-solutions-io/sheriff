use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use oxc_resolver::{
    FileMetadata, FileSystem, FileSystemOs, ResolveError, ResolveOptions, ResolverGeneric,
    TsconfigDiscovery, TsconfigOptions, TsconfigReferences,
};
use rustc_hash::FxHashMap;
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::extract::{ExtractedImport, extract_imports};
use crate::input::{MAX_CONFIG_NESTING, MAX_FILES, MAX_IMPORTS, MAX_STRING_BYTES, OrderedMap};
use crate::js_replacement;

const SUPPORTED_COMPILER_OPTIONS: &[&str] = &[
    "allowJs",
    "allowSyntheticDefaultImports",
    "baseUrl",
    "checkJs",
    "declaration",
    "declarationMap",
    "downlevelIteration",
    "esModuleInterop",
    "experimentalDecorators",
    "forceConsistentCasingInFileNames",
    "importHelpers",
    "incremental",
    "isolatedModules",
    "jsx",
    "lib",
    "maxNodeModuleJsDepth",
    "module",
    "moduleResolution",
    "noEmit",
    "noFallthroughCasesInSwitch",
    "noImplicitAny",
    "noImplicitOverride",
    "noImplicitReturns",
    "noPropertyAccessFromIndexSignature",
    "noUnusedLocals",
    "noUnusedParameters",
    "outDir",
    "paths",
    "plugins",
    "resolveJsonModule",
    "skipLibCheck",
    "sourceMap",
    "strict",
    "target",
    "typeRoots",
    "types",
    "useDefineForClassFields",
];

type EngineResolver = ResolverGeneric<OverlayFileSystem>;

#[derive(Clone)]
struct OverlayFileSystem {
    disk: FileSystemOs,
    overlays: Arc<FxHashMap<PathBuf, String>>,
}

impl OverlayFileSystem {
    fn with_overlays(overlays: Option<&FxHashMap<PathBuf, String>>) -> Self {
        Self {
            disk: <FileSystemOs as FileSystem>::new(),
            overlays: Arc::new(overlays.cloned().unwrap_or_default()),
        }
    }

    fn overlay(&self, path: &Path) -> Option<&str> {
        self.overlays.get(path).map(String::as_str)
    }
}

impl FileSystem for OverlayFileSystem {
    fn new() -> Self {
        Self::with_overlays(None)
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        self.overlay(path)
            .map(|source| Ok(source.as_bytes().to_vec()))
            .unwrap_or_else(|| self.disk.read(path))
    }

    fn read_to_string(&self, path: &Path) -> io::Result<String> {
        self.overlay(path)
            .map(|source| Ok(source.to_owned()))
            .unwrap_or_else(|| self.disk.read_to_string(path))
    }

    fn metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        self.overlay(path)
            .map(|_| Ok(FileMetadata::new(true, false, false)))
            .unwrap_or_else(|| self.disk.metadata(path))
    }

    fn symlink_metadata(&self, path: &Path) -> io::Result<FileMetadata> {
        self.overlay(path)
            .map(|_| Ok(FileMetadata::new(true, false, false)))
            .unwrap_or_else(|| self.disk.symlink_metadata(path))
    }

    fn read_link(&self, path: &Path) -> Result<PathBuf, ResolveError> {
        self.disk.read_link(path)
    }

    fn canonicalize(&self, path: &Path) -> io::Result<PathBuf> {
        if self.overlay(path).is_some() {
            std::path::absolute(path)
        } else {
            self.disk.canonicalize(path)
        }
    }
}

const EXPLICITLY_UNSUPPORTED_COMPILER_OPTIONS: &[&str] = &[
    "allowImportingTsExtensions",
    "customConditions",
    "moduleSuffixes",
    "rootDirs",
];

// `typesVersions` is selected against the compiler, not the package or Node.
// Keep this in lockstep with the TypeScript dependency exercised by the
// differential harness.
const TYPESCRIPT_VERSION: Version = Version::new(5, 9, 3);

#[derive(Debug, Clone)]
enum OrderedJson {
    Null,
    Bool,
    Number,
    String(String),
    Array(Vec<OrderedJson>),
    Object(Vec<(String, OrderedJson)>),
}

impl<'de> Deserialize<'de> for OrderedJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct OrderedJsonVisitor;

        impl<'de> Visitor<'de> for OrderedJsonVisitor {
            type Value = OrderedJson;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }

            fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
                Ok(OrderedJson::Bool)
            }

            fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Number)
            }

            fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Number)
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
                Ok(OrderedJson::Number)
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(OrderedJson::String(value.to_owned()))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(OrderedJson::String(value))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(OrderedJson::Null)
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(OrderedJson::Null)
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
                while let Some(value) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(OrderedJson::Array(values))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut entries = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some(entry) = map.next_entry()? {
                    entries.push(entry);
                }
                Ok(OrderedJson::Object(entries))
            }
        }

        deserializer.deserialize_any(OrderedJsonVisitor)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<String>,
}

impl Version {
    const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
            prerelease: Vec::new(),
        }
    }

    fn increment(&self, field: VersionField) -> Result<Self, RangeParseError> {
        match field {
            VersionField::Major => Ok(Self::new(
                self.major
                    .checked_add(1)
                    .ok_or(RangeParseError::Unsupported)?,
                0,
                0,
            )),
            VersionField::Minor => Ok(Self::new(
                self.major,
                self.minor
                    .checked_add(1)
                    .ok_or(RangeParseError::Unsupported)?,
                0,
            )),
            VersionField::Patch => Ok(Self::new(
                self.major,
                self.minor,
                self.patch
                    .checked_add(1)
                    .ok_or(RangeParseError::Unsupported)?,
            )),
        }
    }

    fn with_zero_prerelease(mut self) -> Self {
        self.prerelease = vec!["0".to_owned()];
        self
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        self.major
            .cmp(&other.major)
            .then_with(|| self.minor.cmp(&other.minor))
            .then_with(|| self.patch.cmp(&other.patch))
            .then_with(|| compare_prerelease(&self.prerelease, &other.prerelease))
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Copy)]
enum VersionField {
    Major,
    Minor,
    Patch,
}

#[derive(Debug, Clone, Copy)]
enum ComparatorOperator {
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    Equal,
}

#[derive(Debug, Clone)]
struct Comparator {
    operator: ComparatorOperator,
    operand: Version,
}

#[derive(Debug, Clone)]
struct VersionRange(Vec<Vec<Comparator>>);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RangeParseError {
    Invalid,
    Unsupported,
}

#[derive(Debug)]
struct PartialVersion {
    version: Version,
    major_wildcard: bool,
    minor_wildcard: bool,
    patch_wildcard: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaterializedPath {
    pub key: String,
    pub target: PathBuf,
}

#[derive(Debug)]
pub struct TsConfigContext {
    pub paths: Vec<MaterializedPath>,
    pub root_dir: PathBuf,
    pub base_url: Option<PathBuf>,
    pub module_resolution: Option<String>,
    pub source_config_paths: Vec<PathBuf>,
    pub fallback_reasons: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTsConfig {
    #[serde(default)]
    compiler_options: RawCompilerOptions,
    #[serde(default)]
    extends: Option<Value>,
    #[serde(default)]
    references: Option<Value>,
}

#[derive(Debug, Default)]
struct RawCompilerOptions {
    base_url: Option<String>,
    paths: OrderedMap<Vec<String>>,
    module_resolution: Option<Value>,
    module: Option<Value>,
    option_names: Vec<String>,
}

impl<'de> Deserialize<'de> for RawCompilerOptions {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct OptionsVisitor;

        impl<'de> Visitor<'de> for OptionsVisitor {
            type Value = RawCompilerOptions;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a compilerOptions object")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut options = RawCompilerOptions::default();
                while let Some(key) = map.next_key::<String>()? {
                    options.option_names.push(key.clone());
                    match key.as_str() {
                        "baseUrl" => options.base_url = map.next_value()?,
                        "paths" => options.paths = map.next_value()?,
                        "moduleResolution" => options.module_resolution = map.next_value()?,
                        "module" => options.module = map.next_value()?,
                        _ => {
                            let _: Value = map.next_value()?;
                        }
                    }
                }
                Ok(options)
            }
        }

        deserializer.deserialize_map(OptionsVisitor)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveProjectInput {
    pub schema_version: u32,
    pub ts_config_path: String,
    pub files: Vec<String>,
    #[serde(default)]
    pub ignore_file_extensions: Vec<String>,
    /// Run the Rust side for differential measurement even when the project
    /// is already known to require the TypeScript fallback.
    #[serde(default)]
    pub shadow_mode: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveProjectOutput {
    pub schema_version: u32,
    pub root_dir: String,
    pub files: Vec<ResolvedFile>,
    pub fallback: bool,
    pub fallback_reasons: Vec<String>,
    pub source_config_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveModuleInput {
    pub schema_version: u32,
    pub ts_config_path: String,
    pub containing_file: String,
    pub specifier: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveModuleOutput {
    pub schema_version: u32,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFile {
    pub file: String,
    pub imports: Vec<ResolvedImport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedImport {
    pub raw: String,
    pub kind: ImportKind,
    pub resolved_path: Option<String>,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportKind {
    Module,
    External,
    Unresolvable,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ReachedPackage {
    name: String,
    // Declared externals can be reached even when the package is not installed.
    manifest_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveProjectError {
    Resolution(String),
    LimitExceeded(String),
    CyclicTsConfigExtends(String),
}

/// Stateful resolution context used by `ProjectHandle`. It deliberately owns
/// no source cache: an overlay is supplied to `resolve_file` for exactly one
/// call and is never retained by the resolver.
pub(crate) struct ResolveSession {
    context: TsConfigContext,
    resolver: EngineResolver,
    overlays: FxHashMap<PathBuf, String>,
    ignored: HashSet<String>,
    reached_packages: HashSet<ReachedPackage>,
    import_count: usize,
    shadow_mode: bool,
}

pub(crate) struct ResolveSessionSummary {
    pub root_dir: PathBuf,
    pub source_config_paths: Vec<PathBuf>,
    pub package_manifest_paths: Vec<PathBuf>,
    pub fallback_reasons: Vec<String>,
}

#[derive(Clone)]
pub(crate) struct ResolutionContextSnapshot {
    pub paths: Vec<MaterializedPath>,
    pub root_dir: PathBuf,
    pub base_url: Option<PathBuf>,
    pub module_resolution: Option<String>,
    pub source_config_paths: Vec<PathBuf>,
}

impl ResolveSession {
    pub(crate) fn new_with_overlays(
        ts_config_path: &Path,
        ignore_file_extensions: &[String],
        shadow_mode: bool,
        overlays: &FxHashMap<PathBuf, String>,
    ) -> Result<Self, ResolveProjectError> {
        let mut context = get_ts_config_context_with_overlays(ts_config_path, overlays)?;
        context.fallback_reasons.sort();
        context.fallback_reasons.dedup();
        let resolver = create_resolver(
            Some(ts_config_path),
            context.module_resolution.as_deref(),
            Some(overlays),
        );
        Ok(Self {
            context,
            resolver,
            overlays: overlays.clone(),
            ignored: ignore_file_extensions
                .iter()
                .map(|extension| extension.to_lowercase())
                .collect(),
            reached_packages: HashSet::new(),
            import_count: 0,
            shadow_mode,
        })
    }

    pub(crate) fn root_dir(&self) -> &Path {
        &self.context.root_dir
    }

    pub(crate) fn context_snapshot(&self) -> ResolutionContextSnapshot {
        ResolutionContextSnapshot {
            paths: self.context.paths.clone(),
            root_dir: self.context.root_dir.clone(),
            base_url: self.context.base_url.clone(),
            module_resolution: self.context.module_resolution.clone(),
            source_config_paths: self.context.source_config_paths.clone(),
        }
    }

    pub(crate) fn resolve_file(
        &mut self,
        path: &Path,
        overlay: Option<&str>,
    ) -> Result<Option<ResolvedFile>, ResolveProjectError> {
        if !self.context.fallback_reasons.is_empty() && !self.shadow_mode {
            return Ok(None);
        }
        let source = match overlay {
            Some(source) => source.to_owned(),
            None => fs::read_to_string(path)
                .map_err(|error| format!("could not read {}: {error}", path.display()))?,
        };
        if source.len() > MAX_STRING_BYTES {
            return Err(ResolveProjectError::LimitExceeded(format!(
                "source file {} exceeds the {MAX_STRING_BYTES} byte string/path limit",
                relative_for_oracle(&self.context.root_dir, path)
            )));
        }
        let extracted = extract_imports(path, &source)?;
        self.import_count = checked_import_total(self.import_count, extracted.imports.len())?;
        if !extracted.fallback_reasons.is_empty() {
            let file = relative_for_oracle(&self.context.root_dir, path);
            self.context.fallback_reasons.extend(
                extracted
                    .fallback_reasons
                    .into_iter()
                    .map(|reason| format!("{reason} ({file})")),
            );
            if !self.shadow_mode {
                return Ok(None);
            }
        }
        let imports = resolve_imports(
            path,
            extracted.imports,
            &self.ignored,
            &self.context,
            &self.resolver,
            &self.overlays,
            &mut self.reached_packages,
        )?;
        Ok(Some(ResolvedFile {
            file: relative_for_oracle(&self.context.root_dir, path),
            imports,
        }))
    }

    pub(crate) fn finish(mut self) -> ResolveSessionSummary {
        let mut package_manifest_paths = self
            .reached_packages
            .iter()
            .filter_map(|package| package.manifest_path.clone())
            .collect::<Vec<_>>();
        package_manifest_paths.sort();
        package_manifest_paths.dedup();
        self.context
            .fallback_reasons
            .extend(types_versions_fallback_reasons(
                &self.reached_packages,
                &self.context.root_dir,
                &self.overlays,
            ));
        self.context.fallback_reasons.sort();
        self.context.fallback_reasons.dedup();
        ResolveSessionSummary {
            root_dir: self.context.root_dir,
            source_config_paths: self.context.source_config_paths,
            package_manifest_paths,
            fallback_reasons: self.context.fallback_reasons,
        }
    }
}

pub fn resolve_module_name_for_shadow(
    input: ResolveModuleInput,
) -> Result<ResolveModuleOutput, ResolveProjectError> {
    if input.schema_version != 1 {
        return Err(ResolveProjectError::Resolution(format!(
            "unsupported resolve-module schemaVersion {}; expected 1",
            input.schema_version
        )));
    }
    let context = get_ts_config_context(Path::new(&input.ts_config_path))?;
    let resolver = create_resolver(
        Some(Path::new(&input.ts_config_path)),
        context.module_resolution.as_deref(),
        None,
    );
    let containing_file = Path::new(&input.containing_file);
    let (alias, _) = resolve_ts_path_alias(
        &resolver,
        containing_file,
        &input.specifier,
        &context.paths,
        &FxHashMap::default(),
    );
    let manifest_path = (!is_relative_import(&input.specifier)
        && !Path::new(&input.specifier).is_absolute())
    .then(|| {
        containing_file.parent().and_then(|directory| {
            find_installed_package_manifest(
                directory,
                &extract_package_name(&input.specifier),
                &FxHashMap::default(),
            )
        })
    })
    .flatten();
    let resolved_path = alias
        .or_else(|| {
            normal_resolve(
                &resolver,
                containing_file,
                &input.specifier,
                &context,
                manifest_path.as_deref(),
                &FxHashMap::default(),
            )
        })
        .map(|path| path.to_string_lossy().into_owned());
    Ok(ResolveModuleOutput {
        schema_version: 1,
        resolved_path,
    })
}

impl std::fmt::Display for ResolveProjectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Resolution(message)
            | Self::LimitExceeded(message)
            | Self::CyclicTsConfigExtends(message) => formatter.write_str(message),
        }
    }
}

impl From<String> for ResolveProjectError {
    fn from(message: String) -> Self {
        Self::Resolution(message)
    }
}

pub fn resolve_project(
    input: ResolveProjectInput,
) -> Result<ResolveProjectOutput, ResolveProjectError> {
    if input.schema_version != 1 {
        return Err(ResolveProjectError::Resolution(format!(
            "unsupported resolve-project schemaVersion {}; expected 1",
            input.schema_version
        )));
    }
    validate_input_strings(&input)?;

    let mut context = get_ts_config_context(Path::new(&input.ts_config_path))?;
    context.fallback_reasons.sort();
    context.fallback_reasons.dedup();
    let initial_fallback = !context.fallback_reasons.is_empty();
    let resolver = create_resolver(
        Some(Path::new(&input.ts_config_path)),
        context.module_resolution.as_deref(),
        None,
    );
    let ignored: HashSet<String> = input
        .ignore_file_extensions
        .into_iter()
        .map(|extension| extension.to_lowercase())
        .collect();
    let mut files = Vec::with_capacity(input.files.len());
    let mut import_count = 0;
    let mut reached_packages = HashSet::new();
    let mut processing_error = None;

    if !initial_fallback || input.shadow_mode {
        for file in input.files {
            let result = (|| -> Result<(), ResolveProjectError> {
                let path = PathBuf::from(&file);
                let source = fs::read_to_string(&path)
                    .map_err(|error| format!("could not read {}: {error}", path.display()))?;
                if source.len() > MAX_STRING_BYTES {
                    return Err(ResolveProjectError::LimitExceeded(format!(
                        "source file {} exceeds the {MAX_STRING_BYTES} byte string/path limit",
                        relative_for_oracle(&context.root_dir, &path)
                    )));
                }
                let extracted = extract_imports(&path, &source)?;
                import_count = checked_import_total(import_count, extracted.imports.len())?;
                if !extracted.fallback_reasons.is_empty() {
                    let file = relative_for_oracle(&context.root_dir, &path);
                    context.fallback_reasons.extend(
                        extracted
                            .fallback_reasons
                            .into_iter()
                            .map(|reason| format!("{reason} ({file})")),
                    );
                    if !input.shadow_mode {
                        files.clear();
                        return Ok(());
                    }
                }
                let imports = resolve_imports(
                    &path,
                    extracted.imports,
                    &ignored,
                    &context,
                    &resolver,
                    &FxHashMap::default(),
                    &mut reached_packages,
                )?;
                files.push(ResolvedFile {
                    file: relative_for_oracle(&context.root_dir, &path),
                    imports,
                });
                Ok(())
            })();
            if let Err(error) = result {
                processing_error = Some(error);
                break;
            }
            if !context.fallback_reasons.is_empty() && !input.shadow_mode {
                break;
            }
        }
        files.sort_by(|left, right| left.file.cmp(&right.file));
    }

    // Package features can only be audited after resolution identifies the
    // packages that matter. Preserve whole-project fallback by discarding the
    // completed Rust result outside shadow mode when this late gate fires.
    context
        .fallback_reasons
        .extend(types_versions_fallback_reasons(
            &reached_packages,
            &context.root_dir,
            &FxHashMap::default(),
        ));
    context.fallback_reasons.sort();
    context.fallback_reasons.dedup();
    let fallback = !context.fallback_reasons.is_empty();
    if processing_error.is_some() || (fallback && !input.shadow_mode) {
        files.clear();
    }
    if let Some(error) = processing_error {
        return Err(error);
    }

    Ok(ResolveProjectOutput {
        schema_version: 1,
        root_dir: context.root_dir.to_string_lossy().into_owned(),
        files,
        fallback,
        fallback_reasons: context.fallback_reasons,
        source_config_paths: context
            .source_config_paths
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    })
}

fn validate_input_strings(input: &ResolveProjectInput) -> Result<(), ResolveProjectError> {
    if input.files.len() > MAX_FILES {
        return Err(ResolveProjectError::LimitExceeded(format!(
            "files count {} exceeds the {MAX_FILES} limit",
            input.files.len()
        )));
    }
    for (name, value) in std::iter::once(("tsConfigPath".to_owned(), &input.ts_config_path))
        .chain(
            input
                .files
                .iter()
                .enumerate()
                .map(|(index, file)| (format!("files[{index}]"), file)),
        )
        .chain(
            input
                .ignore_file_extensions
                .iter()
                .enumerate()
                .map(|(index, extension)| (format!("ignoreFileExtensions[{index}]"), extension)),
        )
    {
        if value.len() > MAX_STRING_BYTES {
            return Err(ResolveProjectError::LimitExceeded(format!(
                "{name} exceeds the {MAX_STRING_BYTES} byte string/path limit"
            )));
        }
    }
    Ok(())
}

fn checked_import_total(current: usize, additional: usize) -> Result<usize, ResolveProjectError> {
    let total = current
        .checked_add(additional)
        .ok_or_else(|| ResolveProjectError::LimitExceeded("import count overflowed".to_owned()))?;
    if total > MAX_IMPORTS {
        Err(ResolveProjectError::LimitExceeded(format!(
            "imports count {total} exceeds the {MAX_IMPORTS} limit"
        )))
    } else {
        Ok(total)
    }
}

pub fn get_ts_config_context(
    ts_config_path: &Path,
) -> Result<TsConfigContext, ResolveProjectError> {
    get_ts_config_context_with_overlays(ts_config_path, &FxHashMap::default())
}

fn get_ts_config_context_with_overlays(
    ts_config_path: &Path,
    overlays: &FxHashMap<PathBuf, String>,
) -> Result<TsConfigContext, ResolveProjectError> {
    let mut current_path = ts_config_path.to_path_buf();
    let mut current_dir = parent(&current_path)?;
    let mut paths: Vec<MaterializedPath> = Vec::new();
    let mut base_url = None;
    let mut module_resolution = None;
    let mut source_config_paths = Vec::new();
    let mut fallback_reasons = Vec::new();
    let mut unique_config_paths = HashSet::new();
    let resolver = create_resolver(None, None, Some(overlays));

    loop {
        unique_config_paths.insert(current_path.clone());
        if unique_config_paths.len() > MAX_CONFIG_NESTING {
            return Err(ResolveProjectError::LimitExceeded(format!(
                "tsconfig extends chain exceeds the {MAX_CONFIG_NESTING} level limit"
            )));
        }
        source_config_paths.push(current_path.clone());
        let config = read_ts_config(
            &current_path,
            overlays.get(&current_path).map(String::as_str),
        )?;

        if base_url.is_none()
            && let Some(raw_base_url) = &config.compiler_options.base_url
        {
            base_url = Some(node_join(&current_dir, raw_base_url));
        }
        if module_resolution.is_none() {
            module_resolution = config
                .compiler_options
                .module_resolution
                .as_ref()
                .and_then(Value::as_str)
                .map(str::to_owned);
        }

        collect_fallback_reasons(&current_path, &config, &mut fallback_reasons);

        for (key, targets) in config.compiler_options.paths.0 {
            let Some(value) = targets.first() else {
                return Err(ResolveProjectError::Resolution(format!(
                    "invalid path mapping {key} in {}: target array is empty",
                    current_path.display()
                )));
            };
            let value_for_path = value.strip_suffix("/*").unwrap_or(value);
            let mapping_base = config.compiler_options.base_url.as_deref().unwrap_or("./");
            let potential = node_join(&node_join(&current_dir, mapping_base), value_for_path);
            let target = if potential.exists() {
                potential
            } else if potential.extension().and_then(|value| value.to_str()) != Some("ts") {
                let ts_candidate = PathBuf::from(format!("{}.ts", potential.to_string_lossy()));
                if ts_candidate.exists() {
                    ts_candidate
                } else {
                    return Err(ResolveProjectError::Resolution(format!(
                        "invalid path mapping {key} -> {value} in {}",
                        current_path.display()
                    )));
                }
            } else {
                return Err(ResolveProjectError::Resolution(format!(
                    "invalid path mapping {key} -> {value} in {}",
                    current_path.display()
                )));
            };

            // Bug-compatible with sheriff: assignment while walking toward the
            // ancestor overwrites the child's value without moving its object
            // insertion slot, so the furthest ancestor wins collisions.
            if let Some(existing) = paths.iter_mut().find(|mapping| mapping.key == key) {
                existing.target = target;
            } else {
                paths.push(MaterializedPath { key, target });
            }
        }

        let Some(extends_value) = config.extends else {
            break;
        };
        let Some(extends) = extends_value.as_str() else {
            return Err(ResolveProjectError::Resolution(format!(
                "unsupported non-string extends in {}",
                current_path.display()
            )));
        };

        let literal = node_join(&current_dir, extends);
        let extended = if literal.exists() {
            literal
        } else {
            let extended = resolve_potential_ts_path(extends, &paths, |rewritten| {
                resolver
                    // Sheriff passes the config directory as TypeScript's
                    // `containingFile`; preserve that oddity with resolve_file.
                    .resolve_file(&current_dir, rewritten)
                    .ok()
                    .map(|resolution| resolution.into_path_buf())
            });
            let Some(extended) = extended else {
                return Err(ResolveProjectError::Resolution(format!(
                    "cannot resolve extends {extends} from {}",
                    current_path.display()
                )));
            };
            extended
        };

        // A repeated path is a cycle even when the acyclic chain is near the
        // nesting limit, so detect it before starting the next capped step.
        if unique_config_paths.contains(&extended) {
            let cycle_start = source_config_paths
                .iter()
                .position(|path| path == &extended)
                .expect("visited config path must be present in source config paths");
            let cycle_path = source_config_paths[cycle_start..]
                .iter()
                .chain(std::iter::once(&extended))
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(" -> ");
            return Err(ResolveProjectError::CyclicTsConfigExtends(format!(
                "Cyclic \"extends\" detected in {}: {cycle_path}. Please remove the cycle.",
                current_path.display()
            )));
        }
        current_path = extended;
        current_dir = parent(&current_path)?;
    }

    let root_prefix = format!("{}{}", current_dir.display(), std::path::MAIN_SEPARATOR);
    fallback_reasons = fallback_reasons
        .into_iter()
        .map(|reason| reason.replace(&root_prefix, ""))
        .collect();
    fallback_reasons.sort();
    fallback_reasons.dedup();
    Ok(TsConfigContext {
        paths,
        root_dir: current_dir,
        base_url,
        module_resolution,
        source_config_paths,
        fallback_reasons,
    })
}

fn collect_fallback_reasons(path: &Path, config: &RawTsConfig, reasons: &mut Vec<String>) {
    for option in &config.compiler_options.option_names {
        if EXPLICITLY_UNSUPPORTED_COMPILER_OPTIONS.contains(&option.as_str()) {
            reasons.push(format!(
                "unsupported compilerOption {option} declared in {}",
                path.display()
            ));
        } else if !SUPPORTED_COMPILER_OPTIONS.contains(&option.as_str()) {
            reasons.push(format!(
                "compilerOption {option} is outside the Rust resolver whitelist ({})",
                path.display()
            ));
        }
    }

    validate_option_value(
        path,
        "moduleResolution",
        config.compiler_options.module_resolution.as_ref(),
        &["node", "node10", "bundler"],
        reasons,
    );
    validate_option_value(
        path,
        "module",
        config.compiler_options.module.as_ref(),
        &["commonjs", "es2022", "esnext"],
        reasons,
    );

    if config
        .references
        .as_ref()
        .is_some_and(|references| references.as_array().is_none_or(|items| !items.is_empty()))
    {
        reasons.push(format!(
            "project references are outside the Rust resolver whitelist ({})",
            path.display()
        ));
    }
}

fn validate_option_value(
    path: &Path,
    name: &str,
    value: Option<&Value>,
    allowed: &[&str],
    reasons: &mut Vec<String>,
) {
    let Some(value) = value else {
        return;
    };
    let supported = value
        .as_str()
        .is_some_and(|value| allowed.contains(&value.to_ascii_lowercase().as_str()));
    if !supported {
        reasons.push(format!(
            "compilerOption {name} value {value} is outside the Rust resolver whitelist ({})",
            path.display()
        ));
    }
}

fn read_ts_config(path: &Path, overlay: Option<&str>) -> Result<RawTsConfig, ResolveProjectError> {
    let raw = overlay.map(str::to_owned).map_or_else(
        || {
            fs::read_to_string(path).map_err(|error| {
                ResolveProjectError::Resolution(format!(
                    "could not read {}: {error}",
                    path.display()
                ))
            })
        },
        Ok,
    )?;
    if raw.len() > MAX_STRING_BYTES {
        return Err(ResolveProjectError::LimitExceeded(format!(
            "tsconfig {} exceeds the {MAX_STRING_BYTES} byte string/path limit",
            path.display()
        )));
    }
    let sanitized = sanitize_jsonc(&raw);
    serde_json::from_str(&sanitized).map_err(|error| {
        ResolveProjectError::Resolution(format!("invalid tsconfig {}: {error}", path.display()))
    })
}

fn sanitize_jsonc(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut output = bytes.to_vec();
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;

    while index < bytes.len() {
        if in_string {
            if escaped {
                escaped = false;
            } else if bytes[index] == b'\\' {
                escaped = true;
            } else if bytes[index] == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }

        if bytes[index] == b'"' {
            in_string = true;
            index += 1;
        } else if bytes[index..].starts_with(b"//") {
            output[index] = b' ';
            output[index + 1] = b' ';
            index += 2;
            while index < bytes.len() && !matches!(bytes[index], b'\n' | b'\r') {
                output[index] = b' ';
                index += 1;
            }
        } else if bytes[index..].starts_with(b"/*") {
            output[index] = b' ';
            output[index + 1] = b' ';
            index += 2;
            while index + 1 < bytes.len() && !bytes[index..].starts_with(b"*/") {
                if !matches!(bytes[index], b'\n' | b'\r') {
                    output[index] = b' ';
                }
                index += 1;
            }
            if index + 1 < bytes.len() {
                output[index] = b' ';
                output[index + 1] = b' ';
                index += 2;
            }
        } else {
            index += 1;
        }
    }

    // TypeScript accepts trailing commas in tsconfig JSONC; serde_json does not.
    in_string = false;
    escaped = false;
    for index in 0..output.len() {
        if in_string {
            if escaped {
                escaped = false;
            } else if output[index] == b'\\' {
                escaped = true;
            } else if output[index] == b'"' {
                in_string = false;
            }
            continue;
        }
        if output[index] == b'"' {
            in_string = true;
        } else if output[index] == b',' {
            let next = output[index + 1..]
                .iter()
                .copied()
                .find(|byte| !byte.is_ascii_whitespace());
            if matches!(next, Some(b'}' | b']')) {
                output[index] = b' ';
            }
        }
    }

    String::from_utf8(output).expect("JSONC sanitization preserves UTF-8")
}

fn create_resolver(
    ts_config_path: Option<&Path>,
    _module_resolution: Option<&str>,
    overlays: Option<&FxHashMap<PathBuf, String>>,
) -> EngineResolver {
    EngineResolver::new_with_file_system(
        OverlayFileSystem::with_overlays(overlays),
        ResolveOptions {
            tsconfig: ts_config_path.map(|config_file| {
                TsconfigDiscovery::Manual(TsconfigOptions {
                    config_file: config_file.to_path_buf(),
                    references: TsconfigReferences::Disabled,
                })
            }),
            // Sheriff currently passes the full ts.readConfigFile result instead
            // of its `config` member to parseJsonConfigFileContent. Consequently,
            // ts.resolveModuleName sees none of the parsed compiler options and
            // uses its default condition set even when the raw config says bundler.
            condition_names: Vec::new(),
            exports_fields: Vec::new(),
            imports_fields: Vec::new(),
            extensions: vec![
                ".ts".to_owned(),
                ".tsx".to_owned(),
                ".d.ts".to_owned(),
                ".mts".to_owned(),
                ".cts".to_owned(),
                ".js".to_owned(),
                ".jsx".to_owned(),
                ".mjs".to_owned(),
                ".cjs".to_owned(),
            ],
            extension_alias: vec![
                (
                    ".js".to_owned(),
                    vec![".ts".to_owned(), ".tsx".to_owned(), ".js".to_owned()],
                ),
                (
                    ".mjs".to_owned(),
                    vec![".mts".to_owned(), ".mjs".to_owned()],
                ),
                (
                    ".cjs".to_owned(),
                    vec![".cts".to_owned(), ".cjs".to_owned()],
                ),
            ],
            main_fields: vec!["types".to_owned(), "typings".to_owned(), "main".to_owned()],
            // TypeScript's `isExternalLibraryImport` describes how a request was
            // found, even when a node_modules symlink points outside the project.
            // Keeping the unresolved symlink path preserves that classification.
            symlinks: false,
            ..ResolveOptions::default()
        },
    )
}

fn resolve_imports(
    importing_file: &Path,
    extracted: Vec<ExtractedImport>,
    ignored: &HashSet<String>,
    context: &TsConfigContext,
    resolver: &EngineResolver,
    overlays: &FxHashMap<PathBuf, String>,
    reached_packages: &mut HashSet<ReachedPackage>,
) -> Result<Vec<ResolvedImport>, String> {
    let importing_dir = parent(importing_file)?;
    let universe = dependency_universe(&importing_dir, &context.root_dir, overlays);
    let mut external_seen = HashSet::new();
    let mut output = Vec::new();

    for import in extracted {
        let extension = import
            .raw
            .split('.')
            .next_back()
            .unwrap_or_default()
            .to_lowercase();
        if !extension.is_empty() && ignored.contains(&extension) {
            continue;
        }

        let is_bare_import =
            !is_relative_import(&import.raw) && !Path::new(&import.raw).is_absolute();
        let installed_package_manifest = is_bare_import
            .then(|| {
                find_installed_package_manifest(
                    &importing_dir,
                    &extract_package_name(&import.raw),
                    overlays,
                )
            })
            .flatten();
        // Sheriff computes normal resolution eagerly even though alias resolution
        // has priority over it.
        let normal = normal_resolve(
            resolver,
            importing_file,
            &import.raw,
            context,
            installed_package_manifest.as_deref(),
            overlays,
        );
        let normal_is_none = normal.is_none();
        let normal_package = normal.as_deref().and_then(reached_package_from_path);
        let (alias, alias_package) = resolve_ts_path_alias(
            resolver,
            importing_file,
            &import.raw,
            &context.paths,
            overlays,
        );
        let alias_is_none = alias.is_none();

        let (kind, resolved) = classify(&import.raw, alias, normal, &context.root_dir, &universe)?;
        if let Some(package) = alias_package {
            reached_packages.insert(package);
        }
        if alias_is_none && let Some(package) = normal_package {
            reached_packages.insert(package);
        }
        if is_bare_import
            && (kind == ImportKind::External || (alias_is_none && normal_is_none))
            && let Some(manifest_path) = installed_package_manifest
        {
            reached_packages.insert(ReachedPackage {
                name: extract_package_name(&import.raw),
                manifest_path: Some(manifest_path),
            });
        } else if kind == ImportKind::External
            && !reached_packages
                .iter()
                .any(|package| package.name == extract_package_name(&import.raw))
        {
            reached_packages.insert(ReachedPackage {
                name: extract_package_name(&import.raw),
                manifest_path: None,
            });
        }
        if kind == ImportKind::External && !external_seen.insert(import.raw.clone()) {
            continue;
        }
        output.push(ResolvedImport {
            raw: import.raw,
            kind,
            resolved_path: resolved.map(|path| relative_for_oracle(&context.root_dir, &path)),
            start: import.start,
            end: import.end,
        });
    }
    Ok(output)
}

fn resolve_ts_path_alias(
    resolver: &EngineResolver,
    importing_file: &Path,
    specifier: &str,
    paths: &[MaterializedPath],
    overlays: &FxHashMap<PathBuf, String>,
) -> (Option<PathBuf>, Option<ReachedPackage>) {
    let mut reached_package = None;
    let resolved = resolve_potential_ts_path(specifier, paths, |rewritten| {
        let rewritten_path = Path::new(rewritten);
        let package = reached_package_from_path(rewritten_path);
        if let Some(package) = &package {
            reached_package = Some(package.clone());
            if let Some(manifest_path) = &package.manifest_path {
                let package_specifier = package_specifier_for_path(package, rewritten_path);
                if let Ok(Some(mapped)) = resolve_types_versions(
                    resolver,
                    importing_file,
                    &package_specifier,
                    manifest_path,
                    overlays,
                ) {
                    return Some(mapped);
                }
            }
        }
        resolver
            .resolve_file(importing_file, rewritten)
            .ok()
            .map(|resolution| resolution.into_path_buf())
    });
    if let Some(package) = resolved.as_deref().and_then(reached_package_from_path) {
        reached_package = Some(package);
    }
    (resolved, reached_package)
}

fn package_specifier_for_path(package: &ReachedPackage, path: &Path) -> String {
    let Some(package_root) = package.manifest_path.as_deref().and_then(Path::parent) else {
        return package.name.clone();
    };
    let Ok(subpath) = path.strip_prefix(package_root) else {
        return package.name.clone();
    };
    if subpath.as_os_str().is_empty() {
        package.name.clone()
    } else {
        format!(
            "{}/{}",
            package.name,
            subpath.to_string_lossy().replace('\\', "/")
        )
    }
}

fn normal_resolve(
    resolver: &EngineResolver,
    importing_file: &Path,
    specifier: &str,
    context: &TsConfigContext,
    package_manifest: Option<&Path>,
    overlays: &FxHashMap<PathBuf, String>,
) -> Option<PathBuf> {
    // resolveJsonModule never reaches Sheriff's ts.resolveModuleName call (see
    // create_resolver), while oxc resolves an explicit existing .json path even
    // when .json is absent from the extension probe list.
    if specifier
        .rsplit_once('.')
        .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case("json"))
    {
        return None;
    }
    if !is_relative_import(specifier)
        && !Path::new(specifier).is_absolute()
        && let Some(base_url) = &context.base_url
    {
        let base_candidate = node_join(base_url, specifier);
        if let Ok(resolution) =
            resolver.resolve_file(importing_file, base_candidate.to_string_lossy().as_ref())
        {
            return Some(resolution.into_path_buf());
        }
    }
    if let Some(manifest_path) = package_manifest
        && let Ok(Some(resolved)) =
            resolve_types_versions(resolver, importing_file, specifier, manifest_path, overlays)
    {
        return Some(resolved);
    }
    resolver
        .resolve_file(importing_file, specifier)
        .ok()
        .map(|resolution| resolution.into_path_buf())
}

pub fn resolve_potential_ts_path(
    module_name: &str,
    paths: &[MaterializedPath],
    mut resolve: impl FnMut(&str) -> Option<PathBuf>,
) -> Option<PathBuf> {
    // Deliberately outside the loop: Sheriff accidentally retains this value
    // after a matching key. Later non-matching keys retry the stale rewrite.
    let mut unpathed_import: Option<String> = None;
    for mapping in paths {
        let (wildcard, cleared) = mapping
            .key
            .strip_suffix("/*")
            .map_or((false, mapping.key.as_str()), |key| (true, key));
        if wildcard && module_name.starts_with(cleared) {
            // JS String.replace replaces the first occurrence only. The
            // startsWith check intentionally has no path-separator boundary.
            unpathed_import = Some(js_replacement::replace_first(
                module_name,
                cleared,
                mapping.target.to_string_lossy().as_ref(),
            ));
        } else if mapping.key == module_name {
            unpathed_import = Some(mapping.target.to_string_lossy().into_owned());
        }

        if let Some(rewritten) = &unpathed_import {
            // JavaScript's `if (unpathedImport)` skips an empty exact mapping.
            if rewritten.is_empty() {
                continue;
            }
            let rewritten_path = Path::new(rewritten);
            if rewritten_path.exists() && rewritten_path.is_file() {
                return Some(rewritten_path.to_path_buf());
            }
            if let Some(resolved) = resolve(rewritten) {
                return Some(resolved);
            }
        }
    }
    None
}

fn classify(
    raw: &str,
    alias: Option<PathBuf>,
    normal: Option<PathBuf>,
    root_dir: &Path,
    universe: &HashSet<String>,
) -> Result<(ImportKind, Option<PathBuf>), String> {
    if let Some(alias) = alias {
        return Ok((ImportKind::Module, Some(alias)));
    }

    if let Some(normal) = normal {
        if is_node_modules_path(&normal) {
            return Ok((ImportKind::External, None));
        }
        // Bug-compatible plain string prefix check: `/root-other` is treated as
        // inside `/root`, despite not being path-contained by it.
        if !normal
            .to_string_lossy()
            .starts_with(root_dir.to_string_lossy().as_ref())
        {
            return Err(format!(
                "{} is outside of root {}",
                normal.display(),
                root_dir.display()
            ));
        }
        return Ok((ImportKind::Module, Some(normal)));
    }

    let declared_external = !is_relative_import(raw)
        && !Path::new(raw).is_absolute()
        && universe.contains(&extract_package_name(raw));
    Ok((
        if declared_external {
            ImportKind::External
        } else {
            ImportKind::Unresolvable
        },
        None,
    ))
}

fn dependency_universe(
    file_dir: &Path,
    root_dir: &Path,
    overlays: &FxHashMap<PathBuf, String>,
) -> HashSet<String> {
    if file_dir.strip_prefix(root_dir).is_err() {
        return HashSet::new();
    }
    let mut current = file_dir.to_path_buf();
    loop {
        let manifest = current.join("package.json");
        if manifest.is_file() || overlays.contains_key(&manifest) {
            return parse_dependency_universe(
                &manifest,
                overlays.get(&manifest).map(String::as_str),
            );
        }
        if current == root_dir {
            return HashSet::new();
        }
        let Some(next) = current.parent() else {
            return HashSet::new();
        };
        current = next.to_path_buf();
    }
}

impl VersionRange {
    fn try_parse(text: &str) -> Result<Option<Self>, RangeParseError> {
        if !text.is_ascii() {
            // TypeScript's regular expressions accept Unicode whitespace. The
            // Rust implementation intentionally limits its faithful grammar to
            // ASCII and preserves fallback for anything outside it.
            return Err(RangeParseError::Unsupported);
        }
        let mut alternatives = Vec::new();
        for raw_alternative in text.trim().split("||") {
            let alternative = raw_alternative.trim();
            if alternative.is_empty() {
                continue;
            }
            let mut comparators = Vec::new();
            if let Some((left, right)) = split_hyphen_range(alternative) {
                parse_hyphen(left, right, &mut comparators)?;
            } else {
                for simple in alternative.split_whitespace() {
                    parse_comparator(simple, &mut comparators)?;
                }
            }
            alternatives.push(comparators);
        }
        Ok(Some(Self(alternatives)))
    }

    fn test(&self, version: &Version) -> bool {
        self.0.is_empty()
            || self.0.iter().any(|alternative| {
                alternative.iter().all(|comparator| {
                    let ordering = version.cmp(&comparator.operand);
                    match comparator.operator {
                        ComparatorOperator::Less => ordering.is_lt(),
                        ComparatorOperator::LessEqual => !ordering.is_gt(),
                        ComparatorOperator::Greater => ordering.is_gt(),
                        ComparatorOperator::GreaterEqual => !ordering.is_lt(),
                        ComparatorOperator::Equal => ordering.is_eq(),
                    }
                })
            })
    }
}

fn compare_prerelease(left: &[String], right: &[String]) -> Ordering {
    if left.is_empty() || right.is_empty() {
        return match (left.is_empty(), right.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => unreachable!(),
        };
    }
    for (left_part, right_part) in left.iter().zip(right) {
        let ordering = match (
            numeric_identifier(left_part),
            numeric_identifier(right_part),
        ) {
            (Some(left_number), Some(right_number)) => left_number.cmp(&right_number),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => left_part.cmp(right_part),
        };
        if !ordering.is_eq() {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

fn numeric_identifier(value: &str) -> Option<u64> {
    ((!value.is_empty())
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0')))
    .then(|| value.parse().ok())
    .flatten()
}

fn split_hyphen_range(range: &str) -> Option<(&str, &str)> {
    let bytes = range.as_bytes();
    let mut match_at = None;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'-'
            && index > 0
            && index + 1 < bytes.len()
            && bytes[index - 1].is_ascii_whitespace()
            && bytes[index + 1].is_ascii_whitespace()
        {
            if match_at.is_some() {
                return None;
            }
            match_at = Some(index);
        }
    }
    let index = match_at?;
    let left = range[..index].trim();
    let right = range[index + 1..].trim();
    (!left.is_empty()
        && !right.is_empty()
        && left.bytes().all(is_range_component_byte)
        && right.bytes().all(is_range_component_byte))
    .then_some((left, right))
}

fn is_range_component_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'+' | b'.' | b'*')
}

fn parse_hyphen(
    left: &str,
    right: &str,
    comparators: &mut Vec<Comparator>,
) -> Result<(), RangeParseError> {
    let left = parse_partial(left)?;
    let right = parse_partial(right)?;
    if !left.major_wildcard {
        comparators.push(Comparator {
            operator: ComparatorOperator::GreaterEqual,
            operand: left.version,
        });
    }
    if !right.major_wildcard {
        let (operator, operand) = if right.minor_wildcard {
            (
                ComparatorOperator::Less,
                right.version.increment(VersionField::Major)?,
            )
        } else if right.patch_wildcard {
            (
                ComparatorOperator::Less,
                right.version.increment(VersionField::Minor)?,
            )
        } else {
            (ComparatorOperator::LessEqual, right.version)
        };
        comparators.push(Comparator { operator, operand });
    }
    Ok(())
}

fn parse_comparator(
    simple: &str,
    comparators: &mut Vec<Comparator>,
) -> Result<(), RangeParseError> {
    let (operator, version_text) = ["<=", ">=", "~", "^", "<", ">", "="]
        .into_iter()
        .find_map(|operator| {
            simple
                .strip_prefix(operator)
                .map(|version| (Some(operator), version))
        })
        .unwrap_or((None, simple));
    if version_text.is_empty() || !version_text.bytes().all(is_range_component_byte) {
        return Err(RangeParseError::Invalid);
    }
    let partial = parse_partial(version_text)?;
    if partial.major_wildcard {
        if matches!(operator, Some("<" | ">")) {
            comparators.push(Comparator {
                operator: ComparatorOperator::Less,
                operand: Version {
                    prerelease: vec!["0".to_owned()],
                    ..Version::new(0, 0, 0)
                },
            });
        }
        return Ok(());
    }

    let version = partial.version;
    match operator {
        Some("~") => {
            comparators.push(Comparator {
                operator: ComparatorOperator::GreaterEqual,
                operand: version.clone(),
            });
            comparators.push(Comparator {
                operator: ComparatorOperator::Less,
                operand: version.increment(if partial.minor_wildcard {
                    VersionField::Major
                } else {
                    VersionField::Minor
                })?,
            });
        }
        Some("^") => {
            comparators.push(Comparator {
                operator: ComparatorOperator::GreaterEqual,
                operand: version.clone(),
            });
            let field = if version.major > 0 || partial.minor_wildcard {
                VersionField::Major
            } else if version.minor > 0 || partial.patch_wildcard {
                VersionField::Minor
            } else {
                VersionField::Patch
            };
            comparators.push(Comparator {
                operator: ComparatorOperator::Less,
                operand: version.increment(field)?,
            });
        }
        Some("<" | ">=") => {
            let version = if partial.minor_wildcard || partial.patch_wildcard {
                version.with_zero_prerelease()
            } else {
                version
            };
            comparators.push(Comparator {
                operator: if operator == Some("<") {
                    ComparatorOperator::Less
                } else {
                    ComparatorOperator::GreaterEqual
                },
                operand: version,
            });
        }
        Some("<=" | ">") => {
            let (operator, version) = if partial.minor_wildcard {
                (
                    if operator == Some("<=") {
                        ComparatorOperator::Less
                    } else {
                        ComparatorOperator::GreaterEqual
                    },
                    version
                        .increment(VersionField::Major)?
                        .with_zero_prerelease(),
                )
            } else if partial.patch_wildcard {
                (
                    if operator == Some("<=") {
                        ComparatorOperator::Less
                    } else {
                        ComparatorOperator::GreaterEqual
                    },
                    version
                        .increment(VersionField::Minor)?
                        .with_zero_prerelease(),
                )
            } else {
                (
                    if operator == Some("<=") {
                        ComparatorOperator::LessEqual
                    } else {
                        ComparatorOperator::Greater
                    },
                    version,
                )
            };
            comparators.push(Comparator {
                operator,
                operand: version,
            });
        }
        Some("=") | None => {
            if partial.minor_wildcard || partial.patch_wildcard {
                comparators.push(Comparator {
                    operator: ComparatorOperator::GreaterEqual,
                    operand: version.clone().with_zero_prerelease(),
                });
                comparators.push(Comparator {
                    operator: ComparatorOperator::Less,
                    operand: version
                        .increment(if partial.minor_wildcard {
                            VersionField::Major
                        } else {
                            VersionField::Minor
                        })?
                        .with_zero_prerelease(),
                });
            } else {
                comparators.push(Comparator {
                    operator: ComparatorOperator::Equal,
                    operand: version,
                });
            }
        }
        Some(_) => return Err(RangeParseError::Invalid),
    }
    Ok(())
}

fn parse_partial(text: &str) -> Result<PartialVersion, RangeParseError> {
    let mut plus_parts = text.split('+');
    let version_and_prerelease = plus_parts.next().unwrap_or_default();
    let build = plus_parts.next();
    if plus_parts.next().is_some() || build.is_some_and(|build| !valid_build(build)) {
        return Err(RangeParseError::Invalid);
    }

    let (version_text, prerelease) = version_and_prerelease
        .split_once('-')
        .map_or((version_and_prerelease, None), |(version, prerelease)| {
            (version, Some(prerelease))
        });
    let components: Vec<_> = version_text.split('.').collect();
    if components.is_empty()
        || components.len() > 3
        || components.iter().any(|component| component.is_empty())
        || ((prerelease.is_some() || build.is_some()) && components.len() != 3)
        || prerelease.is_some_and(|prerelease| !valid_prerelease(prerelease))
    {
        return Err(RangeParseError::Invalid);
    }

    let major = parse_partial_component(components[0])?;
    let minor = components
        .get(1)
        .map_or(Ok(None), |component| parse_partial_component(component))?;
    let patch = components
        .get(2)
        .map_or(Ok(None), |component| parse_partial_component(component))?;
    let major_wildcard = major.is_none();
    let minor_wildcard = major_wildcard || minor.is_none();
    let patch_wildcard = minor_wildcard || patch.is_none();
    Ok(PartialVersion {
        version: Version {
            major: major.unwrap_or(0),
            minor: if major_wildcard {
                0
            } else {
                minor.unwrap_or(0)
            },
            patch: if minor_wildcard {
                0
            } else {
                patch.unwrap_or(0)
            },
            prerelease: prerelease
                .map(|value| value.split('.').map(str::to_owned).collect())
                .unwrap_or_default(),
        },
        major_wildcard,
        minor_wildcard,
        patch_wildcard,
    })
}

fn parse_partial_component(component: &str) -> Result<Option<u64>, RangeParseError> {
    if matches!(component, "*" | "x" | "X") {
        return Ok(None);
    }
    if !component.bytes().all(|byte| byte.is_ascii_digit())
        || (component.len() > 1 && component.starts_with('0'))
    {
        return Err(RangeParseError::Invalid);
    }
    component
        .parse()
        .map(Some)
        .map_err(|_| RangeParseError::Unsupported)
}

fn valid_prerelease(prerelease: &str) -> bool {
    !prerelease.is_empty()
        && prerelease.split('.').all(|part| {
            let all_digits = part.bytes().all(|byte| byte.is_ascii_digit());
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && if all_digits {
                    part == "0" || !part.starts_with('0')
                } else {
                    part.as_bytes()
                        .first()
                        .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'-')
                }
        })
}

fn valid_build(build: &str) -> bool {
    !build.is_empty()
        && build.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn resolve_types_versions(
    resolver: &EngineResolver,
    importing_file: &Path,
    specifier: &str,
    manifest_path: &Path,
    overlays: &FxHashMap<PathBuf, String>,
) -> Result<Option<PathBuf>, String> {
    let manifest = read_ordered_json(
        manifest_path,
        overlays.get(manifest_path).map(String::as_str),
    )?;
    let Some(paths) = selected_types_versions_paths(&manifest)? else {
        return Ok(None);
    };
    let package_root = manifest_path
        .parent()
        .ok_or_else(|| format!("package manifest {} has no parent", manifest_path.display()))?;
    let module_name = types_versions_module_name(&manifest, specifier)?;
    let Some((targets, matched_text)) = best_types_versions_mapping(paths, &module_name)? else {
        return Ok(None);
    };

    for target in targets {
        let rewritten = if matched_text.is_empty() {
            target.to_owned()
        } else {
            target.replacen('*', &matched_text, 1)
        };
        let candidate = node_join(package_root, &rewritten.replace('\\', "/"));
        if let Ok(resolution) =
            resolver.resolve_file(importing_file, candidate.to_string_lossy().as_ref())
        {
            return Ok(Some(resolution.into_path_buf()));
        }
    }
    Ok(None)
}

fn read_ordered_json(path: &Path, overlay: Option<&str>) -> Result<OrderedJson, String> {
    let raw = overlay
        .map(str::to_owned)
        .map_or_else(|| fs::read_to_string(path), Ok)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("could not parse {}: {error}", path.display()))
}

fn selected_types_versions_paths(
    manifest: &OrderedJson,
) -> Result<Option<&[(String, OrderedJson)]>, String> {
    let types_versions = match object_get(manifest, "typesVersions") {
        Some(OrderedJson::Object(types_versions)) => types_versions,
        Some(OrderedJson::Array(_)) => {
            return Err(
                "array-valued typesVersions is outside Sheriff's supported shape".to_owned(),
            );
        }
        _ => return Ok(None),
    };
    for (index, (range_text, _)) in types_versions.iter().enumerate() {
        if types_versions[..index]
            .iter()
            .any(|(earlier, _)| earlier == range_text)
        {
            continue;
        }
        let range = match VersionRange::try_parse(range_text) {
            Ok(Some(range)) => range,
            Ok(None) | Err(RangeParseError::Invalid) => continue,
            Err(RangeParseError::Unsupported) => {
                return Err(format!(
                    "typesVersions range {range_text:?} is outside Sheriff's supported range grammar"
                ));
            }
        };
        if range.test(&TYPESCRIPT_VERSION) {
            return match object_get_last(types_versions, range_text) {
                Some(OrderedJson::Object(paths)) => Ok(Some(paths)),
                Some(OrderedJson::Array(_) | OrderedJson::Null) => Err(format!(
                    "typesVersions range {range_text:?} has an unsupported path-table shape"
                )),
                _ => Ok(None),
            };
        }
    }
    Ok(None)
}

fn types_versions_module_name(manifest: &OrderedJson, specifier: &str) -> Result<String, String> {
    let package_name = extract_package_name(specifier);
    if let Some(rest) = specifier.strip_prefix(&format!("{package_name}/")) {
        return Ok(rest.to_owned());
    }
    let entry = ["typings", "types", "main"]
        .into_iter()
        .find_map(|field| match object_get(manifest, field) {
            Some(OrderedJson::String(value)) if !value.is_empty() => Some(value.as_str()),
            _ => None,
        })
        .unwrap_or("index");
    if is_rooted_typescript_path(entry) {
        return Err(format!(
            "rooted package entry {entry:?} is outside Sheriff's typesVersions support"
        ));
    }
    Ok(entry.trim_start_matches("./").replace('\\', "/"))
}

fn best_types_versions_mapping<'a>(
    paths: &'a [(String, OrderedJson)],
    module_name: &str,
) -> Result<Option<(Vec<&'a str>, String)>, String> {
    let mut best_pattern: Option<(&str, &str, &str)> = None;
    for (index, (key, _)) in paths.iter().enumerate() {
        if paths[..index].iter().any(|(earlier, _)| earlier == key) {
            continue;
        }
        let star_count = key.bytes().filter(|byte| *byte == b'*').count();
        if star_count == 0 && key == module_name {
            return mapping_targets(paths, key).map(|targets| Some((targets, String::new())));
        }
        if star_count != 1 {
            continue;
        }
        let (prefix, suffix) = key.split_once('*').expect("one star was counted");
        if module_name.len() >= prefix.len() + suffix.len()
            && module_name.starts_with(prefix)
            && module_name.ends_with(suffix)
            && best_pattern.is_none_or(|(best_prefix, _, _)| prefix.len() > best_prefix.len())
        {
            best_pattern = Some((prefix, suffix, key));
        }
    }
    let Some((prefix, suffix, key)) = best_pattern else {
        return Ok(None);
    };
    let matched = module_name[prefix.len()..module_name.len() - suffix.len()].to_owned();
    mapping_targets(paths, key).map(|targets| Some((targets, matched)))
}

fn mapping_targets<'a>(
    paths: &'a [(String, OrderedJson)],
    key: &str,
) -> Result<Vec<&'a str>, String> {
    match object_get_last(paths, key) {
        Some(OrderedJson::Array(targets)) => targets
            .iter()
            .map(|target| match target {
                OrderedJson::String(target) if !is_rooted_typescript_path(target) => {
                    Ok(target.as_str())
                }
                OrderedJson::String(target) => Err(format!(
                    "typesVersions path pattern {key:?} has unsupported rooted target {target:?}"
                )),
                _ => Err(format!(
                    "typesVersions path pattern {key:?} contains a non-string target"
                )),
            })
            .collect(),
        _ => Err(format!(
            "typesVersions path pattern {key:?} does not map to a string array"
        )),
    }
}

fn is_rooted_typescript_path(path: &str) -> bool {
    path.starts_with(['/', '\\']) || path.as_bytes().get(1) == Some(&b':') || path.contains("://")
}

fn object_get<'a>(value: &'a OrderedJson, key: &str) -> Option<&'a OrderedJson> {
    let OrderedJson::Object(entries) = value else {
        return None;
    };
    object_get_last(entries, key)
}

fn object_get_last<'a>(entries: &'a [(String, OrderedJson)], key: &str) -> Option<&'a OrderedJson> {
    entries
        .iter()
        .rev()
        .find_map(|(entry_key, value)| (entry_key == key).then_some(value))
}

fn types_versions_fallback_reasons(
    reached_packages: &HashSet<ReachedPackage>,
    root_dir: &Path,
    overlays: &FxHashMap<PathBuf, String>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    let mut packages: Vec<_> = reached_packages
        .iter()
        .filter_map(|package| {
            package
                .manifest_path
                .as_ref()
                .map(|manifest_path| (&package.name, manifest_path))
        })
        .collect();
    packages.sort_by(|left, right| left.1.cmp(right.1).then_with(|| left.0.cmp(right.0)));

    for (package, manifest_path) in packages {
        let support_error = read_ordered_json(
            manifest_path,
            overlays.get(manifest_path).map(String::as_str),
        )
        .and_then(|manifest| {
            selected_types_versions_paths(&manifest).and_then(|selected| {
                if let Some(paths) = selected {
                    types_versions_module_name(&manifest, package)
                        .and_then(|_| validate_types_versions_paths(paths))
                } else {
                    Ok(())
                }
            })
        });
        if let Err(reason) = support_error {
            reasons.push(format!(
                "package {package} has unsupported typesVersions: {reason} ({})",
                relative_for_oracle(root_dir, manifest_path)
            ));
        }
    }
    reasons
}

fn validate_types_versions_paths(paths: &[(String, OrderedJson)]) -> Result<(), String> {
    for (index, (key, _)) in paths.iter().enumerate() {
        if paths[..index].iter().any(|(earlier, _)| earlier == key)
            || key.bytes().filter(|byte| *byte == b'*').count() > 1
        {
            continue;
        }
        mapping_targets(paths, key)?;
    }
    Ok(())
}

fn reached_package_from_path(resolved: &Path) -> Option<ReachedPackage> {
    for ancestor in resolved.ancestors() {
        let parent = ancestor.parent()?;
        let (package_root, name) = if parent
            .file_name()
            .is_some_and(|name| name == "node_modules")
        {
            (
                ancestor,
                ancestor.file_name()?.to_string_lossy().into_owned(),
            )
        } else if parent
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "node_modules")
            && parent
                .file_name()
                .is_some_and(|scope| scope.to_string_lossy().starts_with('@'))
        {
            (
                ancestor,
                format!(
                    "{}/{}",
                    parent.file_name()?.to_string_lossy(),
                    ancestor.file_name()?.to_string_lossy()
                ),
            )
        } else {
            continue;
        };
        let manifest_path = package_root.join("package.json");
        if manifest_path.is_file() {
            return Some(ReachedPackage {
                name,
                manifest_path: Some(manifest_path),
            });
        }
    }
    None
}

fn find_installed_package_manifest(
    importing_dir: &Path,
    package: &str,
    overlays: &FxHashMap<PathBuf, String>,
) -> Option<PathBuf> {
    let mut current = importing_dir;
    loop {
        let manifest = current
            .join("node_modules")
            .join(package)
            .join("package.json");
        if manifest.is_file() || overlays.contains_key(&manifest) {
            return Some(manifest);
        }
        current = current.parent()?;
    }
}

fn parse_dependency_universe(path: &Path, overlay: Option<&str>) -> HashSet<String> {
    let Ok(raw) = overlay
        .map(str::to_owned)
        .map_or_else(|| fs::read_to_string(path), Ok)
    else {
        return HashSet::new();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
        return HashSet::new();
    };
    ["dependencies", "peerDependencies", "optionalDependencies"]
        .into_iter()
        .filter_map(|section| manifest.get(section)?.as_object())
        .flat_map(|section| section.keys().cloned())
        .collect()
}

fn extract_package_name(specifier: &str) -> String {
    let mut segments = specifier.split('/');
    let first = segments.next().unwrap_or_default();
    if first.starts_with('@') {
        segments
            .next()
            .map_or_else(|| first.to_owned(), |second| format!("{first}/{second}"))
    } else {
        first.to_owned()
    }
}

fn is_relative_import(specifier: &str) -> bool {
    specifier.starts_with('.')
}

fn is_node_modules_path(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::Normal(value) if value == "node_modules"))
}

fn node_join(base: &Path, addition: &str) -> PathBuf {
    // Node's path.join does not reset on an absolute later component.
    let addition = addition.trim_start_matches(['/', '\\']);
    normalize_lexically(&base.join(addition))
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn parent(path: &Path) -> Result<PathBuf, String> {
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("{} has no parent directory", path.display()))
}

fn relative_for_oracle(root_dir: &Path, path: &Path) -> String {
    let root_components: Vec<_> = root_dir.components().collect();
    let path_components: Vec<_> = path.components().collect();
    let shared = root_components
        .iter()
        .zip(&path_components)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = PathBuf::new();
    for _ in shared..root_components.len() {
        relative.push("..");
    }
    for component in &path_components[shared..] {
        relative.push(component.as_os_str());
    }
    let value = relative.to_string_lossy().replace('\\', "/");
    if value.is_empty() {
        ".".to_owned()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::{
        ImportKind, MaterializedPath, RangeParseError, ResolveProjectError, ResolveProjectInput,
        TYPESCRIPT_VERSION, VersionRange, checked_import_total, classify, dependency_universe,
        extract_package_name, get_ts_config_context, node_join, resolve_potential_ts_path,
        resolve_project, sanitize_jsonc,
    };
    use crate::input::{MAX_CONFIG_NESTING, MAX_IMPORTS, MAX_STRING_BYTES};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("sheriff-r2-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).unwrap();
            // macOS exposes the temp directory as `/var/...` while its real
            // path is `/private/var/...`; oxc's tsconfig loader canonicalizes
            // it even when ordinary resolver symlinks are disabled.
            Self(fs::canonicalize(path).unwrap())
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, contents).unwrap();
            path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mapping(key: &str, target: PathBuf) -> MaterializedPath {
        MaterializedPath {
            key: key.to_owned(),
            target,
        }
    }

    #[test]
    fn wildcard_matching_uses_starts_with_without_a_separator_boundary() {
        let paths = [mapping("@app/*", PathBuf::from("/project/src/app"))];
        let result = resolve_potential_ts_path("@apples/fruit", &paths, |rewritten| {
            Some(PathBuf::from(rewritten))
        });
        assert_eq!(result, Some(PathBuf::from("/project/src/apples/fruit")));
    }

    #[test]
    fn wildcard_substitution_uses_first_occurrence_replace() {
        let paths = [mapping("/*", PathBuf::from("/project/src"))];
        let result = resolve_potential_ts_path("anything", &paths, |rewritten| {
            Some(PathBuf::from(rewritten))
        });
        assert_eq!(result, Some(PathBuf::from("/project/srcanything")));
    }

    #[test]
    fn non_wildcard_mapping_requires_exact_match() {
        let paths = [mapping("@app", PathBuf::from("/project/src/app"))];
        assert!(resolve_potential_ts_path("@app/child", &paths, |_| None).is_none());
    }

    #[test]
    fn stale_unpathed_import_is_retried_for_later_non_matching_keys() {
        let paths = [
            mapping("@app/*", PathBuf::from("/missing/app")),
            mapping("@other/*", PathBuf::from("/missing/other")),
        ];
        let mut attempts = Vec::new();
        let result = resolve_potential_ts_path("@app/file", &paths, |rewritten| {
            attempts.push(rewritten.to_owned());
            None
        });
        assert!(result.is_none());
        assert_eq!(attempts, ["/missing/app/file", "/missing/app/file"]);
    }

    #[test]
    fn exact_file_mapping_is_returned_without_resolver() {
        let temp = TestDir::new();
        let target = temp.write("src/index.ts", "");
        let paths = [mapping("@app", target.clone())];
        let result = resolve_potential_ts_path("@app", &paths, |_| {
            panic!("resolver must not be called for a file mapping")
        });
        assert_eq!(result, Some(target));
    }

    #[test]
    fn tsconfig_walk_keeps_nearest_base_url_and_ancestor_path_collision() {
        let temp = TestDir::new();
        temp.write("parent-target/index.ts", "");
        temp.write("child/child-target/index.ts", "");
        temp.write(
            "base.json",
            r#"{"compilerOptions":{"baseUrl":".","paths":{"@same/*":["parent-target/*"]}}}"#,
        );
        let entry = temp.write(
            "child/tsconfig.json",
            r#"{
                "extends":"../base.json",
                "compilerOptions":{
                    "baseUrl":"child-target",
                    "paths":{"@same/*":["."]}
                }
            }"#,
        );
        let context = get_ts_config_context(&entry).unwrap();
        assert_eq!(context.root_dir, temp.0);
        assert_eq!(context.base_url, Some(temp.0.join("child/child-target")));
        assert_eq!(context.paths[0].target, temp.0.join("parent-target"));
    }

    #[test]
    fn paths_use_only_first_target_and_probe_only_dot_ts() {
        let temp = TestDir::new();
        temp.write("first.ts", "");
        temp.write("fallback.ts", "");
        let config = temp.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"paths":{"@file":["first","fallback"]}}}"#,
        );
        let context = get_ts_config_context(&config).unwrap();
        assert_eq!(context.paths[0].target, temp.0.join("first.ts"));
    }

    #[test]
    fn normal_resolution_keeps_typescript_path_fallback_targets() {
        let temp = TestDir::new();
        fs::create_dir_all(temp.0.join("first")).unwrap();
        temp.write("second/item.ts", "");
        let config = temp.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"paths":{"@app/*":["first/*","second/*"]}}}"#,
        );
        let source = temp.write("main.ts", "import '@app/item';");
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert_eq!(output.files[0].imports[0].kind, ImportKind::Module);
        assert_eq!(
            output.files[0].imports[0].resolved_path.as_deref(),
            Some("second/item.ts")
        );
    }

    #[test]
    fn json_imports_are_not_resolved_even_when_raw_config_enables_them() {
        // Sheriff currently drops parsed compiler options before calling
        // ts.resolveModuleName, so resolveJsonModule never reaches the resolver.
        for compiler_options in [
            "",
            r#""resolveJsonModule":false"#,
            r#""resolveJsonModule":true"#,
        ] {
            let temp = TestDir::new();
            let config = temp.write(
                "tsconfig.json",
                &format!(r#"{{"compilerOptions":{{{compiler_options}}}}}"#),
            );
            temp.write("src/data.json", "{}");
            let source = temp.write("src/main.ts", r#"import "./data.json";"#);
            let output = resolve_project(ResolveProjectInput {
                schema_version: 1,
                ts_config_path: config.to_string_lossy().into_owned(),
                files: vec![source.to_string_lossy().into_owned()],
                ignore_file_extensions: Vec::new(),
                shadow_mode: false,
            })
            .unwrap();

            assert!(!output.fallback);
            assert_eq!(output.files[0].imports[0].kind, ImportKind::Unresolvable);
            assert_eq!(output.files[0].imports[0].resolved_path, None);
        }
    }

    #[test]
    fn json_imports_are_absent_with_sheriffs_default_ignore_filter() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write("src/data.json", "{}");
        let source = temp.write("src/main.ts", r#"import "./data.json";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: vec!["json".to_owned()],
            shadow_mode: false,
        })
        .unwrap();

        assert!(output.files[0].imports.is_empty());
    }

    #[test]
    fn bundler_config_uses_sheriffs_effective_default_exports_conditions() {
        let temp = TestDir::new();
        let config = temp.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"}}"#,
        );
        temp.write(
            "node_modules/cond-pkg/package.json",
            r#"{"name":"cond-pkg","main":"index.js","exports":{".":{"require":"./index.js"}}}"#,
        );
        temp.write("node_modules/cond-pkg/index.js", "");
        temp.write(
            "package.json",
            r#"{"devDependencies":{"cond-pkg":"1.0.0"}}"#,
        );
        let source = temp.write("src/main.ts", r#"import "cond-pkg";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert_eq!(output.files[0].imports[0].kind, ImportKind::External);
    }

    #[test]
    fn wildcard_alias_uses_javascript_replacement_string_semantics() {
        let temp = TestDir::new();
        let config = temp.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"paths":{"@app/*":["literal-$&/*"]}}}"#,
        );
        temp.write("literal-$&/foo.ts", "");
        temp.write("literal-@app/foo.ts", "");
        let source = temp.write("src/main.ts", r#"import "@app/foo";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert_eq!(
            output.files[0].imports[0].resolved_path.as_deref(),
            Some("literal-@app/foo.ts")
        );
    }

    #[test]
    fn surrogate_pair_dynamic_import_matches_the_static_edge() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write("src/😀.ts", "");
        let source = temp.write(
            "src/main.ts",
            r#"import "./\uD83D\uDE00";
               const dynamic = import("./\uD83D\uDE00");"#,
        );
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert_eq!(output.files[0].imports.len(), 2);
        for import in &output.files[0].imports {
            assert_eq!(import.raw, "./😀");
            assert_eq!(import.resolved_path.as_deref(), Some("src/😀.ts"));
        }
    }

    #[test]
    fn unpaired_surrogate_dynamic_import_triggers_project_fallback() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        let source = temp.write("src/main.ts", r#"const dynamic = import("./\uD83D");"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(output.fallback);
        assert!(output.files.is_empty());
        assert_eq!(
            output.fallback_reasons,
            [
                "dynamic import contains an unpaired UTF-16 surrogate, which requires TypeScript (src/main.ts)"
            ]
        );
    }

    #[test]
    fn unsupported_options_in_parent_configs_trigger_project_fallback() {
        let temp = TestDir::new();
        temp.write(
            "base.json",
            r#"{"compilerOptions":{"moduleSuffixes":[".native",""]}}"#,
        );
        let config = temp.write("child/tsconfig.json", r#"{"extends":"../base.json"}"#);
        let context = get_ts_config_context(&config).unwrap();
        assert_eq!(context.fallback_reasons.len(), 1);
        assert!(context.fallback_reasons[0].contains("moduleSuffixes"));
    }

    #[test]
    fn unsupported_option_values_trigger_project_fallback_before_file_reads() {
        let temp = TestDir::new();
        let config = temp.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"moduleResolution":"nodenext"}}"#,
        );
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![
                temp.0
                    .join("does-not-exist.ts")
                    .to_string_lossy()
                    .into_owned(),
            ],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(output.fallback);
        assert!(output.files.is_empty());
        assert!(output.fallback_reasons[0].contains("nodenext"));
    }

    #[test]
    fn unimported_dependency_types_versions_do_not_trigger_project_fallback() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write(
            "package.json",
            r#"{"dependencies":{"typed-package":"1.0.0"}}"#,
        );
        temp.write(
            "node_modules/typed-package/package.json",
            r#"{"typesVersions":{"*":{"*":["types/*"]}}}"#,
        );
        let source = temp.write("src/main.ts", "export const value = 1;");
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert!(output.fallback_reasons.is_empty());
        assert_eq!(output.files.len(), 1);
    }

    #[test]
    fn imported_dependency_with_supported_types_versions_does_not_fall_back() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write(
            "package.json",
            r#"{"dependencies":{"typed-package":"1.0.0"}}"#,
        );
        temp.write(
            "node_modules/typed-package/package.json",
            r#"{"typesVersions":{"*":{"*":["types/*"]}}}"#,
        );
        let source = temp.write("src/main.ts", "import 'typed-package';");
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert!(output.fallback_reasons.is_empty());
        assert_eq!(output.files.len(), 1);

        let shadow_output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: true,
        })
        .unwrap();
        assert!(!shadow_output.fallback);
        assert_eq!(shadow_output.files.len(), 1);
    }

    #[test]
    fn installed_dev_dependency_types_versions_are_mapped() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write("package.json", r#"{"devDependencies":{"tv-pkg":"1.0.0"}}"#);
        temp.write(
            "node_modules/tv-pkg/package.json",
            r#"{"typesVersions":{"*":{"*":["types/*"]}}}"#,
        );
        temp.write("node_modules/tv-pkg/types/foo.d.ts", "");
        let source = temp.write("src/main.ts", r#"import "tv-pkg/foo";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert!(output.fallback_reasons.is_empty());
        assert_eq!(output.files.len(), 1);
        assert_eq!(output.files[0].imports[0].kind, ImportKind::External);
    }

    #[test]
    fn scoped_subpath_import_maps_types_versions() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write("package.json", r#"{"dependencies":{"@scope/pkg":"1.0.0"}}"#);
        temp.write(
            "node_modules/@scope/pkg/package.json",
            r#"{"typesVersions":{"*":{"*":["types/*"]}}}"#,
        );
        temp.write("node_modules/@scope/pkg/types/sub.d.ts", "");
        let source = temp.write("src/main.ts", r#"import "@scope/pkg/sub";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert!(output.fallback_reasons.is_empty());
        assert_eq!(output.files[0].imports[0].kind, ImportKind::External);
    }

    #[test]
    fn paths_alias_into_node_modules_maps_reached_package_types_versions() {
        let temp = TestDir::new();
        let config = temp.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"baseUrl":".","paths":{"alias":["node_modules/tv-pkg"]}}}"#,
        );
        temp.write(
            "node_modules/tv-pkg/package.json",
            r#"{"name":"tv-pkg","types":"index.d.ts","typesVersions":{"*":{"*":["modern/*"]}}}"#,
        );
        temp.write("node_modules/tv-pkg/index.d.ts", "");
        temp.write("node_modules/tv-pkg/modern/index.d.ts", "");
        let source = temp.write("src/main.ts", r#"import "alias";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert_eq!(output.files.len(), 1);
        assert_eq!(output.files[0].imports[0].kind, ImportKind::Module);
        assert_eq!(
            output.files[0].imports[0].resolved_path.as_deref(),
            Some("node_modules/tv-pkg/modern/index.d.ts")
        );
    }

    #[test]
    fn unresolved_paths_alias_uses_reached_package_types_versions() {
        let temp = TestDir::new();
        let config = temp.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"baseUrl":".","paths":{"alias":["node_modules/tv-pkg"]}}}"#,
        );
        temp.write(
            "node_modules/tv-pkg/package.json",
            r#"{"name":"tv-pkg","typesVersions":{"*":{"*":["modern/*"]}}}"#,
        );
        temp.write("node_modules/tv-pkg/modern/index.d.ts", "");
        let source = temp.write("src/main.ts", r#"import "alias";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert_eq!(output.files.len(), 1);
        assert_eq!(output.files[0].imports[0].kind, ImportKind::Module);
        assert_eq!(
            output.files[0].imports[0].resolved_path.as_deref(),
            Some("node_modules/tv-pkg/modern/index.d.ts")
        );
    }

    #[test]
    fn nested_node_modules_alias_audits_the_innermost_package() {
        let temp = TestDir::new();
        let config = temp.write(
            "tsconfig.json",
            r#"{"compilerOptions":{"baseUrl":".","paths":{"outer/node_modules/inner":["node_modules/outer/node_modules/inner"]}}}"#,
        );
        temp.write("node_modules/outer/package.json", r#"{"name":"outer"}"#);
        temp.write(
            "node_modules/outer/node_modules/inner/package.json",
            r#"{"name":"inner","types":"index.d.ts","typesVersions":{"*":{"*":["modern/*"]}}}"#,
        );
        temp.write("node_modules/outer/node_modules/inner/index.d.ts", "");
        temp.write(
            "node_modules/outer/node_modules/inner/modern/index.d.ts",
            "",
        );
        let source = temp.write("src/main.ts", r#"import "outer/node_modules/inner";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(!output.fallback);
        assert_eq!(output.files.len(), 1);
        assert_eq!(output.files[0].imports[0].kind, ImportKind::Module);
        assert_eq!(
            output.files[0].imports[0].resolved_path.as_deref(),
            Some("node_modules/outer/node_modules/inner/modern/index.d.ts")
        );
    }

    #[test]
    fn unsupported_types_versions_target_shape_preserves_project_fallback() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write("package.json", r#"{"dependencies":{"bad-tv":"1.0.0"}}"#);
        temp.write(
            "node_modules/bad-tv/package.json",
            r#"{"typesVersions":{"*":{"*":"types/*"}}}"#,
        );
        let source = temp.write("src/main.ts", r#"import "bad-tv";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(output.fallback);
        assert!(output.files.is_empty());
        assert_eq!(output.fallback_reasons.len(), 1);
        assert!(
            output.fallback_reasons[0]
                .contains("path pattern \"*\" does not map to a string array")
        );
    }

    #[test]
    fn unsupported_range_numbers_preserve_project_fallback() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write("package.json", r#"{"dependencies":{"huge-tv":"1.0.0"}}"#);
        temp.write(
            "node_modules/huge-tv/package.json",
            r#"{"typesVersions":{"18446744073709551616":{"*":["wrong/*"]},"*":{"*":["types/*"]}}}"#,
        );
        let source = temp.write("src/main.ts", r#"import "huge-tv";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert!(output.fallback);
        assert!(output.fallback_reasons[0].contains("outside Sheriff's supported range grammar"));
    }

    #[test]
    fn version_range_parser_covers_typescript_grammar() {
        for range in [
            "*",
            ">=4.2",
            ">5.8 <=5.9.3",
            "4.0 - 5.9.3",
            "~5.9.0",
            "^5.0.0",
            "1.x || 5.9.x",
            "5.9.3+ignored-build",
        ] {
            assert!(
                VersionRange::try_parse(range)
                    .unwrap()
                    .unwrap()
                    .test(&TYPESCRIPT_VERSION),
                "{range} should match"
            );
        }

        for range in ["<4", ">5.9.3", "^0.5", "4.x"] {
            assert!(
                !VersionRange::try_parse(range)
                    .unwrap()
                    .unwrap()
                    .test(&TYPESCRIPT_VERSION),
                "{range} should not match"
            );
        }
        assert!(matches!(
            VersionRange::try_parse("not a range"),
            Err(RangeParseError::Invalid)
        ));
    }

    #[test]
    fn incomplete_scoped_dependency_name_matches_typescript() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        temp.write("package.json", r#"{"dependencies":{"@scope":"1.0.0"}}"#);
        let source = temp.write("src/main.ts", r#"import "@scope";"#);
        let output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap();

        assert_eq!(extract_package_name("@scope"), "@scope");
        assert_eq!(output.files[0].imports[0].kind, ImportKind::External);
    }

    #[test]
    fn disk_source_size_limit_is_enforced() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", "{}");
        let source = temp.write("src/main.ts", &" ".repeat(MAX_STRING_BYTES + 1));
        let error = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: false,
        })
        .unwrap_err();

        assert!(matches!(error, ResolveProjectError::LimitExceeded(_)));
        assert!(error.to_string().contains("source file src/main.ts"));
    }

    #[test]
    fn import_count_limit_is_enforced() {
        assert_eq!(
            checked_import_total(MAX_IMPORTS - 1, 1).unwrap(),
            MAX_IMPORTS
        );
        assert!(matches!(
            checked_import_total(MAX_IMPORTS, 1),
            Err(ResolveProjectError::LimitExceeded(_))
        ));
    }

    #[test]
    fn acyclic_tsconfig_chain_depth_limit_is_enforced() {
        let temp = TestDir::new();
        for index in 0..=MAX_CONFIG_NESTING {
            let contents = if index == MAX_CONFIG_NESTING {
                "{}".to_owned()
            } else {
                format!(r#"{{"extends":"./config-{}.json"}}"#, index + 1)
            };
            temp.write(&format!("config-{index}.json"), &contents);
        }
        let error = get_ts_config_context(&temp.0.join("config-0.json")).unwrap_err();
        assert!(matches!(error, ResolveProjectError::LimitExceeded(_)));
        assert!(error.to_string().contains("tsconfig extends chain"));
    }

    fn assert_cyclic_tsconfig_error(config: &Path, offending: &Path, cycle: &[&Path]) {
        let error = get_ts_config_context(config).unwrap_err();
        let expected_cycle = cycle
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(" -> ");
        assert_eq!(
            error,
            ResolveProjectError::CyclicTsConfigExtends(format!(
                "Cyclic \"extends\" detected in {}: {expected_cycle}. Please remove the cycle.",
                offending.display()
            ))
        );
    }

    #[test]
    fn two_config_tsconfig_cycle_is_a_structured_error() {
        let temp = TestDir::new();
        let a = temp.write("a.json", r#"{"extends":"./b.json"}"#);
        let b = temp.write("b.json", r#"{"extends":"./a.json"}"#);

        assert_cyclic_tsconfig_error(&a, &b, &[&a, &b, &a]);
    }

    #[test]
    fn self_extending_tsconfig_is_a_structured_error() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", r#"{"extends":"./tsconfig.json"}"#);

        assert_cyclic_tsconfig_error(&config, &config, &[&config, &config]);
    }

    #[test]
    fn three_config_tsconfig_cycle_is_a_structured_error() {
        let temp = TestDir::new();
        let a = temp.write("a.json", r#"{"extends":"./b.json"}"#);
        let b = temp.write("b.json", r#"{"extends":"./c.json"}"#);
        let c = temp.write("c.json", r#"{"extends":"./a.json"}"#);

        assert_cyclic_tsconfig_error(&a, &c, &[&a, &b, &c, &a]);
    }

    #[test]
    fn deep_acyclic_tsconfig_chain_resolves() {
        let temp = TestDir::new();
        let chain_length = 32;
        for index in 0..chain_length {
            let contents = if index == chain_length - 1 {
                "{}".to_owned()
            } else {
                format!(r#"{{"extends":"./config-{}.json"}}"#, index + 1)
            };
            temp.write(&format!("config-{index}.json"), &contents);
        }

        let context = get_ts_config_context(&temp.0.join("config-0.json")).unwrap();
        assert_eq!(context.source_config_paths.len(), chain_length);
        assert_eq!(context.root_dir, temp.0);
    }

    #[test]
    fn arrays_in_extends_are_rejected_like_sheriffs_string_only_walk() {
        let temp = TestDir::new();
        let config = temp.write("tsconfig.json", r#"{"extends":["./base.json"]}"#);
        assert!(
            get_ts_config_context(&config)
                .unwrap_err()
                .to_string()
                .contains("unsupported non-string extends")
        );
    }

    #[test]
    fn jsonc_sanitizer_supports_comments_and_trailing_commas() {
        let source = r#"{
            // line
            "compilerOptions": { /* block */ "strict": true, },
        }"#;
        let value: serde_json::Value = serde_json::from_str(&sanitize_jsonc(source)).unwrap();
        assert_eq!(value["compilerOptions"]["strict"], true);
    }

    #[test]
    fn classifies_alias_as_module_without_root_or_external_checks() {
        let universe = HashSet::new();
        let result = classify(
            "pkg",
            Some(PathBuf::from("/elsewhere/node_modules/pkg/index.js")),
            None,
            Path::new("/project"),
            &universe,
        )
        .unwrap();
        assert_eq!(result.0, ImportKind::Module);
    }

    #[test]
    fn classifies_normal_modules_externals_and_declared_unresolved_dependencies() {
        let universe = HashSet::from(["pkg".to_owned()]);
        assert_eq!(
            classify(
                "./local",
                None,
                Some(PathBuf::from("/project/src/local.ts")),
                Path::new("/project"),
                &universe,
            )
            .unwrap()
            .0,
            ImportKind::Module
        );
        assert_eq!(
            classify(
                "pkg",
                None,
                Some(PathBuf::from("/project/node_modules/pkg/index.js")),
                Path::new("/project"),
                &universe,
            )
            .unwrap()
            .0,
            ImportKind::External
        );
        assert_eq!(
            classify("pkg/subpath", None, None, Path::new("/project"), &universe)
                .unwrap()
                .0,
            ImportKind::External
        );
        assert_eq!(
            classify("missing", None, None, Path::new("/project"), &universe)
                .unwrap()
                .0,
            ImportKind::Unresolvable
        );
    }

    #[test]
    fn normal_module_root_check_is_plain_string_prefix() {
        let result = classify(
            "./sibling",
            None,
            Some(PathBuf::from("/project-other/file.ts")),
            Path::new("/project"),
            &HashSet::new(),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn normal_module_outside_the_plain_root_prefix_throws() {
        let result = classify(
            "./outside",
            None,
            Some(PathBuf::from("/elsewhere/file.ts")),
            Path::new("/project"),
            &HashSet::new(),
        );
        assert_eq!(
            result.unwrap_err(),
            "/elsewhere/file.ts is outside of root /project"
        );
    }

    #[test]
    fn oracle_paths_are_relative_even_for_bug_compatible_outside_aliases() {
        assert_eq!(
            super::relative_for_oracle(
                Path::new("/project/root"),
                Path::new("/project/other/file.ts")
            ),
            "../other/file.ts"
        );
    }

    #[test]
    fn dependency_universe_excludes_dev_dependencies_and_handles_scopes() {
        let temp = TestDir::new();
        temp.write(
            "package.json",
            r#"{
                "dependencies":{"runtime":"1"},
                "peerDependencies":{"peer":"1"},
                "optionalDependencies":{"optional":"1"},
                "devDependencies":{"development":"1"}
            }"#,
        );
        fs::create_dir_all(temp.0.join("src/nested")).unwrap();
        let universe = dependency_universe(
            &temp.0.join("src/nested"),
            &temp.0,
            &rustc_hash::FxHashMap::default(),
        );
        assert_eq!(
            universe,
            HashSet::from([
                "runtime".to_owned(),
                "peer".to_owned(),
                "optional".to_owned()
            ])
        );
        assert_eq!(extract_package_name("@scope/name/subpath"), "@scope/name");
        assert_eq!(extract_package_name("plain/subpath"), "plain");
    }

    #[test]
    fn node_join_matches_node_absolute_component_quirk() {
        assert_eq!(
            node_join(Path::new("/project"), "/src/app"),
            PathBuf::from("/project/src/app")
        );
    }
}
