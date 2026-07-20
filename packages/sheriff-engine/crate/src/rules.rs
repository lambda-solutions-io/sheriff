use crate::input::{OrderedMap, RuleValue};

pub fn wildcard_matches(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;

    for pattern_character in pattern {
        let mut current = vec![false; value.len() + 1];
        if pattern_character == '*' {
            current[0] = previous[0];
            for index in 1..=value.len() {
                current[index] = previous[index]
                    || (current[index - 1] && !is_javascript_line_terminator(value[index - 1]));
            }
        } else {
            for index in 1..=value.len() {
                current[index] = previous[index - 1] && value[index - 1] == pattern_character;
            }
        }
        previous = current;
    }

    previous[value.len()]
}

fn is_javascript_line_terminator(value: char) -> bool {
    matches!(value, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub fn is_dependency_allowed(
    from_tag: &str,
    to_tags: &[String],
    rules: &OrderedMap<RuleValue>,
) -> Result<bool, String> {
    let mut matched_from_rule = false;
    for (from_pattern, value) in &rules.0 {
        if !wildcard_matches(from_pattern, from_tag) {
            continue;
        }
        matched_from_rule = true;
        for to_tag in to_tags {
            if value
                .matchers()
                .iter()
                .any(|matcher| wildcard_matches(matcher, to_tag))
            {
                return Ok(true);
            }
        }
    }

    if matched_from_rule {
        Ok(false)
    } else {
        Err(format!(
            "SH-002: No dependency rule for tag '{from_tag}' found in sheriff.config.ts"
        ))
    }
}

pub fn is_dependency_denied(
    from_tag: &str,
    to_tags: &[String],
    rules: &OrderedMap<RuleValue>,
) -> bool {
    rules.0.iter().any(|(from_pattern, value)| {
        wildcard_matches(from_pattern, from_tag)
            && to_tags.iter().any(|to_tag| {
                value
                    .matchers()
                    .iter()
                    .any(|matcher| wildcard_matches(matcher, to_tag))
            })
    })
}

pub fn is_external_allowed(
    from_tag: &str,
    external_library: &str,
    rules: &OrderedMap<Vec<String>>,
) -> bool {
    for (from_pattern, library_patterns) in &rules.0 {
        if wildcard_matches(from_pattern, from_tag)
            && !library_patterns
                .iter()
                .any(|pattern| wildcard_matches(pattern, external_library))
        {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(json: &str) -> OrderedMap<RuleValue> {
        serde_json::from_str(json).expect("test rules must deserialize")
    }

    #[test]
    fn wildcard_escapes_every_regex_metacharacter_except_star() {
        assert!(wildcard_matches("type:[a]+*", "type:[a]+feature"));
        assert!(!wildcard_matches("type:[a]+*", "type:afeature"));
        assert!(wildcard_matches("*", "anything"));
    }

    #[test]
    fn allows_string_arrays_and_wildcard_values() {
        assert!(
            is_dependency_allowed(
                "type:feature",
                &["shared:ui".to_owned()],
                &rules(r#"{"type:feature":["type:data","shared:*"]}"#)
            )
            .unwrap()
        );
    }

    #[test]
    fn matching_rule_without_matching_target_denies() {
        assert!(
            !is_dependency_allowed(
                "type:feature",
                &["domain:abc".to_owned()],
                &rules(r#"{"type:feature":["type:data","type:ui"]}"#)
            )
            .unwrap()
        );
    }

    #[test]
    fn multiple_matching_keys_are_or_combined() {
        assert!(
            is_dependency_allowed(
                "domain:bookings",
                &["domain:customers:api".to_owned()],
                &rules(
                    r#"{"domain:*":["domain:shared"],"domain:bookings":"domain:customers:api"}"#
                )
            )
            .unwrap()
        );
    }

    #[test]
    fn missing_from_rule_is_an_error() {
        assert!(
            is_dependency_allowed(
                "type:function",
                &["type:ui".to_owned()],
                &rules(r#"{"type:feature":"type:ui"}"#)
            )
            .unwrap_err()
            .starts_with("SH-002")
        );
    }

    #[test]
    fn deny_rules_never_allow_and_any_match_denies() {
        assert!(is_dependency_denied(
            "type:feature",
            &["type:data".to_owned()],
            &rules(r#"{"domain:*":"type:data","type:*":"type:data"}"#)
        ));
        assert!(!is_dependency_denied(
            "type:feature",
            &["type:ui".to_owned()],
            &rules(r#"{"type:*":"type:data"}"#)
        ));
    }
}
