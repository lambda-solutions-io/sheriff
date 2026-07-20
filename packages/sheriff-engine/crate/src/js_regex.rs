use fancy_regex::{Regex, RegexBuilder};

use crate::input::{MAX_REGEX_BYTES, MAX_REGEX_NESTING};

const REGEX_BACKTRACK_LIMIT: usize = 1_000_000;
const REGEX_DELEGATE_SIZE_LIMIT: usize = 4 * 1024 * 1024;

pub fn compile(pattern: &str, flags: &str) -> Result<Regex, String> {
    validate_pattern(pattern)?;
    let mut builder = RegexBuilder::new(&translate_javascript_unicode_escapes(pattern)?);
    builder
        .backtrack_limit(REGEX_BACKTRACK_LIMIT)
        .delegate_size_limit(REGEX_DELEGATE_SIZE_LIMIT);

    let mut seen = [false; 128];
    for flag in flags.bytes() {
        if !flag.is_ascii() || seen[flag as usize] {
            return Err(format!(
                "invalid JavaScript regular expression flags '{flags}'"
            ));
        }
        seen[flag as usize] = true;
        match flag {
            b'i' => {
                builder.case_insensitive(true);
            }
            b'm' => {
                builder.multi_line(true);
            }
            b's' => {
                builder.dot_matches_new_line(true);
            }
            // These flags do not affect the boolean search performed by the engine.
            b'd' | b'g' | b'u' => {}
            // A sticky RegExp starts at index zero for the serialized, stateless boundary.
            b'y' => {
                return Err(
                    "JavaScript sticky regular expressions are not supported by the stateless engine boundary"
                        .to_owned(),
                );
            }
            // Unicode sets require a different parser and cannot be silently approximated.
            b'v' => {
                return Err(
                    "JavaScript Unicode-set regular expressions are not supported".to_owned(),
                );
            }
            _ => {
                return Err(format!(
                    "unsupported JavaScript regular expression flag '{flag}'"
                ));
            }
        }
    }

    builder
        .build()
        .map_err(|error| format!("invalid regular expression /{pattern}/{flags}: {error}"))
}

pub fn is_full_first_match(pattern: &str, value: &str) -> Result<bool, String> {
    let regex = compile(pattern, "")?;
    regex
        .find(value)
        .map(|found| found.is_some_and(|matched| matched.as_str() == value))
        .map_err(|error| format!("regular expression /{pattern}/ failed: {error}"))
}

pub fn has_match(regex: &Regex, pattern: &str, value: &str) -> Result<bool, String> {
    regex
        .find(value)
        .map(|found| found.is_some())
        .map_err(|error| format!("regular expression /{pattern}/ failed: {error}"))
}

fn validate_pattern(pattern: &str) -> Result<(), String> {
    if pattern.len() > MAX_REGEX_BYTES {
        return Err(format!(
            "regular expression exceeds the {MAX_REGEX_BYTES} byte limit"
        ));
    }

    let mut depth = 0usize;
    let mut escaped = false;
    let mut in_class = false;
    for character in pattern.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '[' if !in_class => in_class = true,
            ']' if in_class => in_class = false,
            '(' if !in_class => {
                depth += 1;
                if depth > MAX_REGEX_NESTING {
                    return Err(format!(
                        "regular expression nesting exceeds the {MAX_REGEX_NESTING} level limit"
                    ));
                }
            }
            ')' if !in_class => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    Ok(())
}

fn translate_javascript_unicode_escapes(pattern: &str) -> Result<String, String> {
    let bytes = pattern.as_bytes();
    let mut output = String::with_capacity(pattern.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\\'
            && bytes.get(index + 1) == Some(&b'u')
            && bytes.get(index + 2).is_some_and(u8::is_ascii_hexdigit)
            && bytes.get(index + 3).is_some_and(u8::is_ascii_hexdigit)
            && bytes.get(index + 4).is_some_and(u8::is_ascii_hexdigit)
            && bytes.get(index + 5).is_some_and(u8::is_ascii_hexdigit)
        {
            let digits = &pattern[index + 2..index + 6];
            let value = u16::from_str_radix(digits, 16)
                .map_err(|_| format!("invalid JavaScript Unicode escape \\u{digits}"))?;
            if (0xD800..=0xDBFF).contains(&value)
                && bytes.get(index + 6) == Some(&b'\\')
                && bytes.get(index + 7) == Some(&b'u')
                && bytes.get(index + 8).is_some_and(u8::is_ascii_hexdigit)
                && bytes.get(index + 9).is_some_and(u8::is_ascii_hexdigit)
                && bytes.get(index + 10).is_some_and(u8::is_ascii_hexdigit)
                && bytes.get(index + 11).is_some_and(u8::is_ascii_hexdigit)
            {
                let low_digits = &pattern[index + 8..index + 12];
                let low = u16::from_str_radix(low_digits, 16)
                    .map_err(|_| format!("invalid JavaScript Unicode escape \\u{low_digits}"))?;
                if (0xDC00..=0xDFFF).contains(&low) {
                    let scalar =
                        0x10000 + ((u32::from(value) - 0xD800) << 10) + (u32::from(low) - 0xDC00);
                    output.push_str(&format!("\\u{{{scalar:X}}}"));
                    index += 12;
                    continue;
                }
            }
            output.push_str(&format!("\\u{{{value:X}}}"));
            index += 6;
            continue;
        }
        let character = pattern[index..]
            .chars()
            .next()
            .expect("index remains on a UTF-8 boundary");
        output.push(character);
        index += character.len_utf8();
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_bmp_and_surrogate_pair_unicode_escapes() {
        assert_eq!(
            translate_javascript_unicode_escapes(r"\u0061").unwrap(),
            r"\u{61}"
        );
        assert_eq!(
            translate_javascript_unicode_escapes(r"\uD83D\uDE00").unwrap(),
            r"\u{1F600}"
        );
    }
}
