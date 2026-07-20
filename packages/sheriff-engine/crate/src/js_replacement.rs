/// Replace the first literal match using JavaScript `String.replace`
/// replacement-string semantics.
pub fn replace_first(input: &str, needle: &str, replacement: &str) -> String {
    let Some(start) = input.find(needle) else {
        return input.to_owned();
    };
    let end = start + needle.len();
    let mut output = String::with_capacity(input.len() + replacement.len());
    output.push_str(&input[..start]);
    output.push_str(&expand(replacement, input, start, end));
    output.push_str(&input[end..]);
    output
}

/// Replace every literal match using JavaScript replacement-string semantics.
pub fn replace_all(input: &str, needle: &str, replacement: &str) -> String {
    let matches = input.match_indices(needle).collect::<Vec<_>>();
    if matches.is_empty() {
        return input.to_owned();
    }

    let mut output = String::new();
    let mut copied_until = 0;
    for (start, matched) in matches {
        output.push_str(&input[copied_until..start]);
        output.push_str(&expand(replacement, input, start, start + matched.len()));
        copied_until = start + matched.len();
    }
    output.push_str(&input[copied_until..]);
    output
}

fn expand(replacement: &str, input: &str, match_start: usize, match_end: usize) -> String {
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
            // Literal matching has no capture groups, so JavaScript leaves
            // every $n/$nn sequence untouched.
            '0'..='9' => {
                output.push_str(&replacement[index..characters.peek().unwrap().0]);
            }
            _ => output.push('$'),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::replace_first;

    #[test]
    fn first_replacement_expands_every_javascript_token() {
        let input = "pre@apppost";
        assert_eq!(replace_first(input, "@app", "$&"), input);
        assert_eq!(replace_first(input, "@app", "$`"), "preprepost");
        assert_eq!(replace_first(input, "@app", "$'"), "prepostpost");
        assert_eq!(replace_first(input, "@app", "$1"), "pre$1post");
        assert_eq!(replace_first(input, "@app", "$$"), "pre$post");
    }
}
