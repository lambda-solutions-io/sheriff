use std::path::Path;

use oxc_allocator::Allocator;
use oxc_parser::{Kind, Parser, config::TokensParserConfig};
use oxc_span::SourceType;
use serde::Serialize;

/// One module request found in source text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedImport {
    pub raw: String,
    /// Byte offset of the first byte inside the string literal.
    pub start: u32,
    /// Byte offset immediately after the last byte inside the string literal.
    pub end: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedImports {
    pub imports: Vec<ExtractedImport>,
    pub fallback_reasons: Vec<String>,
}

/// Extract the requests which TypeScript exposes through
/// `preProcessFile(source).importedFiles`.
///
/// Sheriff calls `preProcessFile` without enabling JavaScript import detection,
/// so ordinary CommonJS `require()` calls and triple-slash directives are
/// deliberately absent. This differs from the original R2 plan.
pub fn extract_imports(path: &Path, source: &str) -> Result<ExtractedImports, String> {
    let source_type = SourceType::from_path(path)
        .map_err(|error| format!("unsupported source type for {}: {error}", path.display()))?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type)
        .with_config(TokensParserConfig)
        .parse();
    if parsed.panicked {
        return Err(format!("oxc_parser could not parse {}", path.display()));
    }

    let mut imports = Vec::new();
    let mut fallback_reasons = Vec::new();

    // The module record retains every occurrence, including duplicates, but is
    // keyed by request text. Flatten it and restore source order by byte span.
    for (raw, occurrences) in &parsed.module_record.requested_modules {
        for occurrence in occurrences {
            imports.push(ExtractedImport {
                raw: raw.to_string(),
                start: occurrence.span.start.saturating_add(1),
                end: occurrence.span.end.saturating_sub(1),
            });
        }
    }

    // Dynamic imports are recorded as expression spans because their argument
    // need not be a literal. TypeScript's preprocessor accepts quote-delimited
    // strings and no-substitution template literals only.
    for dynamic_import in &parsed.module_record.dynamic_imports {
        let span = dynamic_import.module_request;
        let Some(literal) = source.get(span.start as usize..span.end as usize) else {
            continue;
        };
        match decode_literal(literal) {
            Ok(Some(raw)) => imports.push(ExtractedImport {
                raw,
                start: span.start.saturating_add(1),
                end: span.end.saturating_sub(1),
            }),
            Ok(None) => {}
            Err(()) => fallback_reasons.push(
                "dynamic import contains an unpaired UTF-16 surrogate, which requires TypeScript"
                    .to_owned(),
            ),
        }
    }

    // Oxc's ESM module record intentionally excludes TypeScript's
    // `import x = require('x')`, although `ts.preProcessFile` includes it. Token matching is
    // needed because this declaration is also legal inside namespace bodies, where it is not a
    // top-level Program statement. Keeping the full parser in front of this scan prevents matches
    // in comments and string contents.
    for index in 0..parsed.tokens.len() {
        if parsed.tokens[index].kind() != Kind::Import {
            continue;
        }
        let mut cursor = index + 1;
        if parsed
            .tokens
            .get(cursor)
            .is_some_and(|token| token.kind() == Kind::Type)
        {
            cursor += 1;
        }
        if !parsed
            .tokens
            .get(cursor)
            .is_some_and(|token| token.kind() == Kind::Ident)
        {
            continue;
        }
        cursor += 1;
        let expected = [
            Kind::Eq,
            Kind::Require,
            Kind::LParen,
            Kind::Str,
            Kind::RParen,
        ];
        if !expected.iter().enumerate().all(|(offset, kind)| {
            parsed
                .tokens
                .get(cursor + offset)
                .is_some_and(|token| token.kind() == *kind)
        }) {
            continue;
        }
        let literal = parsed.tokens[cursor + 3];
        let Some(text) = source.get(literal.start() as usize..literal.end() as usize) else {
            continue;
        };
        match decode_literal(text) {
            Ok(Some(raw)) => imports.push(ExtractedImport {
                raw,
                start: literal.start().saturating_add(1),
                end: literal.end().saturating_sub(1),
            }),
            Ok(None) => {}
            Err(()) => fallback_reasons.push(
                "import-equals contains an unpaired UTF-16 surrogate, which requires TypeScript"
                    .to_owned(),
            ),
        }
    }

    imports.sort_by_key(|import| (import.start, import.end));
    fallback_reasons.sort();
    fallback_reasons.dedup();
    Ok(ExtractedImports {
        imports,
        fallback_reasons,
    })
}

fn decode_literal(literal: &str) -> Result<Option<String>, ()> {
    let Some(delimiter) = literal.as_bytes().first().copied() else {
        return Ok(None);
    };
    if !matches!(delimiter, b'\'' | b'"' | b'`')
        || literal.as_bytes().last().copied() != Some(delimiter)
    {
        return Ok(None);
    }
    let Some(body) = literal.get(1..literal.len().checked_sub(1).ok_or(())?) else {
        return Ok(None);
    };
    if delimiter == b'`' && contains_template_substitution(body) {
        return Ok(None);
    }
    decode_escapes(body).map(Some)
}

fn contains_template_substitution(body: &str) -> bool {
    let mut escaped = false;
    let bytes = body.as_bytes();
    for index in 0..bytes.len().saturating_sub(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if bytes[index] == b'\\' {
            escaped = true;
        } else if bytes[index] == b'$' && bytes[index + 1] == b'{' {
            return true;
        }
    }
    false
}

