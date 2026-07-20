use rustc_hash::FxHashMap;

pub type PathId = u32;

#[derive(Debug)]
pub struct InternedPath {
    normalized: String,
}

#[derive(Debug, Default)]
pub struct PathInterner {
    ids: FxHashMap<String, PathId>,
    paths: Vec<InternedPath>,
}

impl PathInterner {
    pub fn intern_relative(&mut self, root_dir: &str, path: &str) -> Result<PathId, String> {
        let normalized = relative_to_root(root_dir, path)?;
        if let Some(id) = self.ids.get(&normalized) {
            return Ok(*id);
        }

        let id = PathId::try_from(self.paths.len())
            .map_err(|_| "path interner exceeded the u32 path limit".to_owned())?;
        self.paths.push(InternedPath {
            normalized: normalized.clone(),
        });
        self.ids.insert(normalized, id);
        Ok(id)
    }

    pub fn text(&self, id: PathId) -> &str {
        &self.paths[id as usize].normalized
    }

    pub fn id(&self, normalized: &str) -> Option<PathId> {
        self.ids.get(normalized).copied()
    }
}

pub fn normalize_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();

    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." if segments.last().is_some_and(|last| *last != "..") => {
                segments.pop();
            }
            ".." if !absolute => segments.push(segment),
            ".." => {}
            _ => segments.push(segment),
        }
    }

    if absolute {
        format!("/{}", segments.join("/"))
    } else if segments.is_empty() {
        ".".to_owned()
    } else {
        segments.join("/")
    }
}

pub fn relative_to_root(root_dir: &str, path: &str) -> Result<String, String> {
    let root = normalize_path(root_dir);
    let normalized = normalize_path(path);

    if normalized == root {
        return Ok(".".to_owned());
    }

    if root == "." {
        if normalized.starts_with('/') {
            return Err(format!(
                "absolute path '{path}' cannot be made relative to rootDir '.'"
            ));
        }
        return Ok(normalized);
    }

    if root == "/" {
        return normalized
            .strip_prefix('/')
            .map(str::to_owned)
            .ok_or_else(|| format!("path '{path}' is outside rootDir '{root_dir}'"));
    }

    let prefix = format!("{root}/");
    if let Some(relative) = normalized.strip_prefix(&prefix) {
        return Ok(relative.to_owned());
    }

    if normalized.starts_with(&root) {
        return Ok(relative_path(&root, &normalized));
    }

    if !normalized.starts_with('/') {
        return Ok(normalized);
    }

    Err(format!("path '{path}' is outside rootDir '{root_dir}'"))
}

fn relative_path(root: &str, path: &str) -> String {
    let root_segments = root.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let path_segments = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    let common = root_segments
        .iter()
        .zip(&path_segments)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = vec![".."; root_segments.len() - common];
    relative.extend_from_slice(&path_segments[common..]);
    if relative.is_empty() {
        ".".to_owned()
    } else {
        relative.join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_mixed_separators_for_module_membership() {
        assert_eq!(
            relative_to_root("/repo/src", r"/repo/src/a\b/source.ts").unwrap(),
            r"a\b/source.ts"
        );
    }

    #[test]
    fn preserves_the_typescript_root_prefix_fallback() {
        assert_eq!(
            relative_to_root("/repo/src", "/repo/src2/x.ts").unwrap(),
            "../src2/x.ts"
        );
        assert!(relative_to_root("/repo/src", "/repo/other/x.ts").is_err());
    }
}
