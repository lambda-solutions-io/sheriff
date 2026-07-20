mod engine;
mod input;
mod paths;
mod rules;
mod simple_regex;
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
    let result = catch_unwind(AssertUnwindSafe(|| analyze_inner(&input_json)));
    match result {
        Ok(Ok(output)) => output,
        Ok(Err(message)) => error_json("SHERIFF_ENGINE_ERROR", message),
        Err(payload) => error_json("SHERIFF_ENGINE_PANIC", panic_message(payload)),
    }
}

fn analyze_inner(input_json: &str) -> Result<String, String> {
    let input = serde_json::from_str(input_json)
        .map_err(|error| format!("invalid EngineInput JSON: {error}"))?;
    let output = engine::analyze(input)?;
    serde_json::to_string(&output).map_err(|error| format!("could not serialize output: {error}"))
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
