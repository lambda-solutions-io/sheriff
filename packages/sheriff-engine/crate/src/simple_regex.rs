#[derive(Debug, Clone)]
enum Expression {
    Alternation(Vec<Vec<Repeat>>),
}

#[derive(Debug, Clone)]
struct Repeat {
    atom: Atom,
    min: usize,
    max: Option<usize>,
}

#[derive(Debug, Clone)]
enum Atom {
    Literal(char),
    Any,
    Class(CharClass),
    Group(Box<Expression>),
    Start,
    End,
}

#[derive(Debug, Clone)]
struct CharClass {
    negated: bool,
    items: Vec<ClassItem>,
}

#[derive(Debug, Clone)]
enum ClassItem {
    Char(char),
    Range(char, char),
    Word,
    Digit,
    Space,
}

pub fn is_full_match(pattern: &str, value: &str) -> Result<bool, String> {
    let mut parser = Parser::new(pattern);
    let expression = parser.parse_expression(None)?;
    if parser.peek().is_some() {
        return Err(format!(
            "unsupported regex syntax near position {}",
            parser.index
        ));
    }

    let input: Vec<char> = value.chars().collect();
    Ok(match_expression(&expression, &input, 0)
        .into_iter()
        .any(|position| position == input.len()))
}

fn match_expression(expression: &Expression, input: &[char], start: usize) -> Vec<usize> {
    let Expression::Alternation(branches) = expression;
    let mut output = Vec::new();
    for branch in branches {
        output.extend(match_sequence(branch, input, start));
    }
    output.sort_unstable();
    output.dedup();
    output
}

fn match_sequence(sequence: &[Repeat], input: &[char], start: usize) -> Vec<usize> {
    let mut positions = vec![start];
    for repeat in sequence {
        let mut next = Vec::new();
        for position in positions {
            next.extend(match_repeat(repeat, input, position));
        }
        next.sort_unstable();
        next.dedup();
        positions = next;
        if positions.is_empty() {
            break;
        }
    }
    positions
}

fn match_repeat(repeat: &Repeat, input: &[char], start: usize) -> Vec<usize> {
    let max = repeat.max.unwrap_or(input.len().saturating_add(1));
    let mut levels = vec![vec![start]];

    for _ in 0..max {
        let mut next = Vec::new();
        for position in levels.last().expect("repeat always has an initial level") {
            next.extend(match_atom(&repeat.atom, input, *position));
        }
        next.sort_unstable();
        next.dedup();
        next.retain(|position| !levels.last().is_some_and(|last| last.contains(position)));
        if next.is_empty() {
            break;
        }
        levels.push(next);
    }

    let mut output = Vec::new();
    for level in levels.into_iter().skip(repeat.min) {
        output.extend(level);
    }
    output.sort_unstable();
    output.dedup();
    output
}

fn match_atom(atom: &Atom, input: &[char], position: usize) -> Vec<usize> {
    match atom {
        Atom::Literal(expected) if input.get(position) == Some(expected) => vec![position + 1],
        Atom::Any if input.get(position).is_some() => vec![position + 1],
        Atom::Class(class)
            if input
                .get(position)
                .is_some_and(|value| class.matches(*value)) =>
        {
            vec![position + 1]
        }
        Atom::Group(expression) => match_expression(expression, input, position),
        Atom::Start if position == 0 => vec![position],
        Atom::End if position == input.len() => vec![position],
        _ => Vec::new(),
    }
}

impl CharClass {
    fn matches(&self, value: char) -> bool {
        let matches = self.items.iter().any(|item| match item {
            ClassItem::Char(expected) => *expected == value,
            ClassItem::Range(start, end) => *start <= value && value <= *end,
            ClassItem::Word => value.is_ascii_alphanumeric() || value == '_',
            ClassItem::Digit => value.is_ascii_digit(),
            ClassItem::Space => value.is_whitespace(),
        });
        matches != self.negated
    }
}

struct Parser {
    chars: Vec<char>,
    index: usize,
}

impl Parser {
    fn new(pattern: &str) -> Self {
        Self {
            chars: pattern.chars().collect(),
            index: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.index).copied()
    }

    fn next(&mut self) -> Option<char> {
        let value = self.peek()?;
        self.index += 1;
        Some(value)
    }

    fn parse_expression(&mut self, terminator: Option<char>) -> Result<Expression, String> {
        let mut branches = Vec::new();
        let mut branch = Vec::new();

        loop {
            match self.peek() {
                Some(value) if Some(value) == terminator => {
                    self.next();
                    branches.push(branch);
                    return Ok(Expression::Alternation(branches));
                }
                Some('|') => {
                    self.next();
                    branches.push(branch);
                    branch = Vec::new();
                }
                Some(_) => branch.push(self.parse_repeat()?),
                None if terminator.is_some() => return Err("unclosed regex group".to_owned()),
                None => {
                    branches.push(branch);
                    return Ok(Expression::Alternation(branches));
                }
            }
        }
    }

