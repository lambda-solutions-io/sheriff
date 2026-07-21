use std::cmp::Ordering;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

#[cfg(test)]
use std::fs;

use napi_derive::napi;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::engine::{self, AnalyzeResult, js_string_cmp};
use crate::input::{
    ConfigValue, EncapsulationPattern, EngineInput, ImportKind, InputFile, InputImport,
    InputModulePath, OrderedMap, RuleValue,
};
use crate::paths::{PathId, PathInterner};
use crate::resolve::{ImportKind as ResolvedImportKind, ResolveSession, ResolvedImport};

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
    /// configuration. A change or overlay event for one of these fails the
    /// call: Rust cannot re-evaluate executable TS, so the caller must
    /// construct a replacement handle with the freshly evaluated config.
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
#[serde(rename_all = "camelCase")]
struct SetModulePathsInput {
    schema_version: u32,
    #[serde(default)]
    module_paths: Vec<InputModulePath>,
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

#[derive(Default)]
struct CachedFileViolations {
    dependency: Vec<Value>,
    encapsulation: Vec<Value>,
    external: Vec<Value>,
}

#[derive(Default)]
enum AnalysisScope {
    #[default]
    Full,
    Incremental(FxHashSet<PathId>),
}

#[derive(Clone, Copy)]
enum ViolationCategory {
    Dependency,
    Encapsulation,
    External,
}

/// Persistent R4 project state. All public methods exchange JSON strings so
/// the existing hostile-input limits and structured-error contract stay at the
/// napi boundary, while the graph itself never crosses that boundary.
#[napi]
pub struct ProjectHandle {
    input: Option<ProjectHandleInput>,
    root_dir: String,
    entry_file: Option<PathId>,
    interner: PathInterner,
    file_paths: FxHashSet<PathId>,
    module_path_ids: FxHashSet<PathId>,
    forward: FxHashMap<PathId, Vec<GraphImport>>,
    reverse: FxHashMap<PathId, FxHashSet<PathId>>,
    module_assignment: FxHashMap<PathId, PathId>,
    module_tags: FxHashMap<PathId, Vec<String>>,
    file_violations: FxHashMap<PathId, CachedFileViolations>,
    analysis_scope: AnalysisScope,
    source_config_paths: Vec<PathBuf>,
    overlays: FxHashMap<PathBuf, String>,
    tag_callback_cache: FxHashMap<String, Vec<String>>,
    rule_callback_cache: FxHashMap<String, bool>,
    pending_callbacks: Option<PendingCallbacks>,
    last_analysis_file_count: usize,
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

    #[napi(js_name = "setModulePaths")]
    pub fn set_module_paths(&mut self, module_paths_json: String) -> String {
        self.guard(|handle| handle.set_module_paths_inner(&module_paths_json))
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
            files.sort_by(|left, right| js_string_cmp(left, right));
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
            root_dir: String::new(),
            entry_file: None,
            interner: PathInterner::default(),
            file_paths: FxHashSet::default(),
            module_path_ids: FxHashSet::default(),
            forward: FxHashMap::default(),
            reverse: FxHashMap::default(),
            module_assignment: FxHashMap::default(),
            module_tags: FxHashMap::default(),
            file_violations: FxHashMap::default(),
            analysis_scope: AnalysisScope::Full,
            source_config_paths: Vec::new(),
            overlays: FxHashMap::default(),
            tag_callback_cache: FxHashMap::default(),
            rule_callback_cache: FxHashMap::default(),
            pending_callbacks: None,
            last_analysis_file_count: 0,
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
        let mut input: ProjectHandleInput = serde_json::from_str(input_json)
            .map_err(|error| format!("invalid ProjectHandleInput JSON: {error}"))?;
        if input.schema_version != 1 {
            return Err(format!(
                "unsupported ProjectHandle schemaVersion {}; expected 1",
                input.schema_version
            ));
        }
        validate_handle_input(&input)?;
        normalize_handle_paths(&mut input)?;
        self.input = Some(input);
        self.rebuild_graph()?;
        if self.input_ref()?.module_paths.is_empty() {
            return self.discovery_output();
        }
        self.drive_analysis()
    }

