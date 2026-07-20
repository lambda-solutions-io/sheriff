use std::cmp::Ordering;

use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHashSet};
use serde::Serialize;

use crate::input::{EncapsulationPattern, EngineInput, ImportKind, InputModulePath};
use crate::paths::{PathId, PathInterner};
use crate::rules::{
    is_dependency_allowed, is_dependency_denied, is_external_allowed, wildcard_matches,
};
use crate::tags::calculate_tags;

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
    Unresolvable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineOutput {
    schema_version: u32,
    modules: Vec<OutputModule>,
    violations: OutputViolations,
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

pub fn analyze(input: EngineInput) -> Result<EngineOutput, String> {
    if input.schema_version != 1 {
        return Err(format!(
            "unsupported schemaVersion {}; expected 1",
            input.schema_version
        ));
    }

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

    let mut modules = Vec::with_capacity(module_inputs.len());
    let mut module_by_path = FxHashMap::default();
    for module_input in module_inputs {
        let path = interner.intern_relative(&input.root_dir, &module_input.path)?;
        if module_by_path.contains_key(&path) {
            return Err(format!(
                "duplicate discovered module path '{}'",
                interner.text(path)
            ));
        }
        let tags = calculate_tags(
            interner.text(path),
            &input.module_config,
            input.auto_tagging,
        )?;
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
                ImportKind::Unresolvable => imports.push(ImportData::Unresolvable),
            }
        }
        files.push(FileData {
            path,
            module,
            imports,
        });
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
        enable_barrel_less,
        exclude_root: input.exclude_root,
        encapsulation_pattern: &encapsulation_pattern,
        barrel_file_name: &input.barrel_file_name,
    };

    let checked: Vec<Result<FileViolations, String>> = files
        .par_iter()
        .map(|file| check_file(file, &context))
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

    Ok(EngineOutput {
        schema_version: 1,
        modules: output_modules,
        violations,
    })
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
    external_rules: &'a crate::input::OrderedMap<Vec<String>>,
    enable_barrel_less: bool,
    exclude_root: bool,
    encapsulation_pattern: &'a CompiledEncapsulationPattern,
    barrel_file_name: &'a str,
}

fn check_file(file: &FileData, context: &CheckContext<'_>) -> Result<FileViolations, String> {
    let mut output = FileViolations::default();
    let from_module = &context.modules[file.module];

    for import in &file.imports {
        match import {
            ImportData::Module { raw, target } => {
                let target_file = &context.files[*target];
                let to_module = &context.modules[target_file.module];
                if file.module != target_file.module {
                    check_dependency(
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
                for from_tag in &from_module.tags {
                    if !is_external_allowed(from_tag, raw, context.external_rules) {
                        output.external.push(ExternalViolation {
                            file: context.interner.text(file.path).to_owned(),
                            external_library: raw.clone(),
                            from_tag: from_tag.clone(),
                        });
                        break;
                    }
                }
            }
            ImportData::Unresolvable => {}
        }
    }

    deduplicate_external_violations(&mut output.external);
    deduplicate_encapsulation_violations(&mut output.encapsulation);
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
fn check_dependency(
    file: &FileData,
    raw: &str,
    target_file: &FileData,
    from_module: &ModuleData,
    to_module: &ModuleData,
    context: &CheckContext<'_>,
    output: &mut FileViolations,
) -> Result<(), String> {
    for from_tag in &from_module.tags {
        let allowed = is_dependency_allowed(from_tag, &to_module.tags, context.dep_rules)?;
        let cause = if !allowed {
            None
        } else if is_dependency_denied(from_tag, &to_module.tags, context.deny_rules) {
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

fn js_string_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze_json(json: &str) -> EngineOutput {
        analyze(serde_json::from_str(json).unwrap()).unwrap()
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
