mod engine;
mod extract;
mod input;
mod js_regex;
mod js_replacement;
mod paths;
mod resolve;
mod rules;
mod tags;

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};

use napi_derive::napi;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorOutput {
    schema_version: u32,
    error: StructuredError,
}

#[derive(Serialize)]
struct StructuredError {
    code: &'static str,
    message: String,
}

#[napi(js_name = "analyzeProject")]
pub fn analyze_project(input_json: String) -> String {
    if input_json.len() > input::MAX_INPUT_JSON_BYTES {
        return error_json(
            "SHERIFF_ENGINE_LIMIT_EXCEEDED",
            format!(
                "input JSON exceeds the {} byte limit",
                input::MAX_INPUT_JSON_BYTES
            ),
        );
    }
    let result = catch_unwind(AssertUnwindSafe(|| analyze_inner(&input_json)));
    match result {
        Ok(Ok(output)) => output,
        Ok(Err(message)) => error_json("SHERIFF_ENGINE_ERROR", message),
        Err(payload) => error_json("SHERIFF_ENGINE_PANIC", panic_message(payload)),
    }
}

/// Shadow-only R2 entry point. The production TypeScript resolver remains the
/// default until the later consumer cutover phase.
#[napi(js_name = "resolveProjectImports")]
pub fn resolve_project_imports(input_json: String) -> String {
    if input_json.len() > input::MAX_INPUT_JSON_BYTES {
        return error_json(
            "SHERIFF_ENGINE_LIMIT_EXCEEDED",
            format!(
                "input JSON exceeds the {} byte limit",
                input::MAX_INPUT_JSON_BYTES
            ),
        );
    }
    let result = catch_unwind(AssertUnwindSafe(|| resolve_imports_inner(&input_json)));
    match result {
        Ok(Ok(output)) => output,
        Ok(Err(resolve::ResolveProjectError::Resolution(message))) => {
            error_json("SHERIFF_ENGINE_RESOLUTION_ERROR", message)
        }
        Ok(Err(resolve::ResolveProjectError::LimitExceeded(message))) => {
            error_json("SHERIFF_ENGINE_LIMIT_EXCEEDED", message)
        }
        Ok(Err(resolve::ResolveProjectError::CyclicTsConfigExtends(message))) => {
            error_json("SH-019", message)
        }
        Err(payload) => error_json("SHERIFF_ENGINE_PANIC", panic_message(payload)),
    }
}

/// Test-only R2 seam for comparing one Rust resolution with
/// `ts.resolveModuleName` without discarding external-library paths.
#[napi(js_name = "resolveModuleNameForEngineShadow")]
pub fn resolve_module_name_for_engine_shadow(input_json: String) -> String {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let input: resolve::ResolveModuleInput =
            serde_json::from_str(&input_json).map_err(|error| {
                resolve::ResolveProjectError::Resolution(format!(
                    "invalid ResolveModuleInput JSON: {error}"
                ))
            })?;
        let output = resolve::resolve_module_name_for_shadow(input)?;
        serde_json::to_string(&output).map_err(|error| {
            resolve::ResolveProjectError::Resolution(format!(
                "could not serialize resolve-module output: {error}"
            ))
        })
    }));
    match result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => error_json("SHERIFF_ENGINE_RESOLUTION_ERROR", error.to_string()),
        Err(payload) => error_json("SHERIFF_ENGINE_PANIC", panic_message(payload)),
    }
}

fn analyze_inner(input_json: &str) -> Result<String, String> {
    let input: input::EngineInput = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid EngineInput JSON: {error}"))?;
    input.validate()?;
    let output = engine::analyze(input)?;
    serde_json::to_string(&output).map_err(|error| format!("could not serialize output: {error}"))
}

fn resolve_imports_inner(input_json: &str) -> Result<String, resolve::ResolveProjectError> {
    let input: resolve::ResolveProjectInput =
        serde_json::from_str(input_json).map_err(|error| {
            resolve::ResolveProjectError::Resolution(format!(
                "invalid ResolveProjectInput JSON: {error}"
            ))
        })?;
    let output = resolve::resolve_project(input)?;
    serde_json::to_string(&output).map_err(|error| {
        resolve::ResolveProjectError::Resolution(format!("could not serialize output: {error}"))
    })
}