fn decode_escapes(body: &str) -> Result<String, ()> {
    let mut output = String::with_capacity(body.len());
    let mut chars = body.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }

        let escaped = chars.next().ok_or(())?;
        match escaped {
            '\n' => {}
            '\r' => {
                if chars.clone().next() == Some('\n') {
                    chars.next();
                }
            }
            'n' => output.push('\n'),
            'r' => output.push('\r'),
            't' => output.push('\t'),
            'b' => output.push('\u{0008}'),
            'f' => output.push('\u{000c}'),
            'v' => output.push('\u{000b}'),
            '0' => output.push('\0'),
            'x' => output.push(char::from_u32(read_hex(&mut chars, 2)?).ok_or(())?),
            'u' => {
                if chars.clone().next() == Some('{') {
                    chars.next();
                    let mut value = 0_u32;
                    let mut digits = 0;
                    loop {
                        let next = chars.next().ok_or(())?;
                        if next == '}' {
                            break;
                        }
                        value = value.checked_mul(16).ok_or(())? + next.to_digit(16).ok_or(())?;
                        digits += 1;
                    }
                    if digits == 0 {
                        return Err(());
                    }
                    output.push(char::from_u32(value).ok_or(())?);
                } else {
                    let first = read_hex(&mut chars, 4)?;
                    if (0xd800..=0xdbff).contains(&first) {
                        let mut remainder = chars.clone();
                        if remainder.next() != Some('\\') || remainder.next() != Some('u') {
                            return Err(());
                        }
                        let second = read_hex(&mut remainder, 4)?;
                        if !(0xdc00..=0xdfff).contains(&second) {
                            return Err(());
                        }
                        chars = remainder;
                        let code_point = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
                        output.push(char::from_u32(code_point).ok_or(())?);
                    } else if (0xdc00..=0xdfff).contains(&first) {
                        return Err(());
                    } else {
                        output.push(char::from_u32(first).ok_or(())?);
                    }
                }
            }
            other => output.push(other),
        }
    }
    Ok(output)
}

fn read_hex(chars: &mut impl Iterator<Item = char>, count: usize) -> Result<u32, ()> {
    let mut value = 0_u32;
    for _ in 0..count {
        value = value.checked_mul(16).ok_or(())? + chars.next().ok_or(())?.to_digit(16).ok_or(())?;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{ExtractedImport, extract_imports};

    fn raw(source: &str, extension: &str) -> Vec<String> {
        extract_imports(Path::new(&format!("source.{extension}")), source)
            .unwrap()
            .imports
            .into_iter()
            .map(|import| import.raw)
            .collect()
    }

    #[test]
    fn extracts_every_preprocess_import_form_in_source_order() {
        let source = r#"
import defaultValue from './default';
import type { Type } from './type';
import * as namespace from './namespace';
import './bare';
export { value } from './named-export';
export * from './star-export';
const lazy = import('./dynamic');
const template = import(`./template`);
import legacy = require('./import-equals');
"#;
        assert_eq!(
            raw(source, "ts"),
            [
                "./default",
                "./type",
                "./namespace",
                "./bare",
                "./named-export",
                "./star-export",
                "./dynamic",
                "./template",
                "./import-equals",
            ]
        );
    }

    #[test]
    fn excludes_require_references_and_non_literal_dynamic_imports() {
        let source = r#"
/// <reference path="./reference" />
/// <reference types="node" />
const commonJs = require('./common-js');
const computed = import(moduleName);
const substituted = import(`./${moduleName}`);
declare module 'ambient' {}
"#;
        assert!(raw(source, "ts").is_empty());
    }

    #[test]
    fn keeps_duplicate_module_requests_and_decodes_escapes() {
        assert_eq!(
            raw(
                r#"import './same'; import './same'; import './esc\u0061pe';"#,
                "ts"
            ),
            ["./same", "./same", "./escape"]
        );
    }

    #[test]
    fn combines_utf16_surrogate_pairs_in_dynamic_literals() {
        assert_eq!(
            raw(
                r#"import './😀'; const lazy = import('./\uD83D\uDE00');"#,
                "ts"
            ),
            ["./😀", "./😀"]
        );
    }

    #[test]
    fn unpaired_utf16_surrogates_require_typescript_fallback() {
        // TypeScript preserves each lone code unit in importedFiles. Rust
        // strings cannot represent lone UTF-16 surrogates losslessly.
        for source in [
            r#"const high = import('./\uD83D');"#,
            r#"const low = import('./\uDE00');"#,
        ] {
            let extracted = extract_imports(Path::new("source.ts"), source).unwrap();
            assert!(extracted.imports.is_empty());
            assert_eq!(extracted.fallback_reasons.len(), 1);
            assert!(extracted.fallback_reasons[0].contains("unpaired UTF-16 surrogate"));
        }
    }

    #[test]
    fn records_utf8_byte_offsets_inside_the_literal() {
        let source = "const café = 1; import './target';";
        let imports = extract_imports(Path::new("source.ts"), source)
            .unwrap()
            .imports;
        let start = source.find("./target").unwrap() as u32;
        assert_eq!(
            imports,
            vec![ExtractedImport {
                raw: "./target".to_owned(),
                start,
                end: start + "./target".len() as u32,
            }]
        );
    }

    #[test]
    fn selects_source_type_from_extension() {
        assert_eq!(
            raw("import value from './tsx'; const view = <div />;", "tsx"),
            ["./tsx"]
        );
        assert_eq!(
            raw("import value from './jsx'; const view = <div />;", "jsx"),
            ["./jsx"]
        );
        assert_eq!(raw("import value from './mts';", "mts"), ["./mts"]);
        assert_eq!(raw("import value from './cts';", "cts"), ["./cts"]);
    }

    #[test]
    fn extracts_import_equals_inside_a_namespace() {
        assert_eq!(
            raw(
                "namespace Nested { import value = require('./nested'); }",
                "ts"
            ),
            ["./nested"]
        );
    }
}
