(function () {
  "use strict";

  var POLL_MS = 2000;
  var palette = ["#4f8cff", "#2fbf9b", "#f2a541", "#d86c8f", "#8d7cf6", "#51a6a6", "#d6a34a", "#6fa8dc"];
  var state = {
    cy: null,
    graph: null,
    hash: "",
    polling: true,
    inFlight: false,
    expanded: new Set(),
    showExternals: false,
    firstLoad: true,
    pollTimer: 0,
    bannerDismissed: false
  };

  var el = {};

  document.addEventListener("DOMContentLoaded", function () {
    bindElements();
    initCy();
    bindEvents();
    poll();
  });

  function bindElements() {
    el.cy = document.getElementById("cy");
    el.summary = document.getElementById("summary");
    el.details = document.getElementById("details");
    el.pause = document.getElementById("pauseBtn");
    el.fit = document.getElementById("fitBtn");
    el.externals = document.getElementById("externalsToggle");
    el.search = document.getElementById("searchInput");
    el.banner = document.getElementById("banner");
    el.dismissBanner = document.getElementById("dismissBanner");
    el.empty = document.getElementById("emptyHint");
  }

  function initCy() {
    if (typeof cytoscape !== "function") {
      showFatal("Cytoscape runtime is missing.");
      return;
    }
    state.cy = cytoscape({
      container: el.cy,
      elements: [],
      minZoom: 0.08,
      maxZoom: 3,
      wheelSensitivity: 0.18,
      style: graphStyle()
    });

    state.cy.on("tap", "node", function (event) {
      var node = event.target;
      if (node.hasClass("module")) {
        toggleModule(node.id());
      }
      renderDetailsForNode(node);
    });

    state.cy.on("tap", "edge", function (event) {
      renderDetailsForEdge(event.target);
    });
  }

  function bindEvents() {
    el.pause.addEventListener("click", function () {
      state.polling = !state.polling;
      el.pause.textContent = state.polling ? "Pause" : "Resume";
      if (state.polling) {
        poll();
      }
    });
    el.fit.addEventListener("click", function () {
      fitGraph();
    });
    el.externals.addEventListener("change", function () {
      state.showExternals = el.externals.checked;
      applyVisibility();
    });
    el.search.addEventListener("input", function () {
      applySearch(el.search.value);
    });
    el.dismissBanner.addEventListener("click", function () {
      state.bannerDismissed = true;
      el.banner.hidden = true;
    });
  }

  function poll() {
    clearTimeout(state.pollTimer);
    if (!state.polling || state.inFlight || !state.cy) {
      return;
    }
    state.inFlight = true;
    fetch("/api/graph?hash=" + encodeURIComponent(state.hash))
      .then(function (res) {
        if (res.status === 503) {
          throw new Error("unreachable");
        }
        if (!res.ok) {
          throw new Error("HTTP " + res.status);
        }
        return res.json();
      })
      .then(function (payload) {
        hideBanner();
        if (payload.hash) {
          state.hash = payload.hash;
        }
        if (payload.changed) {
          state.graph = payload.graph || emptyGraph();
          try {
            renderGraph(state.graph);
          } catch (error) {
            // a render bug must not masquerade as a daemon outage
            console.error("sheriff-ui: render failed", error);
          }
        }
      })
      .catch(function (error) {
        console.error("sheriff-ui: poll failed", error);
        showBanner();
      })
      .finally(function () {
        state.inFlight = false;
        if (state.polling) {
          state.pollTimer = window.setTimeout(poll, POLL_MS);
        }
      });
  }

  function renderGraph(graph) {
    var viewport = { pan: state.cy.pan(), zoom: state.cy.zoom() };
    var before = idSet(state.cy.elements());
    var elements = buildElements(graph);
    var after = new Set(elements.map(function (item) { return item.data.id; }));
    var idsChanged = !sameSet(before, after);

    state.cy.batch(function () {
      syncElements(elements, after);
      applyVisibility();
      applySearch(el.search.value);
    });

    renderSummary(graph.violationSummary);
    el.empty.hidden = graph.modules.length !== 0;

    if (idsChanged) {
      state.cy.layout({ name: "cose", animate: false, fit: state.firstLoad, padding: 48 }).run();
      if (!state.firstLoad) {
        state.cy.pan(viewport.pan);
        state.cy.zoom(viewport.zoom);
      }
    } else {
      state.cy.pan(viewport.pan);
      state.cy.zoom(viewport.zoom);
    }
    if (state.firstLoad) {
      state.firstLoad = false;
      fitGraph();
    }
  }

  function buildElements(graph) {
    var items = [];
    graph.modules.forEach(function (module) {
      items.push({
        group: "nodes",
        data: {
          id: module.id,
          label: module.label,
          kind: "module",
          color: tagColor(module.tags[0]),
          module: module,
          violations: moduleViolations(graph, module.id)
        },
        classes: classList(["module", module.moduleType === "barrel-less" && "barrel-less", module.hasViolations && "has-violations", state.expanded.has(module.id) && "expanded"])
      });
    });
    graph.externals.forEach(function (external) {
      items.push({
        group: "nodes",
        data: { id: external.id, label: external.label, kind: "external", external: external },
        classes: "external"
      });
    });
    graph.moduleEdges.forEach(function (edge) {
      items.push({
        group: "edges",
        data: edgeData(edge, edge.importCount || 1, "moduleEdge"),
        classes: classList(["module-edge", edge.violations.length > 0 && "has-violations", isExternalId(edge.target) && "external-edge"])
      });
    });
    graph.files.forEach(function (file) {
      if (!state.expanded.has(file.parent)) {
        return;
      }
      items.push({
        group: "nodes",
        data: { id: fileId(file.id), parent: file.parent, label: basename(file.id), kind: "file", file: file, violations: fileViolations(graph, file.id) },
        classes: classList(["file", file.hasViolations && "has-violations"])
      });
    });
    graph.fileEdges.forEach(function (edge) {
      if (!fileEdgeVisible(graph, edge)) {
        return;
      }
      items.push({
        group: "edges",
        data: edgeData(edge, 1, "fileEdge", fileId(edge.source), isExternalId(edge.target) ? edge.target : fileId(edge.target)),
        classes: classList(["file-edge", edge.violations.length > 0 && "has-violations", isExternalId(edge.target) && "external-edge"])
      });
    });
    return items;
  }

  function syncElements(elements, nextIds) {
    state.cy.elements().forEach(function (item) {
      if (!nextIds.has(item.id())) {
        state.cy.remove(item);
      }
    });
    elements.forEach(function (item) {
      var existing = state.cy.getElementById(item.data.id);
      if (existing.length) {
        existing.data(item.data);
        existing.classes(item.classes || "");
      } else {
        state.cy.add(item);
      }
    });
  }

  function edgeData(edge, count, kind, source, target) {
    return {
      id: kind + ":" + edge.id,
      source: source || edge.source,
      target: target || edge.target,
      label: count > 1 ? String(count) : "",
      weight: Math.max(1, Math.log(count + 1) * 1.8),
      violations: edge.violations || [],
      edge: edge,
      kind: kind
    };
  }

  function graphStyle() {
    return [
      { selector: "node", style: {
        "label": "data(label)", "font-family": "system-ui, sans-serif", "font-size": 12, "text-wrap": "wrap", "text-max-width": 130,
        "color": "#d7dee8", "text-outline-width": 2, "text-outline-color": "#111827", "background-color": "#334155",
        "border-width": 1.5, "border-color": "#64748b", "width": 84, "height": 46
      }},
      { selector: ".module", style: { "shape": "round-rectangle", "background-color": "data(color)", "border-color": "#d8dee9", "border-width": 2, "padding": 12 }},
      { selector: ".barrel-less", style: { "border-style": "dashed" }},
      { selector: ".external", style: { "shape": "hexagon", "background-color": "#64748b", "border-color": "#94a3b8", "display": "none" }},
      { selector: ".file", style: { "shape": "rectangle", "background-color": "#1f2937", "border-color": "#526071", "font-size": 10, "width": 62, "height": 28 }},
      { selector: ".has-violations", style: { "border-color": "#ef4444", "border-width": 3, "color": "#fecaca" }},
      { selector: "edge", style: {
        "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "#8391a5", "line-color": "#8391a5",
        "width": "data(weight)", "label": "data(label)", "font-size": 10, "color": "#cbd5e1", "text-background-color": "#111827",
        "text-background-opacity": 0.85, "text-background-padding": 2, "arrow-scale": 0.9
      }},
      { selector: "edge.has-violations", style: { "line-color": "#ef4444", "target-arrow-color": "#ef4444", "width": 4 }},
      { selector: ".external-edge", style: { "display": "none" }},
      { selector: ".dimmed", style: { "opacity": 0.16 }},
      { selector: ".match", style: { "border-color": "#facc15", "border-width": 4, "opacity": 1 }}
    ];
  }

  function applyVisibility() {
    if (!state.cy) {
      return;
    }
    var display = state.showExternals ? "element" : "none";
    state.cy.$(".external, .external-edge").style("display", display);
  }

  function applySearch(term) {
    if (!state.cy) {
      return;
    }
    var query = term.trim().toLowerCase();
    state.cy.elements().removeClass("dimmed match");
    if (!query) {
      return;
    }
    state.cy.nodes().forEach(function (node) {
      var haystack = [node.id(), node.data("label")].join(" ").toLowerCase();
      if (haystack.indexOf(query) === -1) {
        node.addClass("dimmed");
      } else {
        node.addClass("match");
      }
    });
    state.cy.edges().forEach(function (edge) {
      if (!edge.source().hasClass("match") && !edge.target().hasClass("match")) {
        edge.addClass("dimmed");
      }
    });
  }

  function toggleModule(id) {
    if (!state.graph) {
      return;
    }
    if (state.expanded.has(id)) {
      state.expanded.delete(id);
    } else {
      state.expanded.add(id);
    }
    renderGraph(state.graph);
  }

  function fileEdgeVisible(graph, edge) {
    var filesById = new Map(graph.files.map(function (file) { return [file.id, file]; }));
    var source = filesById.get(edge.source);
    var target = filesById.get(edge.target);
    var sourceOpen = source && state.expanded.has(source.parent);
    var targetOpen = isExternalId(edge.target) || (target && state.expanded.has(target.parent));
    return Boolean(sourceOpen && targetOpen);
  }

  function renderSummary(summary) {
    var dep = summary && summary.dependencyRule || 0;
    var encap = summary && summary.encapsulation || 0;
    var external = summary && summary.externalRule || 0;
    var total = dep + encap + external;
    el.summary.innerHTML = total === 0
      ? '<span class="badge ok">✓ no violations</span>'
      : [
        badge("dep", dep),
        badge("encap", encap),
        badge("external", external)
      ].join("");
  }

  function badge(label, value) {
    return '<span class="badge ' + (value > 0 ? "bad" : "") + '">' + label + " " + value + "</span>";
  }

  function renderDetailsForNode(node) {
    var data = node.data();
    if (data.kind === "module") {
      var module = data.module;
      el.details.innerHTML = [
        "<h2>" + esc(module.label) + "</h2>",
        '<div class="chips">' + chips(module.tags) + "</div>",
        detailRow("type", module.moduleType),
        detailRow("projects", module.projectNames.join(", ") || "-"),
        detailRow("files", module.fileCount),
        violationsHtml(data.violations)
      ].join("");
      return;
    }
    if (data.kind === "file") {
      el.details.innerHTML = [
        "<h2>" + esc(basename(data.file.id)) + "</h2>",
        detailRow("path", data.file.id),
        detailRow("module", data.file.parent),
        violationsHtml(data.violations)
      ].join("");
      return;
    }
    el.details.innerHTML = ["<h2>" + esc(data.label) + "</h2>", detailRow("external", data.id)].join("");
  }

  function renderDetailsForEdge(edge) {
    var data = edge.data();
    el.details.innerHTML = [
      "<h2>Dependency</h2>",
      detailRow("from", data.edge.source),
      detailRow("to", data.edge.target),
      data.edge.importCount ? detailRow("imports", data.edge.importCount) : "",
      violationsHtml(data.violations)
    ].join("");
  }

  function violationsHtml(violations) {
    if (!violations || violations.length === 0) {
      return '<p class="muted">No violations.</p>';
    }
    return '<h3>Violations</h3><ul class="violations">' + violations.map(function (v) {
      var tags = v.fromTag || v.toTags ? detailLine((v.fromTag || "?") + " -> " + ((v.toTags || []).join(", ") || "?")) : "";
      var imp = v.rawImport || v.externalLibrary ? detailLine(v.rawImport || v.externalLibrary) : "";
      return '<li><strong>' + esc(formatType(v.type)) + "</strong>" + tags + imp + detailLine(v.sourceFile) + "</li>";
    }).join("") + "</ul>";
  }

  function moduleViolations(graph, moduleId) {
    var fromEdges = graph.moduleEdges
      .filter(function (edge) { return edge.source === moduleId || edge.target === moduleId; })
      .flatMap(function (edge) { return edge.violations || []; });
    // encapsulation violations have no resolvable edge; show them on the
    // module that contains their source file
    var unassigned = (graph.unassignedViolations || []).filter(function (v) {
      return fileParent(graph, v.sourceFile) === moduleId;
    });
    return fromEdges.concat(unassigned);
  }

  function fileViolations(graph, filePath) {
    var fromEdges = graph.fileEdges
      .filter(function (edge) { return edge.source === filePath || edge.target === filePath; })
      .flatMap(function (edge) { return edge.violations || []; });
    var unassigned = (graph.unassignedViolations || []).filter(function (v) {
      return v.sourceFile === filePath;
    });
    return fromEdges.concat(unassigned);
  }

  function fileParent(graph, filePath) {
    var file = graph.files.find(function (candidate) { return candidate.id === filePath; });
    return file ? file.parent : undefined;
  }

  function tagColor(tag) {
    if (!tag) {
      return "#3f5066";
    }
    var hash = 0;
    for (var i = 0; i < tag.length; i += 1) {
      hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
    }
    return palette[hash % palette.length];
  }

  function classList(items) {
    return items.filter(Boolean).join(" ");
  }

  function fileId(path) {
    return "file:" + path;
  }

  function isExternalId(id) {
    return id.indexOf("ext:") === 0;
  }

  function basename(path) {
    return path.split("/").pop() || path;
  }

  function idSet(collection) {
    var ids = new Set();
    collection.forEach(function (item) { ids.add(item.id()); });
    return ids;
  }

  function sameSet(a, b) {
    if (a.size !== b.size) {
      return false;
    }
    var same = true;
    a.forEach(function (value) {
      if (!b.has(value)) {
        same = false;
      }
    });
    return same;
  }

  function fitGraph() {
    if (state.cy && state.cy.elements(":visible").length) {
      state.cy.fit(state.cy.elements(":visible"), 48);
    }
  }

  function showBanner() {
    if (!state.bannerDismissed) {
      el.banner.hidden = false;
    }
  }

  function hideBanner() {
    state.bannerDismissed = false;
    el.banner.hidden = true;
  }

  function showFatal(message) {
    el.empty.hidden = false;
    el.empty.textContent = message;
  }

  function emptyGraph() {
    return {
      modules: [], files: [], externals: [], moduleEdges: [], fileEdges: [],
      violationSummary: { encapsulation: 0, dependencyRule: 0, externalRule: 0, filesWithViolations: 0 },
      unassignedViolations: []
    };
  }

  function detailRow(label, value) {
    return '<div class="detail-row"><span>' + esc(label) + "</span><b>" + esc(String(value)) + "</b></div>";
  }

  function detailLine(value) {
    return '<div class="detail-line">' + esc(String(value)) + "</div>";
  }

  function chips(values) {
    if (!values || values.length === 0) {
      return '<span class="chip">untagged</span>';
    }
    return values.map(function (value) { return '<span class="chip">' + esc(value) + "</span>"; }).join("");
  }

  function formatType(type) {
    return String(type).replace(/-/g, " ");
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }
}());
