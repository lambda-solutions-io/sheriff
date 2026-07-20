use rustc_hash::FxHashMap;

use crate::input::{ConfigValue, OrderedMap};
use crate::simple_regex;

pub fn calculate_tags(
    module_path: &str,
    config: &OrderedMap<ConfigValue>,
    auto_tagging: bool,
) -> Result<Vec<String>, String> {
    if module_path == "." {
        return Ok(vec!["root".to_owned()]);
    }

    let paths: Vec<&str> = module_path.split('/').collect();
    let mut placeholders = FxHashMap::default();
    match traverse(&paths, config, &mut placeholders, module_path, &[], true)? {
        Some(tags) => Ok(tags),
        None if auto_tagging => Ok(vec!["noTag".to_owned()]),
        None => Err(format!(
            "SH-003: No assigned Tag for '{module_path}' in sheriff.config.ts"
        )),
    }
}

fn traverse(
    paths: &[&str],
    config: &OrderedMap<ConfigValue>,
    placeholders: &mut FxHashMap<String, String>,
    module_path: &str,
    config_path: &[String],
    is_root: bool,
) -> Result<Option<Vec<String>>, String> {
    for (matcher, value) in &config.0 {
        if is_root {
            placeholders.clear();
        }
        let original_placeholders = placeholders.clone();
        let Some(span) = match_segment(matcher, paths, placeholders)? else {
            continue;
        };
        let rest = &paths[span..];

        if rest.is_empty() {
            let tags = leaf_tags(value).ok_or_else(|| {
                let mut full_path = config_path.to_vec();
                full_path.push(matcher.clone());
                format!(
                    "SH-004: Tag configuration '/{}' in sheriff.config.ts has no value",
                    full_path.join("/")
                )
            })?;
            return Ok(Some(replace_tags(tags, placeholders, module_path)?));
        }

        if is_leaf(value) {
            *placeholders = original_placeholders;
            continue;
        }

        let ConfigValue::Object(nested) = value else {
            unreachable!("non-leaf config values are nested objects")
        };
        let mut nested_path = config_path.to_vec();
        nested_path.push(matcher.clone());
        return traverse(rest, nested, placeholders, module_path, &nested_path, false);
    }

    Ok(None)
}

fn is_leaf(value: &ConfigValue) -> bool {
    match value {
        ConfigValue::String(_) | ConfigValue::Strings(_) => true,
        ConfigValue::Object(entries) => is_module_definition(entries),
    }
}

fn is_module_definition(entries: &OrderedMap<ConfigValue>) -> bool {
    entries.0.iter().any(|(key, _)| key == "tags")
        && entries
            .0
            .iter()
            .all(|(key, _)| key == "tags" || key == "exports")
}

fn leaf_tags(value: &ConfigValue) -> Option<&[String]> {
    match value {
        ConfigValue::String(value) => Some(std::slice::from_ref(value)),
        ConfigValue::Strings(values) => Some(values),
        ConfigValue::Object(entries) if is_module_definition(entries) => entries
            .0
            .iter()
            .find(|(key, _)| key == "tags")
            .and_then(|(_, value)| leaf_tags(value)),
        ConfigValue::Object(_) => None,
    }
}

fn replace_tags(
    tags: &[String],
    placeholders: &FxHashMap<String, String>,
    module_path: &str,
) -> Result<Vec<String>, String> {
    tags.iter()
        .map(|tag| {
            let mut replaced = tag.clone();
            for (placeholder, value) in placeholders {
                replaced = replaced.replace(&format!("<{placeholder}>"), value);
            }
            if let Some(placeholder) = find_placeholder(&replaced).first() {
                return Err(format!(
                    "SH-006: cannot find a placeholder for \"<{placeholder}>\" in tag configuration. Module: {module_path}"
                ));
            }
            Ok(replaced)
        })
        .collect()
}

fn match_segment(
    matcher: &str,
    paths: &[&str],
    placeholders: &mut FxHashMap<String, String>,
) -> Result<Option<usize>, String> {
    if matcher.starts_with('/') && matcher.ends_with('/') && matcher.len() >= 2 {
        let pattern = &matcher[1..matcher.len() - 1];
        return simple_regex::is_full_match(pattern, paths[0]).map(|matches| matches.then_some(1));
    }

    let span = matcher.split('/').count();
    if span > paths.len() {
        return Ok(None);
    }
    let fragment = paths[..span].join("/");
    let placeholder_names = find_placeholder(matcher);
    if placeholder_names.is_empty() {
        return Ok((matcher == fragment).then_some(span));
    }

    let Some(captures) = match_placeholders(matcher, &fragment, placeholder_names.len()) else {
        return Ok(None);
    };
    for (name, capture) in placeholder_names.into_iter().zip(captures) {
        if placeholders.contains_key(&name) {
            return Err(format!(
                "SH-005: placeholder for value \"{name}\" does already exist"
            ));
        }
        placeholders.insert(name, capture);
    }
    Ok(Some(span))
}

fn find_placeholder(value: &str) -> Vec<String> {
    let chars: Vec<char> = value.chars().collect();
    let mut output = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '<' {
            index += 1;
            continue;
        }
        let start = index + 1;
        let mut end = start;
        while end < chars.len() && is_placeholder_character(chars[end]) {
            end += 1;
        }
        if end > start && chars.get(end) == Some(&'>') {
            output.push(chars[start..end].iter().collect());
            index = end + 1;
        } else {
            index += 1;
        }
    }
    output
}

fn is_placeholder_character(value: char) -> bool {
    value.is_ascii_alphabetic() || value == '-' || value == '_'
}

