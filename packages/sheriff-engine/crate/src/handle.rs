use std::collections::{HashSet, VecDeque};
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};

use napi_derive::napi;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::engine::{self, AnalyzeResult};
use crate::input::{
    ConfigValue, EncapsulationPattern, EngineInput, ImportKind, InputFile, InputImport,
    InputModulePath, OrderedMap, RuleValue,
};
use crate::paths::{PathId, PathInterner};
use crate::resolve::{
    ImportKind as ResolvedImportKind, ResolutionContextSnapshot, ResolveSession, ResolvedImport,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectHandleInput {
    schema_version: u32,
    entry_file: String,
    ts_config_path: String,
    #[serde(default)]
    ignore_file_extensions: Vec<String>,
    #[serde(default)]
    shadow_mode: bool,
    /// Paths whose evaluated contents produced the Node-supplied Sheriff
    /// configuration. Rust stamps these but cannot re-evaluate executable TS.
    #[serde(default)]
    sheriff_config_paths: Vec<String>,
    #[serde(default)]
    module_config: OrderedMap<ConfigValue>,
    #[serde(default, alias = "barrels")]
    module_paths: Vec<InputModulePath>,
    auto_tagging: bool,
    #[serde(default)]
    dep_rules: OrderedMap<RuleValue>,
    #[serde(default)]
    deny_rules: OrderedMap<RuleValue>,
    #[serde(default)]
    external_rules: OrderedMap<RuleValue>,
    #[serde(default)]
    encapsulation_pattern: Option<EncapsulationPattern>,
    #[serde(default)]
    enable_barrel_less: bool,
    #[serde(default)]
    exclude_root: bool,
    #[serde(default = "default_barrel_file_name")]
    barrel_file_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyChangesInput {
    schema_version: u32,
    #[serde(default)]
    events: Vec<ChangeEvent>,
    #[serde(default)]
    module_paths: Option<Vec<InputModulePath>>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ChangeEvent {
    Created {
        path: String,
    },
    Modified {
        path: String,
    },
    Deleted {
        path: String,
    },
    Renamed {
        #[serde(rename = "oldPath")]
        old_path: String,
        path: String,
    },
    OverlaySet {
        path: String,
        content: String,
    },
    OverlayClear {
        path: String,
    },
    Directory {
        path: String,
    },
    SheriffConfig {
        path: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CallbackResultsInput {
    schema_version: u32,
    results: Value,
}

#[derive(Clone, Debug)]
enum GraphImport {
    Module { raw: String, target: PathId },
    External { raw: String },
    Unresolvable { raw: String },
}

#[derive(Debug)]
enum PendingCallbacks {
    Tags(Vec<String>),
    Rules(Vec<String>),
}

struct CachedMaterialization<T> {
    results: Vec<T>,
    missing_keys: Vec<String>,
    candidates: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DependencyStamp {
    exists: bool,
    length: u64,
    modified_nanos: u128,
    content_hash: Option<u64>,
    symlink_target: Option<PathBuf>,
}

/// Persistent R4 project state. All public methods exchange JSON strings so
/// the existing hostile-input limits and structured-error contract stay at the
/// napi boundary, while the graph itself never crosses that boundary.
#[napi]
pub struct ProjectHandle {
    input: Option<ProjectHandleInput>,
    input_hash: u64,
    root_dir: String,
    entry_file: Option<PathId>,
    interner: PathInterner,
    file_paths: FxHashSet<PathId>,
    module_path_ids: FxHashSet<PathId>,
    forward: FxHashMap<PathId, Vec<GraphImport>>,
    reverse: FxHashMap<PathId, FxHashSet<PathId>>,
    module_assignment: FxHashMap<PathId, PathId>,
    module_tags: FxHashMap<PathId, Vec<String>>,
    resolution_context: Option<ResolutionContextSnapshot>,
    source_config_paths: Vec<PathBuf>,
    package_manifest_paths: Vec<PathBuf>,
    dependency_stamps: FxHashMap<PathBuf, DependencyStamp>,
    overlays: FxHashMap<PathBuf, String>,
    tag_callback_cache: FxHashMap<String, Vec<String>>,
    rule_callback_cache: FxHashMap<String, bool>,
    pending_callbacks: Option<PendingCallbacks>,
    latest_result: String,
}

#[napi]
impl ProjectHandle {
    #[napi(constructor)]
    pub fn new(input_json: String) -> Self {
        let mut handle = Self::empty();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            handle.initialize(&input_json)
        }));
        handle.latest_result = match result {
            Ok(Ok(result)) => result,
            Ok(Err(message)) => crate::error_json("SHERIFF_ENGINE_ERROR", message),
            Err(payload) => {
                crate::error_json("SHERIFF_ENGINE_PANIC", crate::panic_message(payload))
            }
        };
        handle
    }

    #[napi(js_name = "applyChanges")]
    pub fn apply_changes(&mut self, events_json: String) -> String {
        self.guard(|handle| handle.apply_changes_inner(&events_json))
    }

    #[napi(js_name = "provideCallbackResults")]
    pub fn provide_callback_results(&mut self, results_json: String) -> String {
        self.guard(|handle| handle.provide_callback_results_inner(&results_json))
    }

    #[napi(js_name = "setOverlay")]
    pub fn set_overlay(&mut self, path: String, content: String) -> String {
        let input = json!({
            "schemaVersion": 1,
            "events": [{"kind": "overlaySet", "path": path, "content": content}],
        });
        self.apply_changes(input.to_string())
    }

    #[napi(js_name = "clearOverlay")]
    pub fn clear_overlay(&mut self, path: String) -> String {
        let input = json!({
            "schemaVersion": 1,
            "events": [{"kind": "overlayClear", "path": path}],
        });
        self.apply_changes(input.to_string())
    }

    #[napi(js_name = "getResult")]
    pub fn get_result(&self) -> String {
        self.latest_result.clone()
    }

    #[napi(js_name = "getReachedFiles")]
    pub fn get_reached_files(&self) -> String {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut files = self
                .reached_files()
                .into_iter()
                .map(|path| self.interner.text(path).to_owned())
                .collect::<Vec<_>>();
            files.sort();
            serde_json::to_string(&json!({"schemaVersion": 1, "files": files}))
                .map_err(|error| format!("could not serialize reached files: {error}"))
        }));
        match result {
            Ok(Ok(output)) => output,
            Ok(Err(message)) => crate::error_json("SHERIFF_ENGINE_ERROR", message),
            Err(payload) => {
                crate::error_json("SHERIFF_ENGINE_PANIC", crate::panic_message(payload))
            }
        }
    }
}

