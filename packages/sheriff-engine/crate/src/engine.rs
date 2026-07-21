use std::cmp::Ordering;
use std::path::{Component, Path, PathBuf};

use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Serialize;

use crate::input::{
    EncapsulationPattern, EngineInput, ImportKind, InputModulePath, MAX_CALLBACK_CANDIDATES,
    OrderedMap, RuleMatcher, RuleValue,
};
use crate::paths::{PathId, PathInterner};
use crate::rules::{
    is_dependency_allowed, is_dependency_denied, is_external_allowed, wildcard_matches,
};
use crate::tags::{CalculatedTags, calculate_tags_with_callbacks, replace_tags};

type ModuleTagLookup<'a> = dyn Fn(&str) -> Option<Vec<String>> + 'a;

#[derive(Debug)]
struct ModuleData {
    path: PathId,
    is_barrel: bool,
    encapsulated_folder: Option<String>,
    exports: Option<Vec<String>>,
    tags: Vec<String>,
}

#[derive(Debug)]
struct FileData {
    path: PathId,
    module: usize,
    imports: Vec<ImportData>,
}

#[derive(Debug)]
enum ImportData {
    Module { raw: String, target: usize },
    External { raw: String },
    Unresolvable { raw: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOutput {
    schema_version: u32,
    files: Vec<OutputFile>,
    modules: Vec<OutputModule>,
    violations: OutputViolations,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputFile {
    path: String,
    imports: Vec<OutputImport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputImport {
    raw: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_path: Option<String>,
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum AnalyzeResult {
    Complete(EngineOutput),
    TagCallbacks(TagCallbackOutput),
    RuleCallbacks(RuleCallbackOutput),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCallbackOutput {
    schema_version: u32,
    tag_callback_candidates: Vec<TagCallbackCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagCallbackCandidate {
    candidate_index: usize,
    matcher_id: u32,
    module_id: usize,
    module_path: String,
    placeholders: Vec<(String, String)>,
    matcher_context: TagMatcherContext,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagMatcherContext {
    segment: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    regex_source: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleCallbackOutput {
    schema_version: u32,
    rule_callback_candidates: Vec<RuleCallbackCandidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuleCallbackCandidate {
    candidate_index: usize,
    matcher_id: u32,
    context: RuleCallbackContext,
}

#[derive(Serialize)]
#[serde(untagged)]
enum RuleCallbackContext {
    Dependency(DependencyCallbackContext),
    External(ExternalCallbackContext),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyCallbackContext {
    from_module_path: String,
    to_module_path: String,
    from_file_path: String,
    to_file_path: String,
    from_tags: Vec<String>,
    to_tags: Vec<String>,
    from: String,
    to: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalCallbackContext {
    from_tags: Vec<String>,
    from_module_path: String,
    from_file_path: String,
    from: String,
    external_library: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputModule {
    path: String,
    tags: Vec<String>,
    is_barrel: bool,
}

#[derive(Debug, Default, Serialize)]
struct OutputViolations {
    dependency: Vec<DependencyViolation>,
    encapsulation: Vec<EncapsulationViolation>,
    external: Vec<ExternalViolation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DependencyViolation {
    file: String,
    raw_import: String,
    from_module_path: String,
    to_module_path: String,
    to_file_path: String,
    from_tag: String,
    to_tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cause: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EncapsulationViolation {
    file: String,
    raw_import: String,
    to_file_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalViolation {
    file: String,
    external_library: String,
    from_tag: String,
}

#[derive(Default)]
struct FileViolations {
    dependency: Vec<DependencyViolation>,
    encapsulation: Vec<EncapsulationViolation>,
    external: Vec<ExternalViolation>,
}

pub fn analyze(input: EngineInput) -> Result<AnalyzeResult, String> {
    analyze_inner(input, None)
}

pub(crate) fn analyze_with_module_tags(
    input: EngineInput,
    module_tags: impl Fn(&str) -> Option<Vec<String>>,
) -> Result<AnalyzeResult, String> {
    analyze_inner(input, Some(&module_tags))
}

fn analyze_inner(
    input: EngineInput,
    precomputed_module_tags: Option<&ModuleTagLookup<'_>>,
) -> Result<AnalyzeResult, String> {
    if input.schema_version != 1 {
        return Err(format!(
            "unsupported schemaVersion {}; expected 1",
            input.schema_version
        ));
    }

    let callback_root_dir =
        normalize_lexically(&std::path::absolute(&input.root_dir).map_err(|error| {
            format!(
                "could not make rootDir '{}' absolute for callback contexts: {error}",
                input.root_dir
            )
        })?);
    let mut interner = PathInterner::default();
    let mut file_paths = Vec::with_capacity(input.files.len());
    let mut file_by_path = FxHashMap::default();
    for (index, file) in input.files.iter().enumerate() {
        let path = interner.intern_relative(&input.root_dir, &file.path)?;
        if file_by_path.insert(path, index).is_some() {
            return Err(format!(
                "duplicate input file path '{}'",
                interner.text(path)
            ));
        }
        file_paths.push(path);
    }

    let root_path = interner.intern_relative(&input.root_dir, &input.root_dir)?;
    let mut module_inputs = Vec::with_capacity(input.module_paths.len() + 1);
    for module in input.module_paths {
        let path = interner.intern_relative(&input.root_dir, &module.path)?;
        if path != root_path {
            module_inputs.push(module);
        }
    }
    module_inputs.push(InputModulePath {
        path: input.root_dir.clone(),
        is_barrel: false,
        encapsulated_folder: None,
        exports: None,
    });

    let enable_barrel_less = input.enable_barrel_less;

    let tag_callback_results = input.tag_callback_results.clone();
    let rule_callback_results = input.rule_callback_results.clone();
    let mut tag_callback_candidates = Vec::new();
    let mut modules = Vec::with_capacity(module_inputs.len());
    let mut module_by_path = FxHashMap::default();
    for (module_id, module_input) in module_inputs.into_iter().enumerate() {
        let path = interner.intern_relative(&input.root_dir, &module_input.path)?;
        if module_by_path.contains_key(&path) {
            return Err(format!(
                "duplicate discovered module path '{}'",
                interner.text(path)
            ));
        }
        let calculated = precomputed_module_tags
            .and_then(|get_tags| get_tags(interner.text(path)))
            .map(CalculatedTags::Tags)
            .map_or_else(
                || {
                    calculate_tags_with_callbacks(
                        interner.text(path),
                        &input.module_config,
                        input.auto_tagging,
                    )
                },
                Ok,
            )?;
        let tags = match calculated {
            CalculatedTags::Tags(tags) => tags,
            CalculatedTags::Callback(callback) => {
                let candidate_index = tag_callback_candidates.len();
                let tags = tag_callback_results
                    .as_ref()
                    .and_then(|results| results.get(candidate_index))
                    .map(|tags| replace_tags(tags, &callback.placeholders, interner.text(path)))
                    .transpose()?
                    .unwrap_or_default();
                tag_callback_candidates.push(TagCallbackCandidate {
                    candidate_index,
                    matcher_id: callback.matcher_id,
                    module_id,
                    module_path: interner.text(path).to_owned(),
                    placeholders: callback.placeholders,
                    matcher_context: TagMatcherContext {
                        segment: callback.segment,
                        regex_source: callback.regex_source,
                    },
                });
                tags
            }
        };
        let module_index = modules.len();
        modules.push(ModuleData {
            path,
            is_barrel: module_input.is_barrel,
            encapsulated_folder: module_input.encapsulated_folder,
            exports: module_input.exports,
            tags,
        });
        module_by_path.insert(path, module_index);
    }

    if !tag_callback_candidates.is_empty() && tag_callback_results.is_none() {
        return Ok(AnalyzeResult::TagCallbacks(TagCallbackOutput {
            schema_version: 1,
            tag_callback_candidates,
        }));
    }
    if tag_callback_results.as_ref().map(Vec::len).unwrap_or(0) != tag_callback_candidates.len() {
        return Err(format!(
            "tag callback result count {} does not match candidate count {}",
            tag_callback_results.as_ref().map(Vec::len).unwrap_or(0),
            tag_callback_candidates.len()
        ));
    }

    let mut files = Vec::with_capacity(input.files.len());
    for (index, input_file) in input.files.into_iter().enumerate() {
        let path = file_paths[index];
        let module = find_closest_module(path, &interner, &module_by_path).ok_or_else(|| {
            format!(
                "could not assign file '{}' to a discovered module",
                interner.text(path)
            )
        })?;
        let mut imports = Vec::with_capacity(input_file.imports.len());
        for input_import in input_file.imports {
            match input_import.kind {
                ImportKind::Module => {
                    let resolved_path = input_import.resolved_path.ok_or_else(|| {
                        format!(
                            "module import '{}' in '{}' has no resolvedPath",
                            input_import.raw,
                            interner.text(path)
                        )
                    })?;
                    let target_path = interner.intern_relative(&input.root_dir, &resolved_path)?;
                    let target = file_by_path.get(&target_path).copied().ok_or_else(|| {
                        format!(
                            "resolvedPath '{}' for import '{}' is not present in files",
                            interner.text(target_path),
                            input_import.raw
                        )
                    })?;
                    imports.push(ImportData::Module {
                        raw: input_import.raw,
                        target,
                    });
                }
                ImportKind::External => imports.push(ImportData::External {
                    raw: input_import.raw,
                }),
                ImportKind::Unresolvable => imports.push(ImportData::Unresolvable {
                    raw: input_import.raw,
                }),
            }
        }
        files.push(FileData {
            path,
            module,
            imports,
        });
    }

    let (rule_callback_candidates, callback_slots) = collect_rule_callback_candidates(
        &files,
        &modules,
        &interner,
        &input.dep_rules,
        &input.deny_rules,
        &input.external_rules,
        &callback_root_dir,
    )?;
    if !rule_callback_candidates.is_empty() && rule_callback_results.is_none() {
        return Ok(AnalyzeResult::RuleCallbacks(RuleCallbackOutput {
            schema_version: 1,
            rule_callback_candidates,
        }));
    }
    if rule_callback_results.as_ref().map(Vec::len).unwrap_or(0) != rule_callback_candidates.len() {
        return Err(format!(
            "rule callback result count {} does not match candidate count {}",
            rule_callback_results.as_ref().map(Vec::len).unwrap_or(0),
            rule_callback_candidates.len()
        ));
    }

    let encapsulation_pattern =
        CompiledEncapsulationPattern::new(input.encapsulation_pattern.as_ref())?;
    let context = CheckContext {
        interner: &interner,
        modules: &modules,
        files: &files,
        dep_rules: &input.dep_rules,
        deny_rules: &input.deny_rules,
        external_rules: &input.external_rules,
        rule_callback_results: rule_callback_results.as_deref().unwrap_or(&[]),
        callback_slots: &callback_slots,
        enable_barrel_less,
        exclude_root: input.exclude_root,
        encapsulation_pattern: &encapsulation_pattern,
        barrel_file_name: &input.barrel_file_name,
    };

    let checked: Vec<Result<FileViolations, String>> = files
        .par_iter()
        .enumerate()
        .map(|(file_index, file)| check_file(file_index, file, &context))
        .collect();
    let mut violations = OutputViolations::default();
    for result in checked {
        let mut file_violations = result?;
        violations
            .dependency
            .append(&mut file_violations.dependency);
        violations
            .encapsulation
            .append(&mut file_violations.encapsulation);
        violations.external.append(&mut file_violations.external);
    }

    sort_records(&mut violations.dependency)?;
    sort_records(&mut violations.encapsulation)?;
    sort_records(&mut violations.external)?;

    let mut output_modules = modules
        .iter()
        .map(|module| {
            let mut tags = module.tags.clone();
            tags.sort_by(|left, right| js_string_cmp(left, right));
            OutputModule {
                path: interner.text(module.path).to_owned(),
                tags,
                is_barrel: module.is_barrel,
            }
        })
        .collect::<Vec<_>>();
    sort_records(&mut output_modules)?;

    let mut output_files = files
        .iter()
        .map(|file| OutputFile {
            path: interner.text(file.path).to_owned(),
            imports: file
                .imports
                .iter()
                .map(|import| match import {
                    ImportData::Module { raw, target } => OutputImport {
                        raw: raw.clone(),
                        kind: "module",
                        resolved_path: Some(interner.text(files[*target].path).to_owned()),
                    },
                    ImportData::External { raw } => OutputImport {
                        raw: raw.clone(),
                        kind: "external",
                        resolved_path: None,
                    },
                    ImportData::Unresolvable { raw } => OutputImport {
                        raw: raw.clone(),
                        kind: "unresolvable",
                        resolved_path: None,
                    },
                })
                .collect(),
        })
        .collect::<Vec<_>>();
    output_files.sort_by(|left, right| js_string_cmp(&left.path, &right.path));

    Ok(AnalyzeResult::Complete(EngineOutput {
        schema_version: 1,
        files: output_files,
        modules: output_modules,
        violations,
    }))
}

fn find_closest_module(
    path: PathId,
    interner: &PathInterner,
    modules: &FxHashMap<PathId, usize>,
) -> Option<usize> {
    let mut candidate = interner.text(path);
    loop {
        if let Some(path_id) = interner.id(candidate)
            && let Some(module) = modules.get(&path_id)
        {
            return Some(*module);
        }
        if candidate == "." {
            break;
        }
        let separator = candidate
            .rfind('/')
            .into_iter()
            .chain(candidate.rfind('\\'))
            .max();
        candidate = separator
            .filter(|index| *index > 0)
            .map_or(".", |index| &candidate[..index]);
    }
    None
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum RuleCategory {
    Dependency,
    Deny,
    External,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct CallbackSlot {
    category: RuleCategory,
    file_index: usize,
    import_index: usize,
    from_tag_index: usize,
    to_tag_index: usize,
    rule_index: usize,
    matcher_index: usize,
}

fn collect_rule_callback_candidates(
    files: &[FileData],
    modules: &[ModuleData],
    interner: &PathInterner,
    dep_rules: &OrderedMap<RuleValue>,
    deny_rules: &OrderedMap<RuleValue>,
    external_rules: &OrderedMap<RuleValue>,
    callback_root_dir: &Path,
) -> Result<(Vec<RuleCallbackCandidate>, FxHashMap<CallbackSlot, usize>), String> {
    let mut candidates = Vec::new();
    let mut slots = FxHashMap::default();
    for (file_index, file) in files.iter().enumerate() {
        let from_module = &modules[file.module];
        for (import_index, import) in file.imports.iter().enumerate() {
            match import {
                ImportData::Module { target, .. } => {
                    let target_file = &files[*target];
                    if file.module == target_file.module {
                        continue;
                    }
                    let to_module = &modules[target_file.module];
                    collect_dependency_candidates(
                        RuleCategory::Dependency,
                        dep_rules,
                        file_index,
                        import_index,
                        file,
                        target_file,
                        from_module,
                        to_module,
                        interner,
                        callback_root_dir,
                        &mut candidates,
                        &mut slots,
                    )?;
                    collect_dependency_candidates(
                        RuleCategory::Deny,
                        deny_rules,
                        file_index,
                        import_index,
                        file,
                        target_file,
                        from_module,
                        to_module,
                        interner,
                        callback_root_dir,
                        &mut candidates,
                        &mut slots,
                    )?;
                }
                ImportData::External { raw } => {
                    'from_tags: for (from_tag_index, from) in from_module.tags.iter().enumerate() {
                        for (rule_index, (from_pattern, rule)) in
                            external_rules.0.iter().enumerate()
                        {
                            if !wildcard_matches(from_pattern, from) {
                                continue;
                            }
                            let mut has_callback = false;
                            let mut is_statically_allowed = false;
                            for (matcher_index, matcher) in rule.matchers().iter().enumerate() {
                                match matcher {
                                    RuleMatcher::Static(pattern)
                                        if wildcard_matches(pattern, raw) =>
                                    {
                                        is_statically_allowed = true;
                                        break;
                                    }
                                    RuleMatcher::Callback(matcher_id) => {
                                        has_callback = true;
                                        let slot = CallbackSlot {
                                            category: RuleCategory::External,
                                            file_index,
                                            import_index,
                                            from_tag_index,
                                            to_tag_index: 0,
                                            rule_index,
                                            matcher_index,
                                        };
                                        push_rule_candidate(
                                            *matcher_id,
                                            RuleCallbackContext::External(
                                                ExternalCallbackContext {
                                                    from_tags: from_module.tags.clone(),
                                                    from_module_path: callback_path(
                                                        callback_root_dir,
                                                        interner.text(from_module.path),
                                                    ),
                                                    from_file_path: callback_path(
                                                        callback_root_dir,
                                                        interner.text(file.path),
                                                    ),
                                                    from: from.clone(),
                                                    external_library: raw.clone(),
                                                },
                                            ),
                                            slot,
                                            &mut candidates,
                                            &mut slots,
                                        )?;
                                    }
                                    RuleMatcher::Null | RuleMatcher::Static(_) => {}
                                }
                            }
                            if is_statically_allowed {
                                continue;
                            }
                            if !has_callback {
                                continue 'from_tags;
                            }
                        }
                    }
                }
                ImportData::Unresolvable { .. } => {}
            }
        }
    }
    Ok((candidates, slots))
}

#[allow(clippy::too_many_arguments)]
fn collect_dependency_candidates(
    category: RuleCategory,
    rules: &OrderedMap<RuleValue>,
    file_index: usize,
    import_index: usize,
    file: &FileData,
    target_file: &FileData,
    from_module: &ModuleData,
    to_module: &ModuleData,
    interner: &PathInterner,
    callback_root_dir: &Path,
    candidates: &mut Vec<RuleCallbackCandidate>,
    slots: &mut FxHashMap<CallbackSlot, usize>,
) -> Result<(), String> {
    'from_tags: for (from_tag_index, from) in from_module.tags.iter().enumerate() {
        for (rule_index, (from_pattern, rule)) in rules.0.iter().enumerate() {
            if !wildcard_matches(from_pattern, from) {
                continue;
            }
            for (to_tag_index, to) in to_module.tags.iter().enumerate() {
                for (matcher_index, matcher) in rule.matchers().iter().enumerate() {
                    match matcher {
                        RuleMatcher::Static(pattern) if wildcard_matches(pattern, to) => {
                            continue 'from_tags;
                        }
                        RuleMatcher::Callback(matcher_id) => {
                            let slot = CallbackSlot {
                                category,
                                file_index,
                                import_index,
                                from_tag_index,
                                to_tag_index,
                                rule_index,
                                matcher_index,
                            };
                            push_rule_candidate(
                                *matcher_id,
                                RuleCallbackContext::Dependency(DependencyCallbackContext {
                                    from_module_path: callback_path(
                                        callback_root_dir,
                                        interner.text(from_module.path),
                                    ),
                                    to_module_path: callback_path(
                                        callback_root_dir,
                                        interner.text(to_module.path),
                                    ),
                                    from_file_path: callback_path(
                                        callback_root_dir,
                                        interner.text(file.path),
                                    ),
                                    to_file_path: callback_path(
                                        callback_root_dir,
                                        interner.text(target_file.path),
                                    ),
                                    from_tags: from_module.tags.clone(),
                                    to_tags: to_module.tags.clone(),
                                    from: from.clone(),
                                    to: to.clone(),
                                }),
                                slot,
                                candidates,
                                slots,
                            )?;
                        }
                        RuleMatcher::Null | RuleMatcher::Static(_) => {}
                    }
                }
            }
        }
    }
    Ok(())
}

fn callback_path(root_dir: &Path, relative_path: &str) -> String {
    normalize_lexically(&root_dir.join(relative_path))
        .to_string_lossy()
        .into_owned()
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component);
            }
        }
    }
    normalized
}

fn push_rule_candidate(
    matcher_id: u32,
    context: RuleCallbackContext,
    slot: CallbackSlot,
    candidates: &mut Vec<RuleCallbackCandidate>,
    slots: &mut FxHashMap<CallbackSlot, usize>,
) -> Result<(), String> {
    if candidates.len() == MAX_CALLBACK_CANDIDATES {
        return Err(format!(
            "callback candidate count exceeds the {MAX_CALLBACK_CANDIDATES} limit"
        ));
    }
    let candidate_index = candidates.len();
    candidates.push(RuleCallbackCandidate {
        candidate_index,
        matcher_id,
        context,
    });
    let previous = slots.insert(slot, candidate_index);
    debug_assert!(previous.is_none());
    Ok(())
}

enum CompiledEncapsulationPattern {
    String(String),
    Regex {
        source: String,
        regex: fancy_regex::Regex,
    },
}

impl CompiledEncapsulationPattern {
    fn new(pattern: Option<&EncapsulationPattern>) -> Result<Self, String> {
        match pattern {
            Some(EncapsulationPattern::String(value)) => Ok(Self::String(value.clone())),
            Some(EncapsulationPattern::Regex { source, flags }) => Ok(Self::Regex {
                source: source.clone(),
                regex: crate::js_regex::compile(source, flags)?,
            }),
            None => Ok(Self::String("internal".to_owned())),
        }
    }
}

struct CheckContext<'a> {
    interner: &'a PathInterner,
    modules: &'a [ModuleData],
    files: &'a [FileData],
    dep_rules: &'a crate::input::OrderedMap<crate::input::RuleValue>,
    deny_rules: &'a crate::input::OrderedMap<crate::input::RuleValue>,
    external_rules: &'a OrderedMap<RuleValue>,
    rule_callback_results: &'a [bool],
    callback_slots: &'a FxHashMap<CallbackSlot, usize>,
    enable_barrel_less: bool,
    exclude_root: bool,
    encapsulation_pattern: &'a CompiledEncapsulationPattern,
    barrel_file_name: &'a str,
}

fn check_file(
    file_index: usize,
    file: &FileData,
    context: &CheckContext<'_>,
) -> Result<FileViolations, String> {
    let mut output = FileViolations::default();
    let from_module = &context.modules[file.module];

    for (import_index, import) in file.imports.iter().enumerate() {
        match import {
            ImportData::Module { raw, target } => {
                let target_file = &context.files[*target];
                let to_module = &context.modules[target_file.module];
                if file.module != target_file.module {
                    check_dependency(
                        file_index,
                        import_index,
                        file,
                        raw,
                        target_file,
                        from_module,
                        to_module,
                        context,
                        &mut output,
                    )?;
                    if !is_encapsulation_allowed(target_file, to_module, context)? {
                        output.encapsulation.push(EncapsulationViolation {
                            file: context.interner.text(file.path).to_owned(),
                            raw_import: raw.clone(),
                            to_file_path: context.interner.text(target_file.path).to_owned(),
                        });
                    }
                }
            }
            ImportData::External { raw } => {
                if context.external_rules.0.is_empty() {
                    continue;
                }
                for (from_tag_index, from_tag) in from_module.tags.iter().enumerate() {
                    if !is_external_allowed(
                        from_tag,
                        raw,
                        context.external_rules,
                        |rule_index, matcher_index, _| {
                            callback_decision(
                                context,
                                CallbackSlot {
                                    category: RuleCategory::External,
                                    file_index,
                                    import_index,
                                    from_tag_index,
                                    to_tag_index: 0,
                                    rule_index,
                                    matcher_index,
                                },
                            )
                        },
                    ) {
                        output.external.push(ExternalViolation {
                            file: context.interner.text(file.path).to_owned(),
                            external_library: raw.clone(),
                            from_tag: from_tag.clone(),
                        });
                        break;
                    }
                }
            }
            ImportData::Unresolvable { .. } => {}
        }
    }

    deduplicate_external_violations(&mut output.external);
    deduplicate_encapsulation_violations(&mut output.encapsulation);
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
fn check_dependency(
    file_index: usize,
    import_index: usize,
    file: &FileData,
    raw: &str,
    target_file: &FileData,
    from_module: &ModuleData,
    to_module: &ModuleData,
    context: &CheckContext<'_>,
    output: &mut FileViolations,
) -> Result<(), String> {
    for (from_tag_index, from_tag) in from_module.tags.iter().enumerate() {
        let allowed = is_dependency_allowed(
            from_tag,
            &to_module.tags,
            context.dep_rules,
            |rule_index, to_tag_index, matcher_index, _| {
                callback_decision(
                    context,
                    CallbackSlot {
                        category: RuleCategory::Dependency,
                        file_index,
                        import_index,
                        from_tag_index,
                        to_tag_index,
                        rule_index,
                        matcher_index,
                    },
                )
            },
        )?;
        let cause = if !allowed {
            None
        } else if is_dependency_denied(
            from_tag,
            &to_module.tags,
            context.deny_rules,
            |rule_index, to_tag_index, matcher_index, _| {
                callback_decision(
                    context,
                    CallbackSlot {
                        category: RuleCategory::Deny,
                        file_index,
                        import_index,
                        from_tag_index,
                        to_tag_index,
                        rule_index,
                        matcher_index,
                    },
                )
            },
        ) {
            Some("deny-rule")
        } else {
            continue;
        };

        let mut to_tags = to_module.tags.clone();
        to_tags.sort_by(|left, right| js_string_cmp(left, right));
        output.dependency.push(DependencyViolation {
            file: context.interner.text(file.path).to_owned(),
            raw_import: raw.to_owned(),
            from_module_path: context.interner.text(from_module.path).to_owned(),
            to_module_path: context.interner.text(to_module.path).to_owned(),
            to_file_path: context.interner.text(target_file.path).to_owned(),
            from_tag: from_tag.clone(),
            to_tags,
            cause,
        });
        break;
    }
    Ok(())
}

fn callback_decision(context: &CheckContext<'_>, slot: CallbackSlot) -> bool {
    let candidate_index = context.callback_slots[&slot];
    context.rule_callback_results[candidate_index]
}

fn is_encapsulation_allowed(
    target_file: &FileData,
    target_module: &ModuleData,
    context: &CheckContext<'_>,
) -> Result<bool, String> {
    if context.exclude_root && context.interner.text(target_module.path) == "." {
        return Ok(true);
    }

    let module_path = context.interner.text(target_module.path);
    let file_path = context.interner.text(target_file.path);
    if target_module.is_barrel {
        let barrel_path = if module_path == "." {
            context.barrel_file_name.to_owned()
        } else {
            format!("{module_path}/{}", context.barrel_file_name)
        };
        return Ok(file_path == barrel_path);
    }

    if !context.enable_barrel_less {
        return Ok(false);
    }

    let relative = if module_path == "." {
        file_path
    } else {
        file_path
            .strip_prefix(&format!("{module_path}/"))
            .unwrap_or(file_path)
    };
    if let Some(exports) = &target_module.exports {
        return Ok(exports
            .iter()
            .any(|pattern| file_pattern_matches(pattern, relative)));
    }

    let normalized_relative = relative.replace('\\', "/");
    if let Some(pattern) = target_module.encapsulated_folder.as_deref() {
        return Ok(!normalized_relative.starts_with(pattern));
    }
    match context.encapsulation_pattern {
        CompiledEncapsulationPattern::String(pattern) => {
            Ok(!normalized_relative.starts_with(pattern))
        }
        CompiledEncapsulationPattern::Regex { source, regex } => {
            crate::js_regex::has_match(regex, source, &normalized_relative).map(|matches| !matches)
        }
    }
}

fn file_pattern_matches(pattern: &str, path: &str) -> bool {
    let normalized_pattern = pattern.replace('\\', "/");
    let normalized_path = path.replace('\\', "/");
    let pattern_segments: Vec<&str> = normalized_pattern.split('/').collect();
    let path_segments: Vec<&str> = normalized_path.split('/').collect();
    pattern_segments.len() == path_segments.len()
        && pattern_segments
            .iter()
            .zip(path_segments)
            .all(|(pattern_segment, path_segment)| wildcard_matches(pattern_segment, path_segment))
}

fn deduplicate_external_violations(violations: &mut Vec<ExternalViolation>) {
    let mut seen = FxHashSet::default();
    violations.retain(|violation| seen.insert(violation.external_library.clone()));
}

fn deduplicate_encapsulation_violations(violations: &mut Vec<EncapsulationViolation>) {
    let mut last_by_raw = FxHashMap::default();
    for (index, violation) in violations.iter().enumerate() {
        last_by_raw.insert(violation.raw_import.clone(), index);
    }
    let mut index = 0;
    violations.retain(|violation| {
        let keep = last_by_raw.get(&violation.raw_import) == Some(&index);
        index += 1;
        keep
    });
}

fn sort_records<T: Serialize>(records: &mut [T]) -> Result<(), String> {
    let mut serialization_error = None;
    records.sort_by(|left, right| {
        let left = serde_json::to_string(left);
        let right = serde_json::to_string(right);
        match (left, right) {
            (Ok(left), Ok(right)) => js_string_cmp(&left, &right),
            (Err(error), _) | (_, Err(error)) => {
                serialization_error = Some(error.to_string());
                Ordering::Equal
            }
        }
    });
    serialization_error.map_or(Ok(()), Err)
}

pub(crate) fn js_string_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze_json(json: &str) -> EngineOutput {
        match analyze(serde_json::from_str(json).unwrap()).unwrap() {
            AnalyzeResult::Complete(output) => output,
            AnalyzeResult::TagCallbacks(_) | AnalyzeResult::RuleCallbacks(_) => {
                panic!("test input unexpectedly requires callback materialization")
            }
        }
    }

    #[test]
    fn assigns_files_only_on_module_path_segment_boundaries() {
        let mut interner = PathInterner::default();
        let root = interner.intern_relative(".", ".").unwrap();
        let module_b = interner.intern_relative(".", "src/a/b").unwrap();
        let module_bc = interner.intern_relative(".", "src/a/bc").unwrap();
        let inside_b = interner.intern_relative(".", "src/a/b/inside.ts").unwrap();
        let inside_bc = interner.intern_relative(".", "src/a/bc/x.ts").unwrap();
        let prefix_only = interner.intern_relative(".", "src/a/bx/x.ts").unwrap();
        let modules = FxHashMap::from_iter([(root, 0), (module_b, 1), (module_bc, 2)]);

        assert_eq!(find_closest_module(inside_b, &interner, &modules), Some(1));
        assert_eq!(find_closest_module(inside_bc, &interner, &modules), Some(2));
        assert_eq!(
            find_closest_module(prefix_only, &interner, &modules),
            Some(0)
        );
    }

    #[test]
    fn reports_allow_then_deny_once_per_import() {
        let output = analyze_json(
            r#"{
              "schemaVersion":1,
              "rootDir":".",
              "files":[
                {"path":"src/source/index.ts","imports":[{"raw":"../target","kind":"module","resolvedPath":"src/target/index.ts"}]},
                {"path":"src/target/index.ts","imports":[]}
              ],
              "modulePaths":[
                {"path":"src/source","isBarrel":true},
                {"path":"src/target","isBarrel":true}
              ],
              "moduleConfig":{"src/source":["source","second"],"src/target":"target"},
              "autoTagging":true,
              "depRules":{"source":"target","second":[]},
              "denyRules":{"source":"target"},
              "externalRules":{}
            }"#,
        );
        assert_eq!(output.violations.dependency.len(), 1);
        assert_eq!(output.violations.dependency[0].from_tag, "source");
        assert_eq!(output.violations.dependency[0].cause, Some("deny-rule"));
    }
}