fn match_placeholders(matcher: &str, value: &str, capture_count: usize) -> Option<Vec<String>> {
    let mut literals = Vec::with_capacity(capture_count + 1);
    let mut rest = matcher;
    while let Some(start) = rest.find('<') {
        let after_start = &rest[start + 1..];
        let end = after_start.find('>')?;
        literals.push(rest[..start].to_owned());
        rest = &after_start[end + 1..];
    }
    literals.push(rest.to_owned());

    for start in value
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(value.len()))
    {
        let mut captures = Vec::with_capacity(capture_count);
        if let Some(end) = match_placeholder_tokens(&literals, value, start, 0, &mut captures) {
            let _matched_fragment = &value[start..end];
            return Some(captures);
        }
    }
    None
}

fn match_placeholder_tokens(
    literals: &[String],
    value: &str,
    position: usize,
    capture_index: usize,
    captures: &mut Vec<String>,
) -> Option<usize> {
    let literal = &literals[capture_index];
    if !value[position..].starts_with(literal) {
        return None;
    }
    let after_literal = position + literal.len();
    if capture_index + 1 == literals.len() {
        return Some(after_literal);
    }

    let next_literal = &literals[capture_index + 1];
    let mut candidate_ends: Vec<usize> = value[after_literal..]
        .char_indices()
        .map(|(offset, _)| after_literal + offset)
        .filter(|end| *end > after_literal)
        .collect();
    candidate_ends.push(value.len());
    candidate_ends.sort_unstable_by(|left, right| right.cmp(left));

    for end in candidate_ends {
        if !value[end..].starts_with(next_literal) {
            continue;
        }
        captures.push(value[after_literal..end].to_owned());
        if let Some(final_position) =
            match_placeholder_tokens(literals, value, end, capture_index + 1, captures)
        {
            return Some(final_position);
        }
        captures.pop();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::ConfigValue;

    fn config(json: &str) -> OrderedMap<ConfigValue> {
        serde_json::from_str(json).expect("test module config must deserialize")
    }

    #[test]
    fn identifies_the_root_module() {
        assert_eq!(
            calculate_tags(".", &config(r#"{"abc":"domain:abc"}"#), true).unwrap(),
            ["root"]
        );
    }

    #[test]
    fn calculates_static_and_multiple_tags() {
        assert_eq!(
            calculate_tags(
                "abc",
                &config(r#"{"abc":["domain:abc","type:generic"]}"#),
                true
            )
            .unwrap(),
            ["domain:abc", "type:generic"]
        );
    }

    #[test]
    fn substitutes_multiple_partial_placeholders() {
        assert_eq!(
            calculate_tags(
                "feat-bookings",
                &config(r#"{"<type>-<subdomain>":["type:<type>","subdomain:<subdomain>"]}"#),
                true
            )
            .unwrap(),
            ["type:feat", "subdomain:bookings"]
        );
    }

    #[test]
    fn supports_multi_segment_and_nested_matchers() {
        assert_eq!(
            calculate_tags(
                "src/app/domain/customers/ui",
                &config(
                    r#"{"src/app/domain":{"<domain>/<type>":["domain:<domain>","type:<type>"]}}"#
                ),
                true
            )
            .unwrap(),
            ["domain:customers", "type:ui"]
        );
    }

    #[test]
    fn continues_after_a_nested_module_leaf() {
        assert_eq!(
            calculate_tags(
                "libs/holidays/src/lib/data",
                &config(
                    r#"{"libs":{"<domain>/src":"nx-lib","<domain>/src/lib/<type>":["domain:<domain>","type:<type>"]}}"#
                ),
                true
            )
            .unwrap(),
            ["domain:holidays", "type:data"]
        );
    }

    #[test]
    fn regular_expression_must_match_the_full_segment() {
        assert_eq!(
            calculate_tags(
                "holidays-123",
                &config(r#"{"/(\\w+)/":"regex","holidays-123":"simple match"}"#),
                true
            )
            .unwrap(),
            ["simple match"]
        );
    }

    #[test]
    fn first_applicable_matcher_wins_in_json_order() {
        assert_eq!(
            calculate_tags(
                "holidays",
                &config(r#"{"<domain>":"domain:<domain>","holidays":"scope:holidays"}"#),
                true
            )
            .unwrap(),
            ["domain:holidays"]
        );
    }

    #[test]
    fn no_match_uses_no_tag_only_with_auto_tagging() {
        assert_eq!(
            calculate_tags("src", &config(r#"{"src/app":"app"}"#), true).unwrap(),
            ["noTag"]
        );
        assert!(
            calculate_tags("src", &config(r#"{"src/app":"app"}"#), false)
                .unwrap_err()
                .starts_with("SH-003")
        );
    }

    #[test]
    fn rejects_placeholder_collision_and_missing_placeholder_values() {
        assert!(
            calculate_tags(
                "holidays/feature",
                &config(r#"{"<str>":{"<str>":["noop"]}}"#),
                true
            )
            .unwrap_err()
            .starts_with("SH-005")
        );
        assert!(
            calculate_tags(
                "feat-bookings",
                &config(r#"{"<subdomain>":["type:<type>"]}"#),
                true
            )
            .unwrap_err()
            .starts_with("SH-006")
        );
    }

    #[test]
    fn rejects_an_object_leaf_without_tags() {
        assert!(
            calculate_tags(
                "abc/def/ghj",
                &config(r#"{"abc":{"def":{"ghj":{}}}}"#),
                true
            )
            .unwrap_err()
            .starts_with("SH-004")
        );
    }
}