impl ProjectHandle {
    fn empty() -> Self {
        Self {
            input: None,
            input_hash: 0,
            root_dir: String::new(),
            entry_file: None,
            interner: PathInterner::default(),
            file_paths: FxHashSet::default(),
            module_path_ids: FxHashSet::default(),
            forward: FxHashMap::default(),
            reverse: FxHashMap::default(),
            module_assignment: FxHashMap::default(),
            module_tags: FxHashMap::default(),
            resolution_context: None,
            source_config_paths: Vec::new(),
            package_manifest_paths: Vec::new(),
            dependency_stamps: FxHashMap::default(),
            overlays: FxHashMap::default(),
            tag_callback_cache: FxHashMap::default(),
            rule_callback_cache: FxHashMap::default(),
            pending_callbacks: None,
            latest_result: String::new(),
        }
    }

    fn guard(&mut self, operation: impl FnOnce(&mut Self) -> Result<String, String>) -> String {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| operation(self)));
        let output = match result {
            Ok(Ok(output)) => output,
            Ok(Err(message)) => crate::error_json("SHERIFF_ENGINE_ERROR", message),
            Err(payload) => {
                crate::error_json("SHERIFF_ENGINE_PANIC", crate::panic_message(payload))
            }
        };
        self.latest_result = output.clone();
        output
    }

    fn initialize(&mut self, input_json: &str) -> Result<String, String> {
        if input_json.len() > crate::input::MAX_INPUT_JSON_BYTES {
            return Err(format!(
                "input JSON exceeds the {} byte limit",
                crate::input::MAX_INPUT_JSON_BYTES
            ));
        }
        let input: ProjectHandleInput = serde_json::from_str(input_json)
            .map_err(|error| format!("invalid ProjectHandleInput JSON: {error}"))?;
        if input.schema_version != 1 {
            return Err(format!(
                "unsupported ProjectHandle schemaVersion {}; expected 1",
                input.schema_version
            ));
        }
        validate_handle_input(&input)?;
        self.input_hash = hash_value(input_json);
        self.input = Some(input);
        self.rebuild_graph()?;
        self.drive_analysis()
    }

    fn apply_changes_inner(&mut self, events_json: &str) -> Result<String, String> {
        if self.pending_callbacks.is_some() {
            return Err(
                "callback results must be provided before applying more changes".to_owned(),
            );
        }
        if events_json.len() > crate::input::MAX_INPUT_JSON_BYTES {
            return Err(format!(
                "change JSON exceeds the {} byte limit",
                crate::input::MAX_INPUT_JSON_BYTES
            ));
        }
        let changes: ApplyChangesInput = serde_json::from_str(events_json)
            .map_err(|error| format!("invalid ApplyChangesInput JSON: {error}"))?;
        if changes.schema_version != 1 {
            return Err(format!(
                "unsupported ApplyChanges schemaVersion {}; expected 1",
                changes.schema_version
            ));
        }
        if let Some(module_paths) = changes.module_paths {
            self.input_mut()?.module_paths = module_paths;
            self.refresh_modules()?;
        }

        let mut full_rebuild = false;
        let mut modified_sources = FxHashSet::default();
        for event in changes.events {
            match event {
                ChangeEvent::OverlaySet { path, content } => {
                    let path = self.absolute_path(&path)?;
                    self.overlays.insert(path.clone(), content);
                    modified_sources.insert(path);
                }
                ChangeEvent::OverlayClear { path } => {
                    let path = self.absolute_path(&path)?;
                    self.overlays.remove(&path);
                    modified_sources.insert(path);
                }
                ChangeEvent::Modified { path } => {
                    let path = self.absolute_path(&path)?;
                    if self.is_sheriff_config(&path) {
                        return Err(
                            "sheriff config changed; construct a new ProjectHandle with the evaluated config"
                                .to_owned(),
                        );
                    }
                    if self.is_wide_dependency(&path) {
                        full_rebuild = true;
                    } else {
                        modified_sources.insert(path);
                    }
                }
                ChangeEvent::Created { path } | ChangeEvent::Deleted { path } => {
                    let path = self.absolute_path(&path)?;
                    if !path.exists() {
                        self.overlays.remove(&path);
                    }
                    full_rebuild = true;
                }
                ChangeEvent::Renamed { old_path, path } => {
                    let old_path = self.absolute_path(&old_path)?;
                    let path = self.absolute_path(&path)?;
                    if let Some(content) = self.overlays.remove(&old_path) {
                        self.overlays.insert(path, content);
                    }
                    full_rebuild = true;
                }
                ChangeEvent::Directory { path } => {
                    let _ = self.absolute_path(&path)?;
                    full_rebuild = true;
                }
                ChangeEvent::SheriffConfig { path } => {
                    let _ = self.absolute_path(&path)?;
                    return Err(
                        "sheriff config changed; construct a new ProjectHandle with the evaluated config"
                            .to_owned(),
                    );
                }
            }
        }

        if full_rebuild {
            self.rebuild_graph()?;
        } else {
            for path in modified_sources {
                self.patch_source(&path)?;
                let overlay = self.overlays.get(&path).map(String::as_str);
                self.dependency_stamps
                    .insert(path.clone(), dependency_stamp(&path, overlay));
            }
        }
        self.pending_callbacks = None;
        self.drive_analysis()
    }

    fn provide_callback_results_inner(&mut self, results_json: &str) -> Result<String, String> {
        let input: CallbackResultsInput = serde_json::from_str(results_json)
            .map_err(|error| format!("invalid CallbackResultsInput JSON: {error}"))?;
        if input.schema_version != 1 {
            return Err(format!(
                "unsupported callback-results schemaVersion {}; expected 1",
                input.schema_version
            ));
        }
        match self.pending_callbacks.take() {
            Some(PendingCallbacks::Tags(keys)) => {
                let results: Vec<Vec<String>> = serde_json::from_value(input.results)
                    .map_err(|error| format!("invalid tag callback results: {error}"))?;
                if results.len() != keys.len() {
                    return Err(format!(
                        "tag callback result count {} does not match pending count {}",
                        results.len(),
                        keys.len()
                    ));
                }
                self.tag_callback_cache
                    .extend(keys.into_iter().zip(results));
            }
            Some(PendingCallbacks::Rules(keys)) => {
                let results: Vec<bool> = serde_json::from_value(input.results)
                    .map_err(|error| format!("invalid rule callback results: {error}"))?;
                if results.len() != keys.len() {
                    return Err(format!(
                        "rule callback result count {} does not match pending count {}",
                        results.len(),
                        keys.len()
                    ));
                }
                self.rule_callback_cache
                    .extend(keys.into_iter().zip(results));
            }
            None => return Err("there are no pending callback candidates".to_owned()),
        }
        self.drive_analysis()
    }

    fn rebuild_graph(&mut self) -> Result<(), String> {
        let input = self.input_ref()?.clone();
        let ts_config = self.absolute_path(&input.ts_config_path)?;
        let entry = self.absolute_path(&input.entry_file)?;
        let mut session =
            ResolveSession::new(&ts_config, &input.ignore_file_extensions, input.shadow_mode)
                .map_err(|error| error.to_string())?;
        self.root_dir = session.root_dir().to_string_lossy().into_owned();
        self.resolution_context = Some(session.context_snapshot());
        self.interner = PathInterner::default();
        self.forward.clear();
        self.file_paths.clear();
        self.entry_file = Some(
            self.interner
                .intern_relative(&self.root_dir, entry.to_string_lossy().as_ref())?,
        );

        let mut queued = FxHashSet::default();
        let mut queue = VecDeque::from([entry]);
        while let Some(path) = queue.pop_front() {
            let path_id = self
                .interner
                .intern_relative(&self.root_dir, path.to_string_lossy().as_ref())?;
            if !queued.insert(path_id) {
                continue;
            }
            let overlay = self.overlays.get(&path).map(String::as_str);
            let Some(resolved) = session
                .resolve_file(&path, overlay)
                .map_err(|error| error.to_string())?
            else {
                continue;
            };
            let edges = self.materialize_edges(resolved.imports, &mut queue)?;
            self.file_paths.insert(path_id);
            self.forward.insert(path_id, edges);
        }
        let summary = session.finish();
        if !summary.fallback_reasons.is_empty() && !input.shadow_mode {
            return Err(format!(
                "Rust resolution requires TypeScript fallback: {}",
                summary.fallback_reasons.join("; ")
            ));
        }
        self.root_dir = summary.root_dir.to_string_lossy().into_owned();
        self.source_config_paths = summary.source_config_paths;
        self.package_manifest_paths = summary.package_manifest_paths;
        self.refresh_reverse_edges();
        self.refresh_modules()?;
        self.refresh_dependency_stamps()?;
        Ok(())
    }

    fn patch_source(&mut self, path: &Path) -> Result<(), String> {
        if !path.exists() && !self.overlays.contains_key(path) {
            return self.rebuild_graph();
        }
        let input = self.input_ref()?.clone();
        let ts_config = self.absolute_path(&input.ts_config_path)?;
        let mut session =
            ResolveSession::new(&ts_config, &input.ignore_file_extensions, input.shadow_mode)
                .map_err(|error| error.to_string())?;
        self.resolution_context = Some(session.context_snapshot());
        let mut queue = VecDeque::from([path.to_path_buf()]);
        let mut visited = FxHashSet::default();
        while let Some(source_path) = queue.pop_front() {
            let source_id = self
                .interner
                .intern_relative(&self.root_dir, source_path.to_string_lossy().as_ref())?;
            if !visited.insert(source_id) {
                continue;
            }
            let overlay = self.overlays.get(&source_path).map(String::as_str);
            let Some(resolved) = session
                .resolve_file(&source_path, overlay)
                .map_err(|error| error.to_string())?
            else {
                continue;
            };
            let mut discovered = VecDeque::new();
            let edges = self.materialize_edges(resolved.imports, &mut discovered)?;
            self.file_paths.insert(source_id);
            self.replace_edges(source_id, edges);
            for target in discovered {
                let target_id = self
                    .interner
                    .intern_relative(&self.root_dir, target.to_string_lossy().as_ref())?;
                if !self.forward.contains_key(&target_id) {
                    queue.push_back(target);
                }
            }
        }
        let summary = session.finish();
        if !summary.fallback_reasons.is_empty() && !input.shadow_mode {
            return self.rebuild_graph();
        }
        self.source_config_paths = summary.source_config_paths;
        self.package_manifest_paths
            .extend(summary.package_manifest_paths);
        self.package_manifest_paths.sort();
        self.package_manifest_paths.dedup();
        Ok(())
    }

    fn materialize_edges(
        &mut self,
        imports: Vec<ResolvedImport>,
        queue: &mut VecDeque<PathBuf>,
    ) -> Result<Vec<GraphImport>, String> {
        imports
            .into_iter()
            .map(|import| match import.kind {
                ResolvedImportKind::Module => {
                    let relative = import.resolved_path.ok_or_else(|| {
                        format!("module import '{}' has no resolved path", import.raw)
                    })?;
                    let absolute = self.root_path().join(&relative);
                    let target = self.interner.intern_relative(&self.root_dir, &relative)?;
                    queue.push_back(absolute);
                    Ok(GraphImport::Module {
                        raw: import.raw,
                        target,
                    })
                }
                ResolvedImportKind::External => Ok(GraphImport::External { raw: import.raw }),
                ResolvedImportKind::Unresolvable => {
                    Ok(GraphImport::Unresolvable { raw: import.raw })
                }
            })
            .collect()
    }

    fn refresh_reverse_edges(&mut self) {
        self.reverse.clear();
        for (source, imports) in &self.forward {
            for import in imports {
                if let GraphImport::Module { target, .. } = import {
                    self.reverse.entry(*target).or_default().insert(*source);
                }
            }
        }
    }

    fn replace_edges(&mut self, source: PathId, edges: Vec<GraphImport>) {
        if let Some(previous) = self.forward.remove(&source) {
            for import in previous {
                if let GraphImport::Module { target, .. } = import
                    && let Some(importers) = self.reverse.get_mut(&target)
                {
                    importers.remove(&source);
                    if importers.is_empty() {
                        self.reverse.remove(&target);
                    }
                }
            }
        }
        for import in &edges {
            if let GraphImport::Module { target, .. } = import {
                self.reverse.entry(*target).or_default().insert(source);
            }
        }
        self.forward.insert(source, edges);
    }

    fn refresh_modules(&mut self) -> Result<(), String> {
        self.module_path_ids.clear();
        let root_id = self
            .interner
            .intern_relative(&self.root_dir, &self.root_dir)?;
        self.module_path_ids.insert(root_id);
        let module_paths = self.input_ref()?.module_paths.clone();
        for module in module_paths {
            let path = self
                .interner
                .intern_relative(&self.root_dir, &module.path)?;
            self.module_path_ids.insert(path);
        }
        self.refresh_module_assignments()
    }

    fn refresh_module_assignments(&mut self) -> Result<(), String> {
        self.module_assignment.clear();
        for file in self.reached_files() {
            let mut candidate = self.interner.text(file);
            loop {
                if let Some(id) = self.interner.id(candidate)
                    && self.module_path_ids.contains(&id)
                {
                    self.module_assignment.insert(file, id);
                    break;
                }
                if candidate == "." {
                    return Err(format!(
                        "could not assign file '{}' to a module",
                        self.interner.text(file)
                    ));
                }
                candidate = candidate
                    .rfind('/')
                    .into_iter()
                    .chain(candidate.rfind('\\'))
                    .max()
                    .filter(|index| *index > 0)
                    .map_or(".", |index| &candidate[..index]);
            }
        }
        Ok(())
    }

    fn reached_files(&self) -> FxHashSet<PathId> {
        let mut reached = FxHashSet::default();
        let Some(entry) = self.entry_file else {
            return reached;
        };
        let mut queue = VecDeque::from([entry]);
        while let Some(file) = queue.pop_front() {
            if !reached.insert(file) {
                continue;
            }
            if let Some(imports) = self.forward.get(&file) {
                queue.extend(imports.iter().filter_map(|import| match import {
                    GraphImport::Module { target, .. } => Some(*target),
                    GraphImport::External { .. } | GraphImport::Unresolvable { .. } => None,
                }));
            }
        }
        reached
    }

    fn engine_input(
        &self,
        tag_callback_results: Option<Vec<Vec<String>>>,
        rule_callback_results: Option<Vec<bool>>,
    ) -> Result<EngineInput, String> {
        let input = self.input_ref()?;
        let reached = self.reached_files();
        let mut file_ids = reached.iter().copied().collect::<Vec<_>>();
        file_ids.sort_by(|left, right| self.interner.text(*left).cmp(self.interner.text(*right)));
        let files = file_ids
            .into_iter()
            .map(|path| {
                let imports = self
                    .forward
                    .get(&path)
                    .into_iter()
                    .flatten()
                    .map(|import| match import {
                        GraphImport::Module { raw, target } => InputImport {
                            raw: raw.clone(),
                            kind: ImportKind::Module,
                            resolved_path: Some(self.interner.text(*target).to_owned()),
                        },
                        GraphImport::External { raw } => InputImport {
                            raw: raw.clone(),
                            kind: ImportKind::External,
                            resolved_path: None,
                        },
                        GraphImport::Unresolvable { raw } => InputImport {
                            raw: raw.clone(),
                            kind: ImportKind::Unresolvable,
                            resolved_path: None,
                        },
                    })
                    .collect();
                InputFile {
                    path: self.interner.text(path).to_owned(),
                    imports,
                }
            })
            .collect();
        Ok(EngineInput {
            schema_version: 1,
            root_dir: self.root_dir.clone(),
            files,
            module_config: input.module_config.clone(),
            module_paths: input.module_paths.clone(),
            auto_tagging: input.auto_tagging,
            dep_rules: input.dep_rules.clone(),
            deny_rules: input.deny_rules.clone(),
            external_rules: input.external_rules.clone(),
            tag_callback_results,
            rule_callback_results,
            encapsulation_pattern: input.encapsulation_pattern.clone(),
            enable_barrel_less: input.enable_barrel_less,
            exclude_root: input.exclude_root,
            barrel_file_name: input.barrel_file_name.clone(),
        })
    }

    fn drive_analysis(&mut self) -> Result<String, String> {
        let first = engine::analyze(self.engine_input(None, None)?)?;
        if matches!(first, AnalyzeResult::Complete(_)) {
            let output = serde_json::to_string(&first)
                .map_err(|error| format!("could not serialize analysis output: {error}"))?;
            self.pending_callbacks = None;
            self.capture_module_tags(&output)?;
            return Ok(output);
        }
        let first_value = serde_json::to_value(&first)
            .map_err(|error| format!("could not serialize analysis: {error}"))?;
        let mut tag_results = None;
        if let Some(candidates) = first_value
            .get("tagCallbackCandidates")
            .and_then(Value::as_array)
        {
            let cached = self.materialize_cached_tags(candidates)?;
            if !cached.missing_keys.is_empty() {
                self.pending_callbacks = Some(PendingCallbacks::Tags(cached.missing_keys));
                return serde_json::to_string(&json!({
                    "schemaVersion": 1,
                    "tagCallbackCandidates": cached.candidates,
                }))
                .map_err(|error| format!("could not serialize tag candidates: {error}"));
            }
            tag_results = Some(cached.results);
        }

        let second = engine::analyze(self.engine_input(tag_results.clone(), None)?)?;
        let second_value = serde_json::to_value(&second)
            .map_err(|error| format!("could not serialize analysis: {error}"))?;
        let mut rule_results = None;
        if let Some(candidates) = second_value
            .get("ruleCallbackCandidates")
            .and_then(Value::as_array)
        {
            let cached = self.materialize_cached_rules(candidates)?;
            if !cached.missing_keys.is_empty() {
                self.pending_callbacks = Some(PendingCallbacks::Rules(cached.missing_keys));
                return serde_json::to_string(&json!({
                    "schemaVersion": 1,
                    "ruleCallbackCandidates": cached.candidates,
                }))
                .map_err(|error| format!("could not serialize rule candidates: {error}"));
            }
            rule_results = Some(cached.results);
        }

        let complete = if rule_results.is_some() {
            engine::analyze(self.engine_input(tag_results, rule_results)?)?
        } else {
            second
        };
        if !matches!(complete, AnalyzeResult::Complete(_)) {
            return Err("callback materialization did not converge".to_owned());
        }
        let output = serde_json::to_string(&complete)
            .map_err(|error| format!("could not serialize analysis output: {error}"))?;
        self.pending_callbacks = None;
        self.capture_module_tags(&output)?;
        Ok(output)
    }

    fn materialize_cached_tags(
        &self,
        candidates: &[Value],
    ) -> Result<CachedMaterialization<Vec<String>>, String> {
        let mut results = Vec::with_capacity(candidates.len());
        let mut missing = Vec::new();
        let mut output = Vec::new();
        for candidate in candidates {
            let key = callback_key(candidate)?;
            if let Some(value) = self.tag_callback_cache.get(&key) {
                results.push(value.clone());
            } else {
                missing.push(key);
                let mut candidate = candidate.clone();
                candidate["candidateIndex"] = Value::from(output.len());
                output.push(candidate);
                results.push(Vec::new());
            }
        }
        Ok(CachedMaterialization {
            results,
            missing_keys: missing,
            candidates: output,
        })
    }

    fn materialize_cached_rules(
        &self,
        candidates: &[Value],
    ) -> Result<CachedMaterialization<bool>, String> {
        let mut results = Vec::with_capacity(candidates.len());
        let mut missing = Vec::new();
        let mut output = Vec::new();
        for candidate in candidates {
            let key = callback_key(candidate)?;
            if let Some(value) = self.rule_callback_cache.get(&key) {
                results.push(*value);
            } else {
                missing.push(key);
                let mut candidate = candidate.clone();
                candidate["candidateIndex"] = Value::from(output.len());
                output.push(candidate);
                results.push(false);
            }
        }
        Ok(CachedMaterialization {
            results,
            missing_keys: missing,
            candidates: output,
        })
    }

    fn capture_module_tags(&mut self, output: &str) -> Result<(), String> {
        let value: Value = serde_json::from_str(output)
            .map_err(|error| format!("could not inspect analysis output: {error}"))?;
        self.module_tags.clear();
        for module in value
            .get("modules")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(path) = module.get("path").and_then(Value::as_str) else {
                continue;
            };
            let tags = serde_json::from_value(module.get("tags").cloned().unwrap_or_default())
                .map_err(|error| format!("invalid module tags in engine output: {error}"))?;
            let id = self.interner.intern_relative(&self.root_dir, path)?;
            self.module_tags.insert(id, tags);
        }
        Ok(())
    }

    fn refresh_dependency_stamps(&mut self) -> Result<(), String> {
        self.dependency_stamps.clear();
        let mut dependencies = HashSet::new();
        dependencies.extend(self.source_config_paths.iter().cloned());
        if let Some(context) = &self.resolution_context {
            dependencies.insert(context.root_dir.clone());
            dependencies.extend(context.source_config_paths.iter().cloned());
            dependencies.extend(context.base_url.iter().cloned());
            dependencies.extend(context.paths.iter().map(|mapping| mapping.target.clone()));
            // The mode is not a filesystem dependency, but retaining it in the
            // snapshot is what makes a recreated resolver context comparable.
            let _resolution_mode = context.module_resolution.as_deref();
        }
        dependencies.extend(self.package_manifest_paths.iter().cloned());
        dependencies.insert(self.absolute_path(&self.input_ref()?.ts_config_path)?);
        for path in &self.input_ref()?.sheriff_config_paths {
            dependencies.insert(self.absolute_path(path)?);
        }
        for file in self.reached_files() {
            let path = self.root_path().join(self.interner.text(file));
            dependencies.insert(path.clone());
            let mut current = path.parent();
            let mut found_package = false;
            while let Some(directory) = current {
                dependencies.insert(directory.to_path_buf());
                let package_json = directory.join("package.json");
                if !found_package && package_json.exists() {
                    dependencies.insert(package_json);
                    found_package = true;
                }
                if directory == self.root_path() {
                    break;
                }
                current = directory.parent();
            }
            for ancestor in path.ancestors() {
                if fs::symlink_metadata(ancestor)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
                {
                    dependencies.insert(ancestor.to_path_buf());
                }
            }
        }
        for path in dependencies {
            let overlay = self.overlays.get(&path).map(String::as_str);
            self.dependency_stamps
                .insert(path.clone(), dependency_stamp(&path, overlay));
        }
        // The evaluated sheriff config is executable Node state. Its serialized
        // input hash is tracked separately and a config event requires a fresh
        // handle rather than pretending Rust can re-evaluate it.
        let _ = self.input_hash;
        Ok(())
    }

    fn is_wide_dependency(&self, path: &Path) -> bool {
        path.file_name()
            .is_some_and(|name| name == "package.json" || name == "tsconfig.json")
            || self.source_config_paths.iter().any(|config| config == path)
            || path.extension().is_none()
    }

    fn is_sheriff_config(&self, path: &Path) -> bool {
        self.input_ref().is_ok_and(|input| {
            input
                .sheriff_config_paths
                .iter()
                .filter_map(|config| self.absolute_path(config).ok())
                .any(|config| config == path)
        })
    }

    fn absolute_path(&self, path: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            Ok(normalize_lexically(&path))
        } else {
            let base = if self.root_dir.is_empty() {
                std::env::current_dir()
                    .map_err(|error| format!("could not read current directory: {error}"))?
            } else {
                self.root_path()
            };
            Ok(normalize_lexically(&base.join(path)))
        }
    }

    fn root_path(&self) -> PathBuf {
        PathBuf::from(&self.root_dir)
    }

    fn input_ref(&self) -> Result<&ProjectHandleInput, String> {
        self.input
            .as_ref()
            .ok_or_else(|| "ProjectHandle failed to initialize".to_owned())
    }

    fn input_mut(&mut self) -> Result<&mut ProjectHandleInput, String> {
        self.input
            .as_mut()
            .ok_or_else(|| "ProjectHandle failed to initialize".to_owned())
    }
}