    fn discovery_output(&self) -> Result<String, String> {
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "files": self.reached_file_imports(),
            "modules": [],
            "violations": {
                "dependency": [],
                "encapsulation": [],
                "external": [],
            },
        }))
        .map_err(|error| format!("could not serialize discovery output: {error}"))
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
        let structural_change = changes.events.iter().any(|event| {
            matches!(
                event,
                ChangeEvent::Created { .. }
                    | ChangeEvent::Deleted { .. }
                    | ChangeEvent::Renamed { .. }
                    | ChangeEvent::Directory { .. }
            )
        });
        if structural_change && changes.module_paths.is_none() {
            return Err(
                "structural changes require refreshed modulePaths from Node module discovery"
                    .to_owned(),
            );
        }
        let module_paths_changed = changes.module_paths.is_some();
        if let Some(module_paths) = changes.module_paths {
            self.input_mut()?.module_paths = module_paths;
            self.refresh_modules()?;
        }

        let mut full_rebuild = false;
        let mut modified_sources = FxHashSet::default();
        let reached_before = self.reached_files();
        let mut affected = FxHashSet::default();
        for event in changes.events {
            match event {
                ChangeEvent::OverlaySet { path, content } => {
                    let path = self.absolute_path(&path)?;
                    if self.is_sheriff_config(&path) {
                        return Err(
                            "sheriff config overlay changed; construct a new ProjectHandle with the evaluated config"
                                .to_owned(),
                        );
                    }
                    self.overlays.insert(path.clone(), content);
                    if self.is_wide_dependency(&path) {
                        full_rebuild = true;
                    } else {
                        self.collect_affected_path(&path, &mut affected)?;
                        modified_sources.insert(path);
                    }
                }
                ChangeEvent::OverlayClear { path } => {
                    let path = self.absolute_path(&path)?;
                    if self.is_sheriff_config(&path) {
                        return Err(
                            "sheriff config overlay changed; construct a new ProjectHandle with the evaluated config"
                                .to_owned(),
                        );
                    }
                    self.overlays.remove(&path);
                    if self.is_wide_dependency(&path) {
                        full_rebuild = true;
                    } else {
                        self.collect_affected_path(&path, &mut affected)?;
                        modified_sources.insert(path);
                    }
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
                        self.collect_affected_path(&path, &mut affected)?;
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

        if full_rebuild || module_paths_changed {
            self.rebuild_graph()?;
            self.analysis_scope = AnalysisScope::Full;
        } else {
            let mut patch_rebuilt = false;
            for path in modified_sources {
                patch_rebuilt |= self.patch_source(&path)?;
            }
            if patch_rebuilt {
                self.analysis_scope = AnalysisScope::Full;
            } else {
                let reached_after = self.reached_files();
                affected.extend(reached_after.difference(&reached_before).copied());
                affected.retain(|path| reached_after.contains(path));
                self.refresh_incremental_module_assignments(&reached_after)?;
                self.analysis_scope = AnalysisScope::Incremental(affected);
            }
        }
        self.pending_callbacks = None;
        self.drive_analysis()
    }

    fn set_module_paths_inner(&mut self, module_paths_json: &str) -> Result<String, String> {
        if self.pending_callbacks.is_some() {
            return Err("callback results must be provided before setting module paths".to_owned());
        }
        if module_paths_json.len() > crate::input::MAX_INPUT_JSON_BYTES {
            return Err(format!(
                "module paths JSON exceeds the {} byte limit",
                crate::input::MAX_INPUT_JSON_BYTES
            ));
        }
        let input: SetModulePathsInput = serde_json::from_str(module_paths_json)
            .map_err(|error| format!("invalid SetModulePathsInput JSON: {error}"))?;
        if input.schema_version != 1 {
            return Err(format!(
                "unsupported SetModulePaths schemaVersion {}; expected 1",
                input.schema_version
            ));
        }

        self.input_mut()?.module_paths = input.module_paths;
        self.refresh_modules()?;
        self.analysis_scope = AnalysisScope::Full;
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
        let mut session = ResolveSession::new_with_overlays(
            &ts_config,
            &input.ignore_file_extensions,
            input.shadow_mode,
            &self.overlays,
        )
        .map_err(|error| error.to_string())?;
        self.root_dir = session.root_dir().to_string_lossy().into_owned();
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
        self.refresh_reverse_edges();
        self.refresh_modules()?;
        Ok(())
    }

    fn patch_source(&mut self, path: &Path) -> Result<bool, String> {
        if !path.exists() && !self.overlays.contains_key(path) {
            self.rebuild_graph()?;
            return Ok(true);
        }
        let input = self.input_ref()?.clone();
        let ts_config = self.absolute_path(&input.ts_config_path)?;
        let mut session = ResolveSession::new_with_overlays(
            &ts_config,
            &input.ignore_file_extensions,
            input.shadow_mode,
            &self.overlays,
        )
        .map_err(|error| error.to_string())?;
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
            self.rebuild_graph()?;
            return Ok(true);
        }
        self.source_config_paths = summary.source_config_paths;
        Ok(false)
    }

    fn collect_affected_path(
        &mut self,
        path: &Path,
        affected: &mut FxHashSet<PathId>,
    ) -> Result<(), String> {
        let path_id = self
            .interner
            .intern_relative(&self.root_dir, path.to_string_lossy().as_ref())?;
        affected.insert(path_id);
        if let Some(importers) = self.reverse.get(&path_id) {
            affected.extend(importers.iter().copied());
        }
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

    fn refresh_incremental_module_assignments(
        &mut self,
        reached: &FxHashSet<PathId>,
    ) -> Result<(), String> {
        self.module_assignment
            .retain(|file, _| reached.contains(file));
        for file in reached {
            if self.module_assignment.contains_key(file) {
                continue;
            }
            let module =
                closest_module(*file, &self.interner, &self.module_path_ids).ok_or_else(|| {
                    format!(
                        "could not assign file '{}' to a module",
                        self.interner.text(*file)
                    )
                })?;
            self.module_assignment.insert(*file, module);
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
        file_ids.sort_by(|left, right| {
            js_string_cmp(self.interner.text(*left), self.interner.text(*right))
        });
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

    fn analysis_engine_input(
        &self,
        tag_callback_results: Option<Vec<Vec<String>>>,
        rule_callback_results: Option<Vec<bool>>,
    ) -> Result<EngineInput, String> {
        let AnalysisScope::Incremental(affected) = &self.analysis_scope else {
            return self.engine_input(tag_callback_results, rule_callback_results);
        };
        let mut included = affected.clone();
        for source in affected {
            if let Some(imports) = self.forward.get(source) {
                included.extend(imports.iter().filter_map(|import| match import {
                    GraphImport::Module { target, .. } => Some(*target),
                    GraphImport::External { .. } | GraphImport::Unresolvable { .. } => None,
                }));
            }
        }
        let mut file_ids = included.into_iter().collect::<Vec<_>>();
        file_ids.sort_by(|left, right| {
            js_string_cmp(self.interner.text(*left), self.interner.text(*right))
        });
        let files = file_ids
            .into_iter()
            .map(|path| {
                let imports = affected
                    .contains(&path)
                    .then(|| self.forward.get(&path))
                    .flatten()
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
        let input = self.input_ref()?;
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

    fn run_engine_analysis(&self, input: EngineInput) -> Result<AnalyzeResult, String> {
        match self.analysis_scope {
            AnalysisScope::Full => engine::analyze(input),
            AnalysisScope::Incremental(_) => engine::analyze_with_module_tags(input, |path| {
                self.interner
                    .id(path)
                    .and_then(|path| self.module_tags.get(&path))
                    .cloned()
            }),
        }
    }

    fn drive_analysis(&mut self) -> Result<String, String> {
        let first_input = self.analysis_engine_input(None, None)?;
        self.last_analysis_file_count = first_input.files.len();
        let first = self.run_engine_analysis(first_input)?;
        if matches!(first, AnalyzeResult::Complete(_)) {
            return self.finish_analysis(first);
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

        let second_input = self.analysis_engine_input(tag_results.clone(), None)?;
        self.last_analysis_file_count = second_input.files.len();
        let second = self.run_engine_analysis(second_input)?;
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
            let complete_input = self.analysis_engine_input(tag_results, rule_results)?;
            self.last_analysis_file_count = complete_input.files.len();
            self.run_engine_analysis(complete_input)?
        } else {
            second
        };
        if !matches!(complete, AnalyzeResult::Complete(_)) {
            return Err("callback materialization did not converge".to_owned());
        }
        self.finish_analysis(complete)
    }

    fn finish_analysis(&mut self, complete: AnalyzeResult) -> Result<String, String> {
        let output = serde_json::to_string(&complete)
            .map_err(|error| format!("could not serialize analysis output: {error}"))?;
        self.pending_callbacks = None;
        self.capture_module_tags(&output)?;
        let value: Value = serde_json::from_str(&output)
            .map_err(|error| format!("could not cache analysis output: {error}"))?;
        self.cache_file_violations(&value)?;
        self.merged_analysis_output(&value)
    }

    fn cache_file_violations(&mut self, output: &Value) -> Result<(), String> {
        let reached = self.reached_files();
        let affected = match &self.analysis_scope {
            AnalysisScope::Full => {
                self.file_violations.clear();
                reached.clone()
            }
            AnalysisScope::Incremental(affected) => affected.clone(),
        };
        self.file_violations
            .retain(|file, _| reached.contains(file));
        for file in &affected {
            self.file_violations
                .insert(*file, CachedFileViolations::default());
        }
        for (category, field) in [
            ("dependency", ViolationCategory::Dependency),
            ("encapsulation", ViolationCategory::Encapsulation),
            ("external", ViolationCategory::External),
        ] {
            for violation in output["violations"][category]
                .as_array()
                .into_iter()
                .flatten()
            {
                let path = violation["file"]
                    .as_str()
                    .ok_or_else(|| format!("{category} violation has no file"))?;
                let file = self.interner.intern_relative(&self.root_dir, path)?;
                if !affected.contains(&file) {
                    continue;
                }
                let cached = self.file_violations.entry(file).or_default();
                match field {
                    ViolationCategory::Dependency => cached.dependency.push(violation.clone()),
                    ViolationCategory::Encapsulation => {
                        cached.encapsulation.push(violation.clone());
                    }
                    ViolationCategory::External => cached.external.push(violation.clone()),
                }
            }
        }
        Ok(())
    }

    fn merged_analysis_output(&self, latest: &Value) -> Result<String, String> {
        let reached = self.reached_files();
        let mut dependency = Vec::new();
        let mut encapsulation = Vec::new();
        let mut external = Vec::new();
        for file in reached {
            if let Some(cached) = self.file_violations.get(&file) {
                dependency.extend(cached.dependency.iter().cloned());
                encapsulation.extend(cached.encapsulation.iter().cloned());
                external.extend(cached.external.iter().cloned());
            }
        }
        sort_json_records(&mut dependency)?;
        sort_json_records(&mut encapsulation)?;
        sort_json_records(&mut external)?;
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "files": self.reached_file_imports(),
            "modules": latest["modules"].clone(),
            "violations": {
                "dependency": dependency,
                "encapsulation": encapsulation,
                "external": external,
            },
        }))
        .map_err(|error| format!("could not serialize cached analysis output: {error}"))
    }

    fn reached_file_imports(&self) -> Vec<Value> {
        let mut files = self.reached_files().into_iter().collect::<Vec<_>>();
        files.sort_by(|left, right| {
            js_string_cmp(self.interner.text(*left), self.interner.text(*right))
        });
        files
            .into_iter()
            .map(|path| {
                let imports = self
                    .forward
                    .get(&path)
                    .into_iter()
                    .flatten()
                    .map(|import| match import {
                        GraphImport::Module { raw, target } => json!({
                            "raw": raw,
                            "kind": "module",
                            "resolvedPath": self.interner.text(*target),
                        }),
                        GraphImport::External { raw } => json!({
                            "raw": raw,
                            "kind": "external",
                        }),
                        GraphImport::Unresolvable { raw } => json!({
                            "raw": raw,
                            "kind": "unresolvable",
                        }),
                    })
                    .collect::<Vec<_>>();
                json!({
                    "path": self.interner.text(path),
                    "imports": imports,
                })
            })
            .collect()
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
            let base = std::env::current_dir()
                .map_err(|error| format!("could not read current directory: {error}"))?;
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
    // matcherId remains in the serialized key, so decisions from different
    // configured callbacks cannot alias even when their contexts are equal.
    // Only the batch-local position is intentionally ignored.
    candidate
        .as_object_mut()
        .ok_or_else(|| "callback candidate is not an object".to_owned())?
        .remove("candidateIndex");
    serde_json::to_string(&candidate)
        .map_err(|error| format!("could not key callback candidate: {error}"))
}

fn closest_module(
    file: PathId,
    interner: &PathInterner,
    module_paths: &FxHashSet<PathId>,
) -> Option<PathId> {
    let mut candidate = interner.text(file);
    loop {
        if let Some(id) = interner.id(candidate)
            && module_paths.contains(&id)
        {
            return Some(id);
        }
        if candidate == "." {
            return None;
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

fn sort_json_records(records: &mut [Value]) -> Result<(), String> {
    let mut serialization_error = None;
    records.sort_by(|left, right| {
        match (serde_json::to_string(left), serde_json::to_string(right)) {
            (Ok(left), Ok(right)) => left.encode_utf16().cmp(right.encode_utf16()),
            (Err(error), _) | (_, Err(error)) => {
                serialization_error = Some(error.to_string());
                Ordering::Equal
            }
        }
    });
    serialization_error.map_or(Ok(()), Err)
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

fn normalize_handle_paths(input: &mut ProjectHandleInput) -> Result<(), String> {
    let current_dir = std::env::current_dir()
        .map_err(|error| format!("could not read current directory: {error}"))?;
    let normalize = |path: &str| {
        let path = PathBuf::from(path);
        let absolute = if path.is_absolute() {
            path
        } else {
            current_dir.join(path)
        };
        normalize_lexically(&absolute)
            .to_string_lossy()
            .into_owned()
    };
    input.entry_file = normalize(&input.entry_file);
    input.ts_config_path = normalize(&input.ts_config_path);
    input.sheriff_config_paths = input
        .sheriff_config_paths
        .iter()
        .map(|path| normalize(path))
        .collect();
    Ok(())
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
            Self::at(root)
        }

        fn at(root: PathBuf) -> Self {
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
            let changes = if matches!(operation, 1..=3) {
                json!({
                    "schemaVersion": 1,
                    "events": events,
                    "modulePaths": [
                        {"path": project.root.join("src/a"), "isBarrel": false},
                        {"path": project.root.join("src/b"), "isBarrel": false},
                        {"path": project.root.join("src/c"), "isBarrel": false},
                    ],
                })
            } else {
                json!({"schemaVersion":1,"events":events})
            };
            let incremental_output = incremental.apply_changes(changes.to_string());
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
    fn reached_files_use_the_stateless_utf16_path_order() {
        let project = TestProject::new();
        fs::write(
            &project.entry,
            "import './\u{10000}';\nimport './\u{e000}';\n",
        )
        .unwrap();
        fs::write(project.root.join("src/\u{10000}.ts"), "export {};\n").unwrap();
        fs::write(project.root.join("src/\u{e000}.ts"), "export {};\n").unwrap();

        let handle = ProjectHandle::new(project.input());
        let reached: Value = serde_json::from_str(&handle.get_reached_files()).unwrap();
        let output: Value = serde_json::from_str(&handle.get_result()).unwrap();
        let output_paths = output["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        let expected = vec!["src/entry.ts", "src/\u{10000}.ts", "src/\u{e000}.ts"];

        assert_eq!(reached["files"], json!(expected));
        assert_eq!(output_paths, expected);
    }

    #[test]
    fn empty_module_paths_still_discovers_reached_files() {
        let project = TestProject::new();
        let mut input: Value = serde_json::from_str(&project.input()).unwrap();
        input["modulePaths"] = json!([]);

        let handle = ProjectHandle::new(input.to_string());
        let reached: Value = serde_json::from_str(&handle.get_reached_files()).unwrap();

        assert_eq!(
            reached["files"],
            json!(["src/a/a.ts", "src/b/b.ts", "src/entry.ts"])
        );
    }

    #[test]
    fn setting_module_paths_matches_one_shot_analysis_byte_for_byte() {
        let project = TestProject::new();
        let input: Value = serde_json::from_str(&project.input()).unwrap();
        let one_shot = ProjectHandle::new(input.to_string()).get_result();
        let module_paths = input["modulePaths"].clone();
        let mut discovery_input = input;
        discovery_input["modulePaths"] = json!([]);
        let mut two_phase = ProjectHandle::new(discovery_input.to_string());

        let result = two_phase
            .set_module_paths(json!({"schemaVersion": 1, "modulePaths": module_paths}).to_string());

        assert_eq!(result, one_shot);
        assert_eq!(two_phase.get_result(), one_shot);
    }

    #[test]
    fn tsconfig_overlay_rebuilds_resolution_from_overlay_bytes() {
        let project = TestProject::new();
        fs::write(
            &project.config,
            r#"{"compilerOptions":{"baseUrl":".","paths":{"@x":["src/b/b.ts"]}}}"#,
        )
        .unwrap();
        fs::write(&project.entry, "import '@x';\n").unwrap();
        let input = project.input();
        let mut incremental = ProjectHandle::new(input.clone());
        assert!(incremental.get_reached_files().contains("src/b/b.ts"));

        let overlaid_config =
            r#"{"compilerOptions":{"baseUrl":".","paths":{"@x":["src/c/c.ts"]}}}"#;
        let incremental_output = incremental.set_overlay(
            project.config.to_string_lossy().into_owned(),
            overlaid_config.to_owned(),
        );
        assert_complete(&incremental_output);
        assert!(incremental.get_reached_files().contains("src/c/c.ts"));

        fs::write(&project.config, overlaid_config).unwrap();
        let clean = ProjectHandle::new(input);
        assert_eq!(incremental_output, clean.get_result());
        assert_eq!(incremental.get_reached_files(), clean.get_reached_files());

        fs::write(
            &project.config,
            r#"{"compilerOptions":{"baseUrl":".","paths":{"@x":["src/b/b.ts"]}}}"#,
        )
        .unwrap();
        let cleared = incremental.clear_overlay(project.config.to_string_lossy().into_owned());
        let clean = ProjectHandle::new(project.input());
        assert_eq!(cleared, clean.get_result());
        assert_eq!(incremental.get_reached_files(), clean.get_reached_files());
    }

    #[test]
    fn package_overlay_set_and_clear_match_materialized_clean_rebuilds() {
        let project = TestProject::new();
        fs::write(&project.entry, "import 'virtual-library';\n").unwrap();
        let input = project.input();
        let mut incremental = ProjectHandle::new(input.clone());
        let disk_result = incremental.get_result();
        let overlaid_manifest = r#"{"name":"r4-test","dependencies":{"virtual-library":"1.0.0"}}"#;
        let overlaid = incremental.set_overlay(
            project.package.to_string_lossy().into_owned(),
            overlaid_manifest.to_owned(),
        );
        assert_complete(&overlaid);
        fs::write(&project.package, overlaid_manifest).unwrap();
        assert_eq!(overlaid, ProjectHandle::new(input.clone()).get_result());

        fs::write(&project.package, r#"{"name":"r4-test"}"#).unwrap();
        let cleared = incremental.clear_overlay(project.package.to_string_lossy().into_owned());
        assert_eq!(cleared, disk_result);
        assert_eq!(cleared, ProjectHandle::new(input).get_result());
    }

    #[test]
    fn barrel_add_and_remove_match_refreshed_clean_module_discovery() {
        let project = TestProject::new();
        fs::create_dir_all(project.root.join("src/source")).unwrap();
        fs::create_dir_all(project.root.join("src/target")).unwrap();
        let source = project.root.join("src/source/entry.ts");
        let target = project.root.join("src/target/public.ts");
        let barrel = project.root.join("src/target/index.ts");
        fs::write(&source, "import '../target/public';\n").unwrap();
        fs::write(&target, "export const publicValue = true;\n").unwrap();
        let make_input = |is_barrel: bool| {
            json!({
                "schemaVersion": 1,
                "entryFile": source,
                "tsConfigPath": project.config,
                "modulePaths": [
                    {"path": project.root.join("src/source"), "isBarrel": false},
                    {"path": project.root.join("src/target"), "isBarrel": is_barrel},
                ],
                "moduleConfig": {"src/source": "source", "src/target": "target"},
                "autoTagging": true,
                "depRules": {"*": "*"},
                "denyRules": {},
                "externalRules": {},
                "encapsulationPattern": "internal",
                "enableBarrelLess": true,
            })
            .to_string()
        };
        let mut incremental = ProjectHandle::new(make_input(false));
        let initial = incremental.get_result();
        fs::write(&barrel, "export * from './public';\n").unwrap();
        let added = incremental.apply_changes(
            json!({
                "schemaVersion": 1,
                "events": [{"kind":"created", "path":barrel}],
                "modulePaths": [
                    {"path": project.root.join("src/source"), "isBarrel": false},
                    {"path": project.root.join("src/target"), "isBarrel": true},
                ],
            })
            .to_string(),
        );
        assert_eq!(added, ProjectHandle::new(make_input(true)).get_result());
        assert!(added.contains("encapsulation"));
        assert!(added.contains("src/target/public.ts"));

        fs::remove_file(&barrel).unwrap();
        let removed = incremental.apply_changes(
            json!({
                "schemaVersion": 1,
                "events": [{"kind":"deleted", "path":barrel}],
                "modulePaths": [
                    {"path": project.root.join("src/source"), "isBarrel": false},
                    {"path": project.root.join("src/target"), "isBarrel": false},
                ],
            })
            .to_string(),
        );
        assert_eq!(removed, initial);
        assert_eq!(removed, ProjectHandle::new(make_input(false)).get_result());
    }

    #[test]
    fn relative_constructor_paths_remain_stable_across_rebuilds() {
        let current = std::env::current_dir().unwrap();
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let project = TestProject::at(
            current
                .join("target")
                .join(format!("sheriff-r4-relative-{}-{id}", std::process::id())),
        );
        let mut input: Value = serde_json::from_str(&project.input()).unwrap();
        input["entryFile"] = Value::from(
            project
                .entry
                .strip_prefix(&current)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        input["tsConfigPath"] = Value::from(
            project
                .config
                .strip_prefix(&current)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        );
        let input = input.to_string();
        let mut incremental = ProjectHandle::new(input.clone());
        assert_complete(&incremental.get_result());
        let created = project.root.join("src/new.ts");
        fs::write(&created, "export const created = true;\n").unwrap();
        let rebuilt = incremental.apply_changes(
            json!({
                "schemaVersion": 1,
                "events": [{"kind":"created", "path":created}],
                "modulePaths": [
                    {"path": project.root.join("src/a"), "isBarrel": false},
                    {"path": project.root.join("src/b"), "isBarrel": false},
                    {"path": project.root.join("src/c"), "isBarrel": false},
                ],
            })
            .to_string(),
        );
        assert_complete(&rebuilt);
        assert_eq!(rebuilt, ProjectHandle::new(input).get_result());
    }

    #[test]
    fn structural_event_without_refreshed_module_paths_is_an_error() {
        let project = TestProject::new();
        fs::create_dir_all(project.root.join("src/source")).unwrap();
        fs::create_dir_all(project.root.join("src/target")).unwrap();
        let source = project.root.join("src/source/entry.ts");
        let target = project.root.join("src/target/public.ts");
        fs::write(&source, "import '../target/public';\n").unwrap();
        fs::write(&target, "export const publicValue = true;\n").unwrap();
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
            "depRules": {"*": "*"},
            "denyRules": {},
            "externalRules": {},
            "encapsulationPattern": "internal",
            "enableBarrelLess": true,
        })
        .to_string();
        let mut handle = ProjectHandle::new(input);
        assert_complete(&handle.get_result());
        let barrel = project.root.join("src/target/index.ts");
        fs::write(&barrel, "export * from './public';\n").unwrap();
        let output = handle.apply_changes(
            json!({
                "schemaVersion": 1,
                "events": [{"kind":"created", "path":barrel}],
            })
            .to_string(),
        );
        let error: Value = serde_json::from_str(&output).unwrap();
        assert!(
            error["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("modulePaths")),
            "{output}"
        );
    }

    #[test]
    fn source_edit_rechecks_fewer_files_than_the_reached_graph() {
        let project = TestProject::new();
        let input = project.input();
        let mut handle = ProjectHandle::new(input.clone());
        assert_complete(&handle.get_result());
        let changed = project.root.join("src/b/b.ts");
        fs::write(&changed, "export const b = 2;\n").unwrap();
        let incremental = handle.apply_changes(
            json!({
                "schemaVersion": 1,
                "events": [{"kind":"modified", "path":changed}],
            })
            .to_string(),
        );
        assert_complete(&incremental);
        assert!(
            handle.last_analysis_file_count < handle.reached_files().len(),
            "source edit checked {} files from a {}-file graph",
            handle.last_analysis_file_count,
            handle.reached_files().len()
        );
        assert_eq!(incremental, ProjectHandle::new(input).get_result());
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
        let mut expected = FxHashMap::<PathId, FxHashSet<PathId>>::default();
        for (source, imports) in &handle.forward {
            for import in imports {
                if let GraphImport::Module { target, .. } = import {
                    expected.entry(*target).or_default().insert(*source);
                }
            }
        }
        assert_eq!(
            handle.reverse, expected,
            "reverse edges contain a missing or stale entry"
        );
    }
}