fn error_json(code: &'static str, message: String) -> String {
    serde_json::to_string(&ErrorOutput {
        schema_version: 1,
        error: StructuredError { code, message },
    })
    .unwrap_or_else(|_| {
        "{\"schemaVersion\":1,\"error\":{\"code\":\"SHERIFF_ENGINE_ERROR\",\"message\":\"failed to serialize engine error\"}}".to_owned()
    })
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|message| (*message).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "Rust engine panicked with a non-string payload".to_owned())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::resolve_project_imports;
    use crate::input::MAX_STRING_BYTES;

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn resolve_project_disk_limits_use_the_structured_limit_code() {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let directory =
            std::env::temp_dir().join(format!("sheriff-r2-lib-limit-{}-{id}", std::process::id()));
        fs::create_dir_all(directory.join("src")).unwrap();
        let config = directory.join("tsconfig.json");
        let source = directory.join("src/main.ts");
        fs::write(&config, "{}").unwrap();
        fs::write(&source, " ".repeat(MAX_STRING_BYTES + 1)).unwrap();

        let output = resolve_project_imports(
            serde_json::json!({
                "schemaVersion": 1,
                "tsConfigPath": config,
                "files": [source],
            })
            .to_string(),
        );
        let value: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(value["error"]["code"], "SHERIFF_ENGINE_LIMIT_EXCEEDED");
        assert!(
            value["error"]["message"]
                .as_str()
                .unwrap()
                .contains("source file")
        );

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn resolve_project_error_never_leaks_results_created_before_late_audit() {
        let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "sheriff-r2-lib-late-audit-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(directory.join("src")).unwrap();
        fs::create_dir_all(directory.join("node_modules/tv-pkg/modern")).unwrap();
        let config = directory.join("tsconfig.json");
        let first_source = directory.join("src/a.ts");
        let oversized_source = directory.join("src/b.ts");
        fs::write(
            &config,
            r#"{"compilerOptions":{"baseUrl":".","paths":{"alias":["node_modules/tv-pkg"]}}}"#,
        )
        .unwrap();
        fs::write(
            directory.join("node_modules/tv-pkg/package.json"),
            r#"{"name":"tv-pkg","types":"index.d.ts","typesVersions":{"*":{"*":["modern/*"]}}}"#,
        )
        .unwrap();
        fs::write(directory.join("node_modules/tv-pkg/index.d.ts"), "").unwrap();
        fs::write(directory.join("node_modules/tv-pkg/modern/index.d.ts"), "").unwrap();
        fs::write(&first_source, r#"import "alias";"#).unwrap();
        fs::write(&oversized_source, " ".repeat(MAX_STRING_BYTES + 1)).unwrap();

        for shadow_mode in [false, true] {
            let output = resolve_project_imports(
                serde_json::json!({
                    "schemaVersion": 1,
                    "tsConfigPath": config,
                    "files": [&first_source, &oversized_source],
                    "shadowMode": shadow_mode,
                })
                .to_string(),
            );
            let value: serde_json::Value = serde_json::from_str(&output).unwrap();
            assert_eq!(value["error"]["code"], "SHERIFF_ENGINE_LIMIT_EXCEEDED");
            assert!(value.get("files").is_none(), "shadowMode={shadow_mode}");
            assert!(value.get("fallback").is_none(), "shadowMode={shadow_mode}");
        }

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cyclic_tsconfigs_use_the_structured_user_error_code() {
        let cases = [
            (
                "two-config",
                vec![
                    ("a.json", r#"{"extends":"./b.json"}"#),
                    ("b.json", r#"{"extends":"./a.json"}"#),
                ],
                "a.json",
            ),
            (
                "self-extending",
                vec![("tsconfig.json", r#"{"extends":"./tsconfig.json"}"#)],
                "tsconfig.json",
            ),
            (
                "three-config",
                vec![
                    ("a.json", r#"{"extends":"./b.json"}"#),
                    ("b.json", r#"{"extends":"./c.json"}"#),
                    ("c.json", r#"{"extends":"./a.json"}"#),
                ],
                "a.json",
            ),
        ];

        for (name, configs, entry) in cases {
            let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir().join(format!(
                "sheriff-r2-lib-cycle-{}-{id}-{name}",
                std::process::id()
            ));
            fs::create_dir_all(&directory).unwrap();
            for (relative, contents) in configs {
                fs::write(directory.join(relative), contents).unwrap();
            }

            let output = resolve_project_imports(
                serde_json::json!({
                    "schemaVersion": 1,
                    "tsConfigPath": directory.join(entry),
                    "files": [],
                })
                .to_string(),
            );
            let value: serde_json::Value = serde_json::from_str(&output).unwrap();
            assert_eq!(value["error"]["code"], "SH-019", "case: {name}");
            assert!(
                value["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("Cyclic \"extends\" detected"),
                "case: {name}"
            );

            fs::remove_dir_all(directory).unwrap();
        }
    }
}
