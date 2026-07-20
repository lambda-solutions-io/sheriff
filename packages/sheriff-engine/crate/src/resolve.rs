use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use oxc_resolver::{
    ResolveOptions, Resolver, TsconfigDiscovery, TsconfigOptions, TsconfigReferences,
};
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

const EXPLICITLY_UNSUPPORTED_COMPILER_OPTIONS: &[&str] = &[
    "allowImportingTsExtensions",
    "customConditions",
    "moduleSuffixes",
    "rootDirs",
];

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
    );
    let ignored: HashSet<String> = input
        .ignore_file_extensions
        .into_iter()
        .map(|extension| extension.to_lowercase())
        .collect();
    let mut files = Vec::with_capacity(input.files.len());
    let mut import_count = 0;
    let mut reached_packages = HashSet::new();

    if !initial_fallback || input.shadow_mode {
        for file in input.files {
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
                    break;
                }
            }
            let imports = resolve_imports(
                &path,
                extracted.imports,
                &ignored,
                &context,
                &resolver,
                &mut reached_packages,
            )?;
            files.push(ResolvedFile {
                file: relative_for_oracle(&context.root_dir, &path),
                imports,
            });
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
        ));
    context.fallback_reasons.sort();
    context.fallback_reasons.dedup();
    let fallback = !context.fallback_reasons.is_empty();
    if fallback && !input.shadow_mode {
        files.clear();
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
    let mut current_path = ts_config_path.to_path_buf();
    let mut current_dir = parent(&current_path)?;
    let mut paths: Vec<MaterializedPath> = Vec::new();
    let mut base_url = None;
    let mut module_resolution = None;
    let mut source_config_paths = Vec::new();
    let mut fallback_reasons = Vec::new();
    let mut unique_config_paths = HashSet::new();
    let resolver = create_resolver(None, None);

    loop {
        unique_config_paths.insert(current_path.clone());
        if unique_config_paths.len() > MAX_CONFIG_NESTING {
            return Err(ResolveProjectError::LimitExceeded(format!(
                "tsconfig extends chain exceeds the {MAX_CONFIG_NESTING} level limit"
            )));
        }
        source_config_paths.push(current_path.clone());
        let config = read_ts_config(&current_path)?;

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

fn read_ts_config(path: &Path) -> Result<RawTsConfig, ResolveProjectError> {
    let raw = fs::read_to_string(path).map_err(|error| {
        ResolveProjectError::Resolution(format!("could not read {}: {error}", path.display()))
    })?;
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

fn create_resolver(ts_config_path: Option<&Path>, _module_resolution: Option<&str>) -> Resolver {
    Resolver::new(ResolveOptions {
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
    })
}

fn resolve_imports(
    importing_file: &Path,
    extracted: Vec<ExtractedImport>,
    ignored: &HashSet<String>,
    context: &TsConfigContext,
    resolver: &Resolver,
    reached_packages: &mut HashSet<ReachedPackage>,
) -> Result<Vec<ResolvedImport>, String> {
    let importing_dir = parent(importing_file)?;
    let universe = dependency_universe(&importing_dir, &context.root_dir);
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

        // Sheriff computes normal resolution eagerly even though alias resolution
        // has priority over it.
        let normal = normal_resolve(resolver, importing_file, &import.raw, context);
        let normal_is_none = normal.is_none();
        let resolved_package_manifest = normal
            .as_deref()
            .filter(|path| is_node_modules_path(path))
            .and_then(|path| package_manifest_from_resolved_path(path, &import.raw));
        let alias = resolve_potential_ts_path(&import.raw, &context.paths, |rewritten| {
            resolver
                .resolve_file(importing_file, rewritten)
                .ok()
                .map(|resolution| resolution.into_path_buf())
        });
        let alias_is_none = alias.is_none();

        let (kind, resolved) = classify(&import.raw, alias, normal, &context.root_dir, &universe)?;
        let is_bare_import =
            !is_relative_import(&import.raw) && !Path::new(&import.raw).is_absolute();
        let package_manifest = resolved_package_manifest.or_else(|| {
            // typesVersions can make oxc fail before it returns a resolved path.
            // An installed bare package still counts as reached in that case.
            (is_bare_import && (kind == ImportKind::External || (alias_is_none && normal_is_none)))
                .then(|| {
                    find_installed_package_manifest(
                        &importing_dir,
                        &extract_package_name(&import.raw),
                    )
                })
                .flatten()
        });
        if kind == ImportKind::External || package_manifest.is_some() {
            let package = extract_package_name(&import.raw);
            reached_packages.insert(ReachedPackage {
                manifest_path: package_manifest,
                name: package,
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

fn normal_resolve(
    resolver: &Resolver,
    importing_file: &Path,
    specifier: &str,
    context: &TsConfigContext,
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

fn dependency_universe(file_dir: &Path, root_dir: &Path) -> HashSet<String> {
    if file_dir.strip_prefix(root_dir).is_err() {
        return HashSet::new();
    }
    let mut current = file_dir.to_path_buf();
    loop {
        let manifest = current.join("package.json");
        if manifest.is_file() {
            return parse_dependency_universe(&manifest);
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

fn types_versions_fallback_reasons(
    reached_packages: &HashSet<ReachedPackage>,
    root_dir: &Path,
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
        if fs::read_to_string(manifest_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .is_some_and(|manifest| manifest.get("typesVersions").is_some())
        {
            reasons.push(format!(
                "package {package} declares unsupported typesVersions ({})",
                relative_for_oracle(root_dir, manifest_path)
            ));
        }
    }
    reasons
}

fn package_manifest_from_resolved_path(resolved: &Path, specifier: &str) -> Option<PathBuf> {
    let package_root_suffix = Path::new("node_modules").join(extract_package_name(specifier));
    for ancestor in resolved.ancestors() {
        if ancestor.ends_with(&package_root_suffix) {
            let manifest = ancestor.join("package.json");
            if manifest.is_file() {
                return Some(manifest);
            }
        }
    }
    None
}

fn find_installed_package_manifest(importing_dir: &Path, package: &str) -> Option<PathBuf> {
    let mut current = importing_dir;
    loop {
        let manifest = current
            .join("node_modules")
            .join(package)
            .join("package.json");
        if manifest.is_file() {
            return Some(manifest);
        }
        current = current.parent()?;
    }
}

fn parse_dependency_universe(path: &Path) -> HashSet<String> {
    let Ok(raw) = fs::read_to_string(path) else {
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
        ImportKind, MaterializedPath, ResolveProjectError, ResolveProjectInput,
        checked_import_total, classify, dependency_universe, extract_package_name,
        get_ts_config_context, node_join, resolve_potential_ts_path, resolve_project,
        sanitize_jsonc,
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
    fn imported_dependency_types_versions_trigger_project_fallback() {
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

        assert!(output.fallback);
        assert!(output.files.is_empty());
        assert_eq!(
            output.fallback_reasons,
            [
                "package typed-package declares unsupported typesVersions (node_modules/typed-package/package.json)"
            ]
        );

        let shadow_output = resolve_project(ResolveProjectInput {
            schema_version: 1,
            ts_config_path: config.to_string_lossy().into_owned(),
            files: vec![source.to_string_lossy().into_owned()],
            ignore_file_extensions: Vec::new(),
            shadow_mode: true,
        })
        .unwrap();
        assert!(shadow_output.fallback);
        assert_eq!(shadow_output.files.len(), 1);
    }

    #[test]
    fn installed_dev_dependency_types_versions_trigger_project_fallback() {
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

        assert!(output.fallback);
        assert!(output.files.is_empty());
        assert_eq!(
            output.fallback_reasons,
            [
                "package tv-pkg declares unsupported typesVersions (node_modules/tv-pkg/package.json)"
            ]
        );
    }

    #[test]
    fn scoped_subpath_import_audits_the_package_manifest() {
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

        assert!(output.fallback);
        assert!(output.files.is_empty());
        assert_eq!(
            output.fallback_reasons,
            [
                "package @scope/pkg declares unsupported typesVersions (node_modules/@scope/pkg/package.json)"
            ]
        );
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
        let universe = dependency_universe(&temp.0.join("src/nested"), &temp.0);
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