    fn parse_repeat(&mut self) -> Result<Repeat, String> {
        let atom = self.parse_atom()?;
        let (min, max) = match self.peek() {
            Some('*') => {
                self.next();
                (0, None)
            }
            Some('+') => {
                self.next();
                (1, None)
            }
            Some('?') => {
                self.next();
                (0, Some(1))
            }
            Some('{') => self.parse_braced_repeat()?,
            _ => (1, Some(1)),
        };
        Ok(Repeat { atom, min, max })
    }

    fn parse_atom(&mut self) -> Result<Atom, String> {
        match self.next() {
            Some('.') => Ok(Atom::Any),
            Some('^') => Ok(Atom::Start),
            Some('$') => Ok(Atom::End),
            Some('(') => {
                if self.peek() == Some('?') {
                    self.next();
                    if self.next() != Some(':') {
                        return Err(
                            "only non-capturing '(?:...)' regex groups are supported".to_owned()
                        );
                    }
                }
                Ok(Atom::Group(Box::new(self.parse_expression(Some(')'))?)))
            }
            Some('[') => Ok(Atom::Class(self.parse_class()?)),
            Some('\\') => self.parse_escape_atom(),
            Some(value @ ('*' | '+' | '?' | '{' | '}' | ')' | '|')) => {
                Err(format!("unexpected regex token '{value}'"))
            }
            Some(value) => Ok(Atom::Literal(value)),
            None => Err("expected a regex atom".to_owned()),
        }
    }

    fn parse_escape_atom(&mut self) -> Result<Atom, String> {
        match self.next() {
            Some('w') => Ok(Atom::Class(CharClass {
                negated: false,
                items: vec![ClassItem::Word],
            })),
            Some('W') => Ok(Atom::Class(CharClass {
                negated: true,
                items: vec![ClassItem::Word],
            })),
            Some('d') => Ok(Atom::Class(CharClass {
                negated: false,
                items: vec![ClassItem::Digit],
            })),
            Some('D') => Ok(Atom::Class(CharClass {
                negated: true,
                items: vec![ClassItem::Digit],
            })),
            Some('s') => Ok(Atom::Class(CharClass {
                negated: false,
                items: vec![ClassItem::Space],
            })),
            Some('S') => Ok(Atom::Class(CharClass {
                negated: true,
                items: vec![ClassItem::Space],
            })),
            Some('n') => Ok(Atom::Literal('\n')),
            Some('r') => Ok(Atom::Literal('\r')),
            Some('t') => Ok(Atom::Literal('\t')),
            Some(value) => Ok(Atom::Literal(value)),
            None => Err("regex ends with an escape".to_owned()),
        }
    }

    fn parse_class(&mut self) -> Result<CharClass, String> {
        let negated = self.peek() == Some('^');
        if negated {
            self.next();
        }
        let mut items = Vec::new();

        while let Some(value) = self.peek() {
            if value == ']' && !items.is_empty() {
                self.next();
                return Ok(CharClass { negated, items });
            }

            let first = self.parse_class_item()?;
            if let ClassItem::Char(start) = first {
                if self.peek() == Some('-') && self.chars.get(self.index + 1) != Some(&']') {
                    self.next();
                    match self.parse_class_item()? {
                        ClassItem::Char(end) => items.push(ClassItem::Range(start, end)),
                        _ => return Err("regex class range must end in a literal".to_owned()),
                    }
                    continue;
                }
                items.push(ClassItem::Char(start));
            } else {
                items.push(first);
            }
        }

        Err("unclosed regex character class".to_owned())
    }

    fn parse_class_item(&mut self) -> Result<ClassItem, String> {
        match self.next() {
            Some('\\') => match self.next() {
                Some('w') => Ok(ClassItem::Word),
                Some('d') => Ok(ClassItem::Digit),
                Some('s') => Ok(ClassItem::Space),
                Some(value) => Ok(ClassItem::Char(value)),
                None => Err("regex class ends with an escape".to_owned()),
            },
            Some(value) => Ok(ClassItem::Char(value)),
            None => Err("unclosed regex character class".to_owned()),
        }
    }

    fn parse_braced_repeat(&mut self) -> Result<(usize, Option<usize>), String> {
        self.next();
        let min = self.parse_number()?;
        match self.next() {
            Some('}') => Ok((min, Some(min))),
            Some(',') => {
                if self.peek() == Some('}') {
                    self.next();
                    return Ok((min, None));
                }
                let max = self.parse_number()?;
                if self.next() != Some('}') || max < min {
                    return Err("invalid regex repeat range".to_owned());
                }
                Ok((min, Some(max)))
            }
            _ => Err("invalid regex repeat".to_owned()),
        }
    }

    fn parse_number(&mut self) -> Result<usize, String> {
        let start = self.index;
        while self.peek().is_some_and(|value| value.is_ascii_digit()) {
            self.next();
        }
        if start == self.index {
            return Err("regex repeat is missing a number".to_owned());
        }
        self.chars[start..self.index]
            .iter()
            .collect::<String>()
            .parse()
            .map_err(|_| "regex repeat number is too large".to_owned())
    }
}
