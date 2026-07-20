/**
 * Pure, DOM-free helpers for the Sheriff module-graph UI.
 * Loaded in the browser as `window.SheriffGraphHelpers`; the same file is
 * `require()`d under Node/Vitest — so keep it free of DOM/Cytoscape globals.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SheriffGraphHelpers = api;
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- tags -----------------------------------------------------------------

  /**
   * Sorted unique tags across all modules. Deterministic (alphabetical), so a
   * tag always keeps the same palette slot regardless of module iteration order.
   */
  function sortedTags(modules) {
    var seen = {};
    var tags = [];
    (modules || []).forEach(function (module) {
      (module.tags || []).forEach(function (tag) {
        if (!seen[tag]) {
          seen[tag] = true;
          tags.push(tag);
        }
      });
    });
    tags.sort();
    return tags;
  }

  /**
   * Map<tag,color> assigning each tag a palette slot by its sorted position.
   * Deterministic and collision-free (unlike a hash) for the first
   * palette.length tags; wraps around after that.
   */
  function assignTagColors(modules, palette) {
    var map = new Map();
    var tags = sortedTags(modules);
    tags.forEach(function (tag, index) {
      map.set(tag, palette[index % palette.length]);
    });
    return map;
  }

  // ---- faceted filters ------------------------------------------------------

  /**
   * Set<moduleId> of modules passing ALL active facet groups.
   * OR within a group, AND across groups. An empty/absent group is inactive
   * (matches everything). `violationOnly` keeps only modules with violations.
   */
  function filterModuleIds(graph, filters) {
    var result = new Set();
    var f = filters || {};
    var tags = toArray(f.tags);
    var projects = toArray(f.projects);
    var moduleTypes = toArray(f.moduleTypes);
    (graph.modules || []).forEach(function (module) {
      if (tags.length && !intersects(module.tags, tags)) {
        return;
      }
      if (projects.length && !intersects(module.projectNames, projects)) {
        return;
      }
      if (moduleTypes.length && moduleTypes.indexOf(module.moduleType) === -1) {
        return;
      }
      if (f.violationOnly && !module.hasViolations) {
        return;
      }
      result.add(module.id);
    });
    return result;
  }

  function toArray(value) {
    if (!value) {
      return [];
    }
    if (value instanceof Set) {
      return Array.from(value);
    }
    return Array.isArray(value) ? value : [];
  }

  function intersects(haystack, needles) {
    var list = haystack || [];
    for (var i = 0; i < list.length; i += 1) {
      if (needles.indexOf(list[i]) !== -1) {
        return true;
      }
    }
    return false;
  }

  // ---- rail search ----------------------------------------------------------

  /**
   * Whether a facet-row label matches a search query. An empty/blank query
   * matches everything, so clearing the search restores every row.
   */
  function rowMatchesQuery(label, query) {
    var q = String(query || "").trim().toLowerCase();
    if (!q) {
      return true;
    }
    return String(label || "").toLowerCase().indexOf(q) !== -1;
  }

  // ---- externals ------------------------------------------------------------

  /**
   * Whether an external node (or an edge to it) should render, given the master
   * toggle and the per-library hidden set.
   */
  function isExternalVisible(externalId, showExternals, hiddenExternals) {
    if (!showExternals) {
      return false;
    }
    var hidden = hiddenExternals instanceof Set
      ? hiddenExternals
      : new Set(toArray(hiddenExternals));
    return !hidden.has(externalId);
  }

  // ---- violation drill-down -------------------------------------------------

  /**
   * Flatten every violation from module edges, file edges and unassigned into a
   * de-duplicated list. The same violation frequently appears on both a file
   * edge and its parent module edge; a stable key collapses those.
   * Each row carries `locate:{kind,id}` so the UI can select the offender:
   *   - moduleEdge  -> the module edge
   *   - unassigned  -> the module owning the source file (kind:'module')
   */
  function flattenViolations(graph) {
    var byKey = new Map();
    var filesById = new Map((graph.files || []).map(function (file) {
      return [file.id, file];
    }));

    function push(violation, locate) {
      if (!violation) {
        return;
      }
      var key = violationKey(violation);
      if (byKey.has(key)) {
        // Prefer a more specific locator (module edge / file) over a coarse one,
        // but never drop an existing precise one for a vaguer duplicate.
        var existing = byKey.get(key);
        if (!existing.locate && locate) {
          existing.locate = locate;
        }
        return;
      }
      byKey.set(key, {
        type: violation.type,
        sourceFile: violation.sourceFile,
        fromTag: violation.fromTag,
        toTags: violation.toTags,
        rawImport: violation.rawImport,
        externalLibrary: violation.externalLibrary,
        locate: locate || null
      });
    }

    (graph.moduleEdges || []).forEach(function (edge) {
      (edge.violations || []).forEach(function (violation) {
        push(violation, { kind: "moduleEdge", id: edge.id });
      });
    });
    (graph.fileEdges || []).forEach(function (edge) {
      (edge.violations || []).forEach(function (violation) {
        // Locate a file-edge violation on the module owning its source file, so
        // the drill-down can expand that module first.
        var file = filesById.get(edge.source);
        var locate = file ? { kind: "module", id: file.parent } : null;
        push(violation, locate);
      });
    });
    (graph.unassignedViolations || []).forEach(function (violation) {
      var file = filesById.get(violation.sourceFile);
      var locate = file ? { kind: "module", id: file.parent } : null;
      push(violation, locate);
    });

    return Array.from(byKey.values());
  }

  function violationKey(violation) {
    return [
      violation.type,
      violation.sourceFile || "",
      violation.rawImport || "",
      violation.externalLibrary || "",
      violation.fromTag || "",
      (violation.toTags || []).join(",")
    ].join("|");
  }

  // ---- URL / permalink state ------------------------------------------------

  /**
   * Serialize UI-only state into a URLSearchParams-style string (no leading #).
   * Only UI concerns travel here — never graph data. Round-trips with decode.
   */
  function encodeUiState(state) {
    var params = new URLSearchParams();
    var s = state || {};
    setStr(params, "sel", s.selectedId);
    setStr(params, "q", s.search);
    if (s.showExternals) {
      params.set("ext", "1");
    }
    setList(params, "hideExt", s.hiddenExternals);
    setList(params, "expanded", s.expanded);
    setList(params, "tags", s.filters && s.filters.tags);
    setList(params, "projects", s.filters && s.filters.projects);
    setList(params, "types", s.filters && s.filters.moduleTypes);
    if (s.filters && s.filters.violationOnly) {
      params.set("vio", "1");
    }
    if (s.activeTab && s.activeTab !== "details") {
      params.set("tab", s.activeTab);
    }
    if (s.focus && s.focus.id) {
      params.set("focus", s.focus.id);
      params.set("focusDepth", String(s.focus.depth || 1));
      if (s.focus.direction) {
        params.set("focusDir", s.focus.direction);
      }
    }
    return params.toString();
  }

  /**
   * Parse a hash string (with or without leading '#') back into UI state.
   * Tolerant of missing keys; the caller ignores ids that no longer exist.
   */
  function decodeUiState(hashString) {
    var raw = String(hashString || "");
    if (raw.charAt(0) === "#") {
      raw = raw.slice(1);
    }
    var params = new URLSearchParams(raw);
    var state = {
      selectedId: params.get("sel") || null,
      search: params.get("q") || "",
      showExternals: params.get("ext") === "1",
      hiddenExternals: getList(params, "hideExt"),
      expanded: getList(params, "expanded"),
      activeTab: params.get("tab") === "violations" ? "violations" : "details",
      filters: {
        tags: getList(params, "tags"),
        projects: getList(params, "projects"),
        moduleTypes: getList(params, "types"),
        violationOnly: params.get("vio") === "1"
      },
      focus: null
    };
    var focusId = params.get("focus");
    if (focusId) {
      state.focus = {
        id: focusId,
        depth: clampDepth(parseInt(params.get("focusDepth"), 10)),
        direction: normalizeDirection(params.get("focusDir"))
      };
    }
    return state;
  }

  // Focus depth is a small integer; clamp to a sane range so a hostile or
  // stale hash can never request an absurd traversal.
  var MAX_FOCUS_DEPTH = 5;

  function clampDepth(value) {
    if (!value || value < 1) {
      return 1;
    }
    return Math.min(value, MAX_FOCUS_DEPTH);
  }

  function normalizeDirection(value) {
    return value === "in" || value === "out" ? value : "both";
  }

  function setStr(params, key, value) {
    if (value) {
      params.set(key, String(value));
    }
  }

  function setList(params, key, value) {
    var list = toArray(value);
    if (list.length) {
      params.set(key, list.join(","));
    }
  }

  function getList(params, key) {
    var value = params.get(key);
    if (!value) {
      return [];
    }
    return value.split(",").filter(Boolean);
  }

  return {
    sortedTags: sortedTags,
    assignTagColors: assignTagColors,
    filterModuleIds: filterModuleIds,
    isExternalVisible: isExternalVisible,
    rowMatchesQuery: rowMatchesQuery,
    flattenViolations: flattenViolations,
    violationKey: violationKey,
    clampDepth: clampDepth,
    normalizeDirection: normalizeDirection,
    encodeUiState: encodeUiState,
    decodeUiState: decodeUiState,
    MAX_FOCUS_DEPTH: MAX_FOCUS_DEPTH
  };
}));
