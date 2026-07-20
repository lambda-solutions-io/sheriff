use crate::input::{ConfigValue, OrderedMap};
use crate::input::{MAX_CONFIG_NESTING, MAX_PLACEHOLDERS_PER_MATCHER};
use crate::js_regex;

type Placeholders = Vec<(String, String)>;

pub fn calculate_tags(
    module_path: &str,
    config: &OrderedMap<ConfigValue>,
    auto_tagging: bool,
) -> Result<Vec<String>, String> {
    if module_path == "." {
        return Ok(vec!["root".to_owned()]);
    }

    let paths: Vec<&str> = module_path.split('/').collect();
    let mut placeholders = Vec::new();
    match traverse(&paths, config, &mut placeholders, module_path, &[], true, 1)? {
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
    placeholders: &mut Placeholders,
    module_path: &str,
    config_path: &[String],
    is_root: bool,
    depth: usize,
) -> Result<Option<Vec<String>>, String> {
    if depth > MAX_CONFIG_NESTING {
        return Err(format!(
            "moduleConfig nesting exceeds the {MAX_CONFIG_NESTING} level limit"
        ));
    }
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
        return traverse(
            rest,
            nested,
            placeholders,
            module_path,
            &nested_path,
            false,
            depth + 1,
        );
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
    placeholders: &Placeholders,
    module_path: &str,
) -> Result<Vec<String>, String> {
    tags.iter()
        .map(|tag| {
            let mut replaced = tag.clone();
            for (placeholder, value) in placeholders {
                replaced = replace_all_javascript(
                    &replaced,
                    &format!("<{placeholder}>"),
                    value,
                );
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
    placeholders: &mut Placeholders,
) -> Result<Option<usize>, String> {
    if matcher.starts_with('/') && matcher.ends_with('/') && matcher.len() >= 2 {
        let pattern = &matcher[1..matcher.len() - 1];
        return js_regex::is_full_first_match(pattern, paths[0])
            .map(|matches| matches.then_some(1));
    }

    let span = matcher.split('/').count();
    if span > paths.len() {
        return Ok(None);
    }
    let fragment = paths[..span].join("/");
    let placeholder_names = find_placeholder(matcher);
    if placeholder_names.len() > MAX_PLACEHOLDERS_PER_MATCHER {
        return Err(format!(
            "placeholders in one moduleConfig matcher count {} exceeds the {} limit",
            placeholder_names.len(),
            MAX_PLACEHOLDERS_PER_MATCHER
        ));
    }
    if placeholder_names.is_empty() {
        return Ok((matcher == fragment).then_some(span));
    }

    let Some(captures) = match_placeholders(matcher, &fragment, placeholder_names.len()) else {
        return Ok(None);
    };
    for (name, capture) in placeholder_names.into_iter().zip(captures) {
        if placeholders.iter().any(|(existing, _)| existing == &name) {
            return Err(format!(
                "SH-005: placeholder for value \"{name}\" does already exist"
            ));
        }
        placeholders.push((name, capture));
    }
    Ok(Some(span))
}

fn replace_all_javascript(input: &str, needle: &str, replacement: &str) -> String {
    let matches = input.match_indices(needle).collect::<Vec<_>>();
    if matches.is_empty() {
        return input.to_owned();
    }

    let mut output = String::new();
    let mut copied_until = 0;
    for (start, matched) in matches {
        output.push_str(&input[copied_until..start]);
        output.push_str(&expand_javascript_replacement(
            replacement,
            input,
            start,
            start + matched.len(),
        ));
        copied_until = start + matched.len();
    }
    output.push_str(&input[copied_until..]);
    output
}

fn expand_javascript_replacement(
    replacement: &str,
    input: &str,
    match_start: usize,
    match_end: usize,
) -> String {
    let mut output = String::with_capacity(replacement.len());
    let mut characters = replacement.char_indices().peekable();
    while let Some((index, character)) = characters.next() {
        if character != '$' {
            output.push(character);
            continue;
        }
        let Some(&(_, next)) = characters.peek() else {
            output.push('$');
            break;
        };
        match next {
            '$' => {
                output.push('$');
                characters.next();
            }
            '&' => {
                output.push_str(&input[match_start..match_end]);
                characters.next();
            }
            '`' => {
                output.push_str(&input[..match_start]);
                characters.next();
            }
            '\'' => {
                output.push_str(&input[match_end..]);
                characters.next();
            }
            // The placeholder replacement RegExp has no capture groups, so JavaScript
            // leaves every $n/$nn sequence untouched.
            '0'..='9' => {
                output.push_str(&replacement[index..characters.peek().unwrap().0]);
            }
            _ => output.push('$'),
        }
    }
    output
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
    fn regular_expressions_follow_javascript_first_match_semantics() {
        let cases = [
            ("feature-.+", "feature-abc", true),
            ("feature-.+", "feature-", false),
            ("[a-z]+", "abc", true),
            ("[a-z]+", "aBc", false),
            ("a|ab", "ab", false),
            ("(a|ab)c", "abc", true),
            ("a{2,3}", "aaa", true),
            ("a{2,3}", "a", false),
            (r"\d+", "123", true),
            (r"\w+", "abc_1", true),
            ("x*", "", true),
            (".*", "anything", true),
            ("^abc$", "abc", true),
            ("a+?", "aaa", false),
            ("(?:ab)+", "abab", true),
            ("(?=a)a", "a", true),
            ("(?!b)a", "a", true),
            (r"(a)\1", "aa", true),
            ("[^x]+", "abc", true),
            ("a.c", "abc", true),
            ("data|feature", "data", true),
            (r"\s", " ", true),
            ("[0-9]{3}-[0-9]{2}", "123-45", true),
            ("(?:(a|ab)c)", "abc", true),
            ("(ab){2,3}", "abab", true),
            (r"\u0061+", "aaa", true),
            (r"\uD83D\uDE00", "😀", true),
            (".", "\n", false),
            ("a+", "A", false),
            ("", "", true),
            ("", "a", false),
            ("a.*?b", "axxb", true),
            ("(a(b|c))+", "abac", true),
            ("(?:foo|bar){2}", "foobar", true),
        ];

        for (pattern, value, expected) in cases {
            assert_eq!(
                js_regex::is_full_first_match(pattern, value).unwrap(),
                expected,
                "/{pattern}/ against {value:?}"
            );
        }
    }

    #[test]
    fn invalid_regular_expressions_are_structured_errors() {
        let error = calculate_tags("abc", &config(r#"{"/(abc/":"tag"}"#), true).unwrap_err();
        assert!(error.contains("invalid regular expression"), "{error}");
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
    fn placeholder_replacement_preserves_capture_insertion_order() {
        assert_eq!(
            calculate_tags(
                "<type>/foo",
                &config(r#"{"<domain>/<type>":"result:<domain>"}"#),
                true,
            )
            .unwrap(),
            ["result:foo"]
        );
    }

    #[test]
    fn placeholder_values_use_javascript_replacement_string_expansion() {
        assert!(
            calculate_tags("$&", &config(r#"{"<x>":"result:<x>"}"#), true)
                .unwrap_err()
                .starts_with("SH-006")
        );
        assert_eq!(
            calculate_tags("$$", &config(r#"{"<x>":"result:<x>"}"#), true).unwrap(),
            ["result:$"]
        );
        assert_eq!(
            replace_all_javascript("pre<x>post", "<x>", "$`"),
            "preprepost"
        );
        assert_eq!(
            replace_all_javascript("pre<x>post", "<x>", "$'"),
            "prepostpost"
        );
        assert_eq!(
            replace_all_javascript("pre<x>post", "<x>", "$1"),
            "pre$1post"
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