fn callback_key(candidate: &Value) -> Result<String, String> {
    let mut candidate = candidate.clone();
    candidate
        .as_object_mut()
        .ok_or_else(|| "callback candidate is not an object".to_owned())?
        .remove("candidateIndex");
    serde_json::to_string(&candidate)
        .map_err(|error| format!("could not key callback candidate: {error}"))
}

fn dependency_stamp(path: &Path, overlay: Option<&str>) -> DependencyStamp {
    let metadata = fs::symlink_metadata(path).ok();
    let modified_nanos = metadata
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos());
    let content_hash = overlay.map(hash_value).or_else(|| {
        metadata
            .as_ref()
            .filter(|metadata| metadata.is_dir())
            .and_then(|_| directory_hash(path))
    });
    DependencyStamp {
        exists: metadata.is_some() || overlay.is_some(),
        length: metadata.as_ref().map_or(0, fs::Metadata::len),
        modified_nanos,
        content_hash,
        symlink_target: metadata
            .as_ref()
            .filter(|metadata| metadata.file_type().is_symlink())
            .and_then(|_| fs::read_link(path).ok()),
    }
}

fn directory_hash(path: &Path) -> Option<u64> {
    let mut entries = fs::read_dir(path)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect::<Vec<_>>();
    entries.sort();
    let mut hasher = DefaultHasher::new();
    entries.hash(&mut hasher);
    Some(hasher.finish())
}

