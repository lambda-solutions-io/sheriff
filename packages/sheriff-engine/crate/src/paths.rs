use rustc_hash::FxHashMap;

pub type PathId = u32;

#[derive(Debug)]
pub struct InternedPath {
    normalized: String,
    segments: Vec<String>,
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
        let segments = if normalized == "." {
            Vec::new()
        } else {
            normalized.split('/').map(str::to_owned).collect()
        };
        self.paths.push(InternedPath {
            normalized: normalized.clone(),
            segments,
        });
        self.ids.insert(normalized, id);
        Ok(id)
    }

    pub fn text(&self, id: PathId) -> &str {
        &self.paths[id as usize].normalized
    }

    pub fn segments(&self, id: PathId) -> &[String] {
        &self.paths[id as usize].segments
    }

    pub fn id(&self, normalized: &str) -> Option<PathId> {
        self.ids.get(normalized).copied()
    }
}

pub fn normalize_path(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    let absolute = replaced.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();

    for segment in replaced.split('/') {
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

    if !normalized.starts_with('/') {
        return Ok(normalized);
    }

    Err(format!("path '{path}' is outside rootDir '{root_dir}'"))
}