fn hash_value(value: impl Hash) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn default_barrel_file_name() -> String {
    "index.ts".to_owned()
}

fn validate_handle_input(input: &ProjectHandleInput) -> Result<(), String> {
    for (name, value) in [
        ("entryFile", &input.entry_file),
        ("tsConfigPath", &input.ts_config_path),
    ]
    .into_iter()
    .chain(
        input
            .ignore_file_extensions
            .iter()
            .map(|value| ("ignoreFileExtensions entry", value)),
    )
    .chain(
        input
            .sheriff_config_paths
            .iter()
            .map(|value| ("sheriffConfigPaths entry", value)),
    ) {
        if value.len() > crate::input::MAX_STRING_BYTES {
            return Err(format!(
                "{name} exceeds the {} byte string/path limit",
                crate::input::MAX_STRING_BYTES
            ));
        }
    }
    EngineInput {
        schema_version: 1,
        root_dir: ".".to_owned(),
        files: Vec::new(),
        module_config: input.module_config.clone(),
        module_paths: input.module_paths.clone(),
        auto_tagging: input.auto_tagging,
        dep_rules: input.dep_rules.clone(),
        deny_rules: input.deny_rules.clone(),
        external_rules: input.external_rules.clone(),
        tag_callback_results: None,
        rule_callback_results: None,
        encapsulation_pattern: input.encapsulation_pattern.clone(),
        enable_barrel_less: input.enable_barrel_less,
        exclude_root: input.exclude_root,
        barrel_file_name: input.barrel_file_name.clone(),
    }
    .validate()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TestProject {
        root: PathBuf,
        entry: PathBuf,
        config: PathBuf,
        package: PathBuf,
    }

    impl TestProject {
        fn new() -> Self {
            let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let root =
                std::env::temp_dir().join(format!("sheriff-r4-handle-{}-{id}", std::process::id()));
            fs::create_dir_all(root.join("src/a")).unwrap();
            fs::create_dir_all(root.join("src/b")).unwrap();
            fs::create_dir_all(root.join("src/c")).unwrap();
            let entry = root.join("src/entry.ts");
            let config = root.join("tsconfig.json");
            let package = root.join("package.json");
            fs::write(&config, "{}").unwrap();
            fs::write(&package, r#"{"name":"r4-test"}"#).unwrap();
            fs::write(&entry, "import './a/a';\n").unwrap();
            fs::write(root.join("src/a/a.ts"), "import '../b/b';\n").unwrap();
            fs::write(root.join("src/b/b.ts"), "export const b = 1;\n").unwrap();
            fs::write(root.join("src/c/c.ts"), "export const c = 1;\n").unwrap();
            Self {
                root,
                entry,
                config,
                package,
            }
        }

        fn input(&self) -> String {
            json!({
                "schemaVersion": 1,
                "entryFile": self.entry,
                "tsConfigPath": self.config,
                "modulePaths": [
                    {"path": self.root.join("src/a"), "isBarrel": false},
                    {"path": self.root.join("src/b"), "isBarrel": false},
                    {"path": self.root.join("src/c"), "isBarrel": false},
                ],
                "moduleConfig": {"src/<name>": "<name>"},
                "autoTagging": true,
                "depRules": {"*": "*"},
                "denyRules": {"root": "c"},
                "externalRules": {},
                "encapsulationPattern": "internal",
                "enableBarrelLess": true,
                "excludeRoot": false,
                "barrelFileName": "index.ts",
            })
            .to_string()
        }
    }

    impl Drop for TestProject {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, upper: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 32) as usize) % upper
        }
    }

    #[test]
    fn randomized_incremental_results_equal_clean_rebuilds() {
        for seed in [1, 0x5eed, 0xc0ffee, u32::MAX as u64] {
            run_equivalence_sequence(seed);
        }
    }

    fn run_equivalence_sequence(seed: u64) {
        let project = TestProject::new();
        let input = project.input();
        let mut incremental = ProjectHandle::new(input.clone());
        assert_complete(&incremental.get_result());
        let mut rng = Lcg(seed);
        let mut overlay: Option<String> = None;
        let extra = project.root.join("src/c/extra.ts");
        let renamed = project.root.join("src/b/renamed.ts");

        for step in 0..48 {
            let operation = if step < 7 { step } else { rng.next(7) };
            let events = match operation {
                0 => {
                    let target = ["../b/b", "../c/c", "../b/b"][rng.next(3)];
                    let source = format!("import '{target}';\nexport const a = {step};\n");
                    fs::write(project.root.join("src/a/a.ts"), source).unwrap();
                    json!([{"kind":"modified","path":project.root.join("src/a/a.ts")}])
                }
                1 => {
                    fs::write(&extra, "export const extra = true;\n").unwrap();
                    fs::write(&project.entry, "import './a/a';\nimport './c/extra';\n").unwrap();
                    json!([
                        {"kind":"created","path":extra},
                        {"kind":"modified","path":project.entry},
                    ])
                }
                2 => {
                    if extra.exists() {
                        fs::remove_file(&extra).unwrap();
                    }
                    fs::write(&project.entry, "import './a/a';\n").unwrap();
                    json!([
                        {"kind":"deleted","path":extra},
                        {"kind":"modified","path":project.entry},
                    ])
                }
                3 => {
                    let original = project.root.join("src/b/b.ts");
                    if renamed.exists() {
                        fs::rename(&renamed, &original).unwrap();
                        fs::write(project.root.join("src/a/a.ts"), "import '../b/b';\n").unwrap();
                        json!([
                            {"kind":"renamed","oldPath":renamed,"path":original},
                            {"kind":"modified","path":project.root.join("src/a/a.ts")},
                        ])
                    } else {
                        fs::rename(&original, &renamed).unwrap();
                        fs::write(project.root.join("src/a/a.ts"), "import '../b/renamed';\n")
                            .unwrap();
                        json!([
                            {"kind":"renamed","oldPath":original,"path":renamed},
                            {"kind":"modified","path":project.root.join("src/a/a.ts")},
                        ])
                    }
                }
                4 => {
                    overlay = Some("import './c/c';\nexport const overlay = true;\n".to_owned());
                    json!([{
                        "kind":"overlaySet",
                        "path":project.entry,
                        "content":overlay.as_ref().unwrap(),
                    }])
                }
                5 => {
                    overlay = None;
                    json!([{"kind":"overlayClear","path":project.entry}])
                }
                _ if rng.next(2) == 0 => {
                    fs::write(
                        &project.config,
                        format!("{{\"compilerOptions\":{{\"strict\":{}}}}}", step % 2 == 0),
                    )
                    .unwrap();
                    json!([{"kind":"modified","path":project.config}])
                }
                _ => {
                    fs::write(
                        &project.package,
                        format!(r#"{{"name":"r4-test","version":"0.0.{step}"}}"#),
                    )
                    .unwrap();
                    json!([{"kind":"modified","path":project.package}])
                }
            };
            let incremental_output =
                incremental.apply_changes(json!({"schemaVersion":1,"events":events}).to_string());
            assert_complete(&incremental_output);

            let mut clean = ProjectHandle::new(input.clone());
            if let Some(content) = &overlay {
                let clean_output = clean.set_overlay(
                    project.entry.to_string_lossy().into_owned(),
                    content.clone(),
                );
                assert_complete(&clean_output);
            }
            assert_eq!(
                incremental_output,
                clean.get_result(),
                "incremental/clean mismatch for seed {seed}, step {step}, operation {operation}"
            );
            assert_reverse_edges(&incremental);
        }
    }

    #[test]
    fn overlays_do_not_change_the_disk_result_after_clear() {
        let project = TestProject::new();
        let mut handle = ProjectHandle::new(project.input());
        let disk_result = handle.get_result();
        let overlaid = handle.set_overlay(
            project.entry.to_string_lossy().into_owned(),
            "import './c/c';\n".to_owned(),
        );
        assert_ne!(overlaid, disk_result);
        assert_eq!(
            handle.clear_overlay(project.entry.to_string_lossy().into_owned()),
            disk_result
        );
        assert_eq!(
            fs::read_to_string(&project.entry).unwrap(),
            "import './a/a';\n"
        );
    }

    #[test]
    fn callback_decisions_survive_across_method_calls_for_unchanged_contexts() {
        let project = TestProject::new();
        fs::create_dir_all(project.root.join("src/source")).unwrap();
        fs::create_dir_all(project.root.join("src/target")).unwrap();
        let source = project.root.join("src/source/entry.ts");
        let target = project.root.join("src/target/entry.ts");
        fs::write(&source, "import '../target/entry';\n").unwrap();
        fs::write(&target, "export const target = true;\n").unwrap();
        let input = json!({
            "schemaVersion": 1,
            "entryFile": source,
            "tsConfigPath": project.config,
            "modulePaths": [
                {"path": project.root.join("src/source"), "isBarrel": false},
                {"path": project.root.join("src/target"), "isBarrel": false},
            ],
            "moduleConfig": {"src/source": "source", "src/target": "target"},
            "autoTagging": true,
            "depRules": {
                "source": {"__sheriffEngineCallbackId": 0},
                "target": [],
            },
            "denyRules": {},
            "externalRules": {},
            "enableBarrelLess": true,
        })
        .to_string();
        let mut handle = ProjectHandle::new(input);
        let candidates: Value = serde_json::from_str(&handle.get_result()).unwrap();
        let candidate = &candidates["ruleCallbackCandidates"][0];
        assert_eq!(candidate["candidateIndex"], 0);
        assert_eq!(candidate["context"]["from"], "source");
        assert_eq!(candidate["context"]["to"], "target");
        assert_eq!(
            candidate["context"]["fromFilePath"],
            source.to_string_lossy().as_ref()
        );
        assert_eq!(
            candidate["context"]["toFilePath"],
            target.to_string_lossy().as_ref()
        );
        let context_keys = candidate["context"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(
            context_keys,
            [
                "fromModulePath",
                "toModulePath",
                "fromFilePath",
                "toFilePath",
                "fromTags",
                "toTags",
                "from",
                "to",
            ]
        );

        assert_complete(
            &handle.provide_callback_results(
                json!({"schemaVersion": 1, "results": [true]}).to_string(),
            ),
        );
        fs::write(&source, "import '../target/entry';\n\n").unwrap();
        let output = handle.apply_changes(
            json!({
                "schemaVersion": 1,
                "events": [{"kind":"modified", "path":source}],
            })
            .to_string(),
        );
        assert_complete(&output);
        assert!(!output.contains("ruleCallbackCandidates"));
    }

    fn assert_complete(output: &str) {
        let value: Value = serde_json::from_str(output).unwrap();
        assert!(value.get("error").is_none(), "{output}");
        assert!(value.get("violations").is_some(), "{output}");
    }

    fn assert_reverse_edges(handle: &ProjectHandle) {
        for (source, imports) in &handle.forward {
            for import in imports {
                if let GraphImport::Module { target, .. } = import {
                    assert!(
                        handle
                            .reverse
                            .get(target)
                            .is_some_and(|importers| importers.contains(source)),
                        "missing reverse edge {} <- {}",
                        handle.interner.text(*target),
                        handle.interner.text(*source)
                    );
                }
            }
        }
    }
}
