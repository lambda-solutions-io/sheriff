(function () {
  "use strict";

  var H = window.SheriffGraphHelpers;
  var POLL_MS = 2000;
  var MAX_POLL_MS = 30000;
  var palette = ["#4f8cff", "#2fbf9b", "#f2a541", "#d86c8f", "#8d7cf6", "#51a6a6", "#d6a34a", "#6fa8dc"];
  var PIN_STORAGE_PREFIX = "sheriff-ui:pins:";

  var state = {
    cy: null,
    graph: null,
    hash: "",
    polling: true,
    inFlight: false,
    expanded: new Set(),
    showExternals: false,
    hiddenExternals: new Set(),
    firstLoad: true,
    pollTimer: 0,
    pollDelay: POLL_MS,
    bannerDismissed: false,
    lastUpdated: 0,
    tagColors: new Map(),
    filters: { tags: new Set(), projects: new Set(), moduleTypes: new Set(), violationOnly: false },
    focus: null,
    selectedId: null,
    positionsById: new Map(),
    pinned: new Set(),
    activeTab: "details",
    restorePending: null,
    hashTimer: 0,
    statusTimer: 0
  };

  var el = {};

  document.addEventListener("DOMContentLoaded", function () {
    bindElements();
    initCy();
    readInitialHash();
    bindEvents();
    startStatusTicker();
    poll();
  });

  function bindElements() {
    el.cy = document.getElementById("cy");
    el.summary = document.getElementById("summary");
    el.details = document.getElementById("details");
    el.violationsPanel = document.getElementById("violationsPanel");
    el.pause = document.getElementById("pauseBtn");
    el.fit = document.getElementById("fitBtn");
    el.refresh = document.getElementById("refreshBtn");
    el.resetLayout = document.getElementById("resetLayoutBtn");
    el.externals = document.getElementById("externalsToggle");
    el.search = document.getElementById("searchInput");
    el.banner = document.getElementById("banner");
    el.dismissBanner = document.getElementById("dismissBanner");
    el.empty = document.getElementById("emptyHint");
    el.pollStatus = document.getElementById("pollStatus");
    el.legend = document.getElementById("legend");
    el.tagFacets = document.getElementById("tagFacets");
    el.projectFacets = document.getElementById("projectFacets");
    el.typeFacets = document.getElementById("typeFacets");
    el.externalRail = document.getElementById("externalRail");
    el.externalFacets = document.getElementById("externalFacets");
    el.externalSearch = document.getElementById("externalSearch");
    el.violationOnly = document.getElementById("violationOnlyToggle");
    el.clearFilters = document.getElementById("clearFiltersBtn");
    el.tabDetails = document.getElementById("tabDetails");
    el.tabViolations = document.getElementById("tabViolations");
    el.focusBar = document.getElementById("focusBar");
    el.focusLabel = document.getElementById("focusLabel");
    el.clearFocus = document.getElementById("clearFocusBtn");
    el.focusDepthDown = document.getElementById("focusDepthDown");
    el.focusDepthUp = document.getElementById("focusDepthUp");
    el.focusDepthValue = document.getElementById("focusDepthValue");
    el.focusDirection = document.getElementById("focusDirection");
    el.rail = document.getElementById("filterRail");
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

    // Single-tap selects only (no expansion, no relayout) — inspection stays
    // cheap. Expansion/pinning have explicit buttons in the details panel.
    state.cy.on("tap", "node", function (event) {
      var node = event.target;
      state.selectedId = node.id();
      state.activeTab = "details";
      syncTabs();
      renderDetailsForNode(node);
      scheduleHashWrite();
    });

    state.cy.on("tap", "edge", function (event) {
      state.selectedId = event.target.id();
      state.activeTab = "details";
      syncTabs();
      renderDetailsForEdge(event.target);
      scheduleHashWrite();
    });

    // Power-user shortcut: double-tap a module toggles its file-level expansion.
    // (The discoverable path is the "Expand files" button in the details panel.)
    state.cy.on("dbltap", "node", function (event) {
      var node = event.target;
      if (node.hasClass("module")) {
        toggleModule(node.id());
      }
    });

    state.cy.on("dragfree", "node", function (event) {
      var node = event.target;
      state.positionsById.set(node.id(), { x: node.position("x"), y: node.position("y") });
      if (state.pinned.has(node.id())) {
        savePins();
      }
    });
  }

  function readInitialHash() {
    if (!H) {
      return;
    }
    try {
      var decoded = H.decodeUiState(location.hash);
      state.restorePending = decoded;
      // Apply the parts that don't depend on the graph immediately, so the very
      // first render already reflects the permalink.
      state.showExternals = decoded.showExternals;
      el.externals.checked = decoded.showExternals;
      state.hiddenExternals = new Set(decoded.hiddenExternals);
      state.filters = {
        tags: new Set(decoded.filters.tags),
        projects: new Set(decoded.filters.projects),
        moduleTypes: new Set(decoded.filters.moduleTypes),
        violationOnly: decoded.filters.violationOnly
      };
      el.violationOnly.checked = decoded.filters.violationOnly;
      el.search.value = decoded.search;
      state.selectedId = decoded.selectedId;
      state.focus = decoded.focus;
      // Expansion must be restored before the first render so the file nodes a
      // permalinked selection/focus may point at actually exist.
      state.expanded = new Set(decoded.expanded);
      state.activeTab = decoded.activeTab;
    } catch (error) {
      console.error("sheriff-ui: bad hash state", error);
    }
  }

  function bindEvents() {
    el.pause.addEventListener("click", function () {
      state.polling = !state.polling;
      el.pause.textContent = state.polling ? "Pause" : "Resume";
      if (state.polling) {
        state.pollDelay = POLL_MS;
        poll();
      } else {
        clearTimeout(state.pollTimer);
      }
      renderStatus();
    });
    el.fit.addEventListener("click", fitGraph);
    el.refresh.addEventListener("click", function () {
      state.pollDelay = POLL_MS;
      poll(true);
    });
    el.resetLayout.addEventListener("click", resetLayout);
    el.externals.addEventListener("change", function () {
      state.showExternals = el.externals.checked;
      renderExternalRail();
      applyVisibility();
      scheduleHashWrite();
    });
    el.externalSearch.addEventListener("input", renderExternalRail);
    el.violationOnly.addEventListener("change", function () {
      state.filters.violationOnly = el.violationOnly.checked;
      applyVisibility();
      scheduleHashWrite();
    });
    el.clearFilters.addEventListener("click", clearFilters);
    el.search.addEventListener("input", function () {
      applySearch(el.search.value);
      scheduleHashWrite();
    });
    el.dismissBanner.addEventListener("click", function () {
      state.bannerDismissed = true;
      el.banner.hidden = true;
    });
    el.tabDetails.addEventListener("click", function () { switchTab("details"); });
    el.tabViolations.addEventListener("click", function () { switchTab("violations"); });
    el.clearFocus.addEventListener("click", clearFocus);
    el.focusDepthDown.addEventListener("click", function () { adjustFocusDepth(-1); });
    el.focusDepthUp.addEventListener("click", function () { adjustFocusDepth(1); });
    el.focusDirection.addEventListener("change", function () { setFocusDirection(el.focusDirection.value); });
    wireFacetGroupActions();
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  // Per-group "all" / "none" controls in the facet headers. Delegated so they
  // work regardless of when the facet rows themselves render.
  function wireFacetGroupActions() {
    if (!el.rail) {
      return;
    }
    el.rail.querySelectorAll("[data-facet-all]").forEach(function (button) {
      button.addEventListener("click", function () {
        selectAllInGroup(button.getAttribute("data-facet-all"));
      });
    });
    el.rail.querySelectorAll("[data-facet-none]").forEach(function (button) {
      button.addEventListener("click", function () {
        clearGroup(button.getAttribute("data-facet-none"));
      });
    });
  }

  function groupValues(group) {
    if (!state.graph) {
      return [];
    }
    if (group === "tags") {
      return H ? H.sortedTags(state.graph.modules) : [];
    }
    if (group === "projects") {
      var counts = countBy(state.graph.modules, function (m) { return m.projectNames || []; });
      return Object.keys(counts);
    }
    if (group === "moduleTypes") {
      return ["barrel", "barrel-less"];
    }
    return [];
  }

  function selectAllInGroup(group) {
    var set = state.filters[group];
    if (!set) {
      return;
    }
    groupValues(group).forEach(function (value) { set.add(value); });
    afterFilterChange();
  }

  function clearGroup(group) {
    var set = state.filters[group];
    if (!set) {
      return;
    }
    set.clear();
    afterFilterChange();
  }

  function afterFilterChange() {
    if (state.graph) {
      renderFacets(state.graph);
      renderLegend(state.graph);
    }
    applyVisibility();
    renderEmptyState(state.graph || emptyGraph());
    scheduleHashWrite();
  }

  // ---- polling --------------------------------------------------------------

  function poll(force) {
    clearTimeout(state.pollTimer);
    if (!state.cy) {
      return;
    }
    if (!force && (!state.polling || state.inFlight)) {
      return;
    }
    if (document.visibilityState === "hidden" && !force) {
      return; // paused while backgrounded; resumes on visibilitychange
    }
    state.inFlight = true;
    renderStatus();
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
        state.pollDelay = POLL_MS; // healthy response resets backoff
        state.lastUpdated = Date.now();
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
        // exponential backoff on repeated failure, capped
        state.pollDelay = Math.min(state.pollDelay * 2, MAX_POLL_MS);
      })
      .finally(function () {
        state.inFlight = false;
        renderStatus();
        if (state.polling && document.visibilityState !== "hidden") {
          state.pollTimer = window.setTimeout(poll, state.pollDelay);
        }
      });
  }

  function onVisibilityChange() {
    if (document.visibilityState === "hidden") {
      clearTimeout(state.pollTimer);
    } else if (state.polling) {
      state.pollDelay = POLL_MS;
      poll(); // immediate refresh on return
    }
  }

  function startStatusTicker() {
    clearInterval(state.statusTimer);
    state.statusTimer = window.setInterval(renderStatus, 1000);
  }

  function renderStatus() {
    if (!el.pollStatus) {
      return;
    }
    if (!state.polling) {
      el.pollStatus.textContent = "paused";
      el.pollStatus.classList.remove("stale");
      return;
    }
    if (state.inFlight) {
      el.pollStatus.textContent = "updating…";
      el.pollStatus.classList.remove("stale");
      return;
    }
    if (!state.lastUpdated) {
      el.pollStatus.textContent = "";
      return;
    }
    var secs = Math.max(0, Math.round((Date.now() - state.lastUpdated) / 1000));
    el.pollStatus.textContent = "updated " + secs + "s ago";
    el.pollStatus.classList.toggle("stale", secs > 10);
  }

  // ---- rendering ------------------------------------------------------------

  function renderGraph(graph) {
    var viewport = { pan: state.cy.pan(), zoom: state.cy.zoom() };
    // Capture current positions before the sync so existing nodes stay put.
    captureCurrentPositions();
    var before = idSet(state.cy.elements());

    state.tagColors = H ? H.assignTagColors(graph.modules, palette) : new Map();

    var elements = buildElements(graph);
    var after = new Set(elements.map(function (item) { return item.data.id; }));
    var idsChanged = !sameSet(before, after);
    var newNodeIds = diffNodes(elements, before);

    state.cy.batch(function () {
      syncElements(elements, after);
      restorePositions();
      applyVisibility();
      applySearch(el.search.value);
    });

    renderSummary(graph.violationSummary);
    renderLegend(graph);
    renderFacets(graph);
    renderExternalRail();
    if (state.activeTab === "violations") {
      renderViolationsPanel();
    }
    renderEmptyState(graph);

    if (idsChanged) {
      layoutNewNodes(newNodeIds);
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
      loadPins();
      restoreFromHash();
      applyFocus(false);
      fitGraph();
    } else {
      applyFocus(false);
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
          color: moduleColor(module),
          module: module,
          violations: moduleViolations(graph, module.id)
        },
        classes: classList(["module", module.moduleType === "barrel-less" && "barrel-less", module.hasViolations && "has-violations", state.expanded.has(module.id) && "expanded", state.pinned.has(module.id) && "pinned"])
      });
    });
    graph.externals.forEach(function (external) {
      items.push({
        group: "nodes",
        data: { id: external.id, label: external.label, kind: "external", external: external },
        classes: classList(["external", state.pinned.has(external.id) && "pinned"])
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
      { selector: ".pinned", style: { "border-color": "#facc15", "border-width": 4, "border-style": "double" }},
      { selector: "edge", style: {
        "curve-style": "bezier", "target-arrow-shape": "triangle", "target-arrow-color": "#8391a5", "line-color": "#8391a5",
        "width": "data(weight)", "label": "data(label)", "font-size": 10, "color": "#cbd5e1", "text-background-color": "#111827",
        "text-background-opacity": 0.85, "text-background-padding": 2, "arrow-scale": 0.9
      }},
      { selector: "edge.has-violations", style: { "line-color": "#ef4444", "target-arrow-color": "#ef4444", "width": 4 }},
      { selector: ".external-edge", style: { "display": "none" }},
      { selector: ".hidden-facet", style: { "display": "none" }},
      { selector: ".dimmed", style: { "opacity": 0.16 }},
      { selector: ".match", style: { "border-color": "#facc15", "border-width": 4, "opacity": 1 }},
      { selector: ".selected", style: { "border-color": "#4f8cff", "border-width": 4 }},
      { selector: ".out-of-focus", style: { "display": "none" }}
    ];
  }

  // ---- visibility (filters + externals) -------------------------------------

  function applyVisibility() {
    if (!state.cy || !state.graph) {
      return;
    }
    var passing = H ? H.filterModuleIds(state.graph, state.filters) : allModuleIds();

    state.cy.batch(function () {
      // modules pass/fail the facet filter
      state.cy.nodes(".module").forEach(function (node) {
        setFacetHidden(node, !passing.has(node.id()));
      });
      // files inherit their parent module's facet visibility
      state.cy.nodes(".file").forEach(function (node) {
        var parent = node.data("parent");
        setFacetHidden(node, !passing.has(parent));
      });
      // edges hidden if either endpoint's module is filtered out (no dangling)
      state.cy.edges().forEach(function (edge) {
        var hide = facetHiddenNode(edge.source()) || facetHiddenNode(edge.target());
        setFacetHidden(edge, hide);
      });
      // externals: master toggle + per-library hidden set
      state.cy.nodes(".external").forEach(function (node) {
        var visible = H
          ? H.isExternalVisible(node.id(), state.showExternals, state.hiddenExternals)
          : state.showExternals;
        node.style("display", visible ? "element" : "none");
      });
      state.cy.edges(".external-edge").forEach(function (edge) {
        var visible = H
          ? H.isExternalVisible(edge.target().id(), state.showExternals, state.hiddenExternals)
          : state.showExternals;
        // still honor facet hiding of the source module
        if (visible) {
          visible = !facetHiddenNode(edge.source());
        }
        edge.style("display", visible ? "element" : "none");
      });
    });
  }

  function setFacetHidden(item, hidden) {
    if (hidden) {
      item.addClass("hidden-facet");
    } else {
      item.removeClass("hidden-facet");
    }
  }

  function facetHiddenNode(node) {
    return node.hasClass("hidden-facet");
  }

  function allModuleIds() {
    var set = new Set();
    (state.graph.modules || []).forEach(function (m) { set.add(m.id); });
    return set;
  }

  // ---- search ---------------------------------------------------------------

  function applySearch(term) {
    // Search narrows the rail lists (nx-style) in addition to dimming the graph.
    applyRailSearch(term);
    if (!state.cy) {
      return;
    }
    var query = String(term || "").trim().toLowerCase();
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

  // Hide facet/external rows whose label doesn't match the search; clearing the
  // query restores every row. A "no matches" hint replaces an emptied group.
  function applyRailSearch(term) {
    var query = el.search ? el.search.value : term;
    // The external rail has its own dedicated search input, so it's excluded.
    [el.tagFacets, el.projectFacets, el.typeFacets].forEach(function (container) {
      if (container) {
        filterRailRows(container, query);
      }
    });
  }

  function filterRailRows(container, query) {
    var rows = container.querySelectorAll(".facet");
    var anyVisible = false;
    rows.forEach(function (row) {
      var label = row.querySelector(".facet-label");
      var text = label ? label.textContent : "";
      var match = !H || H.rowMatchesQuery(text, query);
      row.hidden = !match;
      if (match) {
        anyVisible = true;
      }
    });
    var hint = container.querySelector(".facet-empty");
    if (rows.length && !anyVisible) {
      if (!hint) {
        hint = document.createElement("span");
        hint.className = "facet-empty muted";
        hint.textContent = "no matches";
        container.appendChild(hint);
      }
      hint.hidden = false;
    } else if (hint) {
      hint.hidden = true;
    }
  }

  // ---- layout + pinning -----------------------------------------------------

  function captureCurrentPositions() {
    state.cy.nodes().forEach(function (node) {
      state.positionsById.set(node.id(), { x: node.position("x"), y: node.position("y") });
    });
  }

  function restorePositions() {
    state.cy.nodes().forEach(function (node) {
      var saved = state.positionsById.get(node.id());
      if (saved) {
        node.position(saved);
      }
      if (state.pinned.has(node.id())) {
        node.lock();
      } else {
        node.unlock();
      }
    });
  }

  function diffNodes(elements, before) {
    var ids = [];
    elements.forEach(function (item) {
      if (item.group === "nodes" && !before.has(item.data.id) && !state.positionsById.has(item.data.id)) {
        ids.push(item.data.id);
      }
    });
    return ids;
  }

  function layoutNewNodes(newNodeIds) {
    // Live updates must not reshuffle the whole graph: on the first load run a
    // full cose fit; afterwards lay out ONLY genuinely new nodes with existing
    // ones locked in place.
    if (state.firstLoad || !state.positionsById.size) {
      state.cy.layout({ name: "cose", animate: false, fit: state.firstLoad, padding: 48, randomize: false }).run();
      return;
    }
    if (!newNodeIds.length) {
      return;
    }
    var newNodes = state.cy.collection();
    newNodeIds.forEach(function (id) {
      var node = state.cy.getElementById(id);
      if (node.length) {
        newNodes = newNodes.union(node);
      }
    });
    if (!newNodes.length) {
      return;
    }
    // lock everything else, lay out the new subset, then restore locks
    var others = state.cy.nodes().difference(newNodes);
    others.lock();
    newNodes.layout({ name: "cose", animate: false, fit: false, padding: 48, randomize: false }).run();
    others.unlock();
    restorePositions(); // re-apply pins
  }

  function togglePin(node) {
    var id = node.id();
    if (state.pinned.has(id)) {
      state.pinned.delete(id);
      node.unlock();
      node.removeClass("pinned");
    } else {
      state.pinned.add(id);
      state.positionsById.set(id, { x: node.position("x"), y: node.position("y") });
      node.lock();
      node.addClass("pinned");
    }
    savePins();
  }

  function pinStorageKey() {
    var root = state.graph && state.graph.rootDir ? state.graph.rootDir : "default";
    return PIN_STORAGE_PREFIX + root;
  }

  function savePins() {
    try {
      // Prune pins for ids no longer in the current graph so storage can't
      // grow unbounded as projects/modules come and go.
      var live = currentNodeIds();
      var payload = { pins: {} };
      state.pinned.forEach(function (id) {
        if (live && !live.has(id)) {
          return;
        }
        var pos = state.positionsById.get(id);
        payload.pins[id] = pos || null;
      });
      localStorage.setItem(pinStorageKey(), JSON.stringify(payload));
    } catch (error) {
      // storage may be unavailable (private mode); pins are best-effort
    }
  }

  function currentNodeIds() {
    if (!state.graph) {
      return null; // graph not loaded yet — don't prune blindly
    }
    var ids = new Set();
    (state.graph.modules || []).forEach(function (m) { ids.add(m.id); });
    (state.graph.externals || []).forEach(function (e) { ids.add(e.id); });
    (state.graph.files || []).forEach(function (f) { ids.add(fileId(f.id)); });
    return ids;
  }

  function loadPins() {
    try {
      var raw = localStorage.getItem(pinStorageKey());
      if (!raw) {
        return;
      }
      var payload = JSON.parse(raw);
      Object.keys(payload.pins || {}).forEach(function (id) {
        state.pinned.add(id);
        if (payload.pins[id]) {
          state.positionsById.set(id, payload.pins[id]);
        }
      });
      state.cy.batch(restorePositions);
      state.pinned.forEach(function (id) {
        state.cy.getElementById(id).addClass("pinned");
      });
    } catch (error) {
      // ignore corrupt storage
    }
  }

  function resetLayout() {
    state.positionsById = new Map();
    state.pinned = new Set();
    savePins();
    state.cy.nodes().unlock().removeClass("pinned");
    state.cy.layout({ name: "cose", animate: false, fit: true, padding: 48, randomize: true }).run();
    fitGraph();
  }

  // ---- focus / neighborhood -------------------------------------------------

  function applyFocus(refit) {
    state.cy.nodes().removeClass("out-of-focus");
    state.cy.edges().removeClass("out-of-focus");
    if (!state.focus || !state.focus.id) {
      el.focusBar.hidden = true;
      return;
    }
    var root = state.cy.getElementById(state.focus.id);
    if (!root.length) {
      el.focusBar.hidden = true;
      return; // permalinked id may no longer exist — ignore silently
    }
    var neighborhood = neighborhoodOf(root, state.focus.depth, state.focus.direction);
    state.cy.elements().difference(neighborhood).addClass("out-of-focus");
    el.focusBar.hidden = false;
    el.focusLabel.textContent = "Focus: " + root.data("label");
    el.focusDepthValue.textContent = String(state.focus.depth);
    el.focusDirection.value = state.focus.direction;
    // Only frame the subgraph when the focus actually changed; re-fitting on
    // every poll would discard the user's pan/zoom while focused.
    if (refit) {
      fitGraph();
    }
  }

  var MAX_FOCUS_DEPTH = H && H.MAX_FOCUS_DEPTH ? H.MAX_FOCUS_DEPTH : 5;

  function adjustFocusDepth(delta) {
    if (!state.focus) {
      return;
    }
    var next = Math.min(MAX_FOCUS_DEPTH, Math.max(1, state.focus.depth + delta));
    if (next === state.focus.depth) {
      return;
    }
    state.focus.depth = next;
    applyFocus(true);
    scheduleHashWrite();
  }

  function setFocusDirection(direction) {
    if (!state.focus) {
      return;
    }
    state.focus.direction = H ? H.normalizeDirection(direction) : direction;
    applyFocus(true);
    scheduleHashWrite();
  }

  function neighborhoodOf(root, depth, direction) {
    var collected = root;
    var frontier = root;
    for (var i = 0; i < depth; i += 1) {
      var next = state.cy.collection();
      frontier.forEach(function (node) {
        var edges;
        if (direction === "in") {
          edges = node.incomers("edge");
        } else if (direction === "out") {
          edges = node.outgoers("edge");
        } else {
          edges = node.connectedEdges();
        }
        next = next.union(edges).union(edges.connectedNodes());
      });
      collected = collected.union(next);
      frontier = next.nodes();
    }
    return collected;
  }

  function setFocus(depth, direction) {
    if (!state.selectedId) {
      return;
    }
    state.focus = { id: state.selectedId, depth: depth, direction: direction };
    applyFocus(true);
    scheduleHashWrite();
  }

  function clearFocus() {
    state.focus = null;
    applyFocus(true);
    scheduleHashWrite();
  }

  // ---- tabs -----------------------------------------------------------------

  function switchTab(tab) {
    state.activeTab = tab;
    syncTabs();
    if (tab === "violations") {
      renderViolationsPanel();
    }
  }

  function syncTabs() {
    var showViolations = state.activeTab === "violations";
    el.tabDetails.classList.toggle("active", !showViolations);
    el.tabViolations.classList.toggle("active", showViolations);
    el.tabDetails.setAttribute("aria-selected", String(!showViolations));
    el.tabViolations.setAttribute("aria-selected", String(showViolations));
    el.details.hidden = showViolations;
    el.violationsPanel.hidden = !showViolations;
  }

  // ---- summary + legend + facets --------------------------------------------

  function renderSummary(summary) {
    var dep = summary && summary.dependencyRule || 0;
    var encap = summary && summary.encapsulation || 0;
    var external = summary && summary.externalRule || 0;
    var total = dep + encap + external;
    el.summary.innerHTML = total === 0
      ? '<span class="badge ok">✓ no violations</span>'
      : [badge("dep", dep), badge("encap", encap), badge("external", external)].join("");
  }

  function badge(label, value) {
    return '<span class="badge ' + (value > 0 ? "bad" : "") + '">' + esc(label) + " " + esc(String(value)) + "</span>";
  }

  function renderLegend(graph) {
    var tags = H ? H.sortedTags(graph.modules) : [];
    var base = [
      '<div><span class="swatch module"></span>module</div>',
      '<div><span class="swatch external"></span>external</div>',
      '<div><span class="swatch violation"></span>violation</div>',
      '<div class="legend-hint">Select a node for actions — pin to lock its position.</div>'
    ].join("");
    var tagRows = tags.map(function (tag) {
      var active = state.filters.tags.has(tag);
      var color = state.tagColors.get(tag) || "#3f5066";
      return '<div class="legend-tag' + (active ? " active" : "") + '" data-tag="' + esc(tag) + '" role="button" tabindex="0">'
        + '<span class="swatch" style="background:' + esc(color) + '"></span>' + esc(tag) + "</div>";
    }).join("");
    el.legend.innerHTML = base + (tagRows ? '<div class="legend-tags">' + tagRows + "</div>" : "");
    el.legend.querySelectorAll(".legend-tag").forEach(function (row) {
      row.addEventListener("click", function () { toggleTagFilter(row.getAttribute("data-tag")); });
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleTagFilter(row.getAttribute("data-tag"));
        }
      });
    });
  }

  function renderFacets(graph) {
    renderTagFacets(graph);
    renderProjectFacets(graph);
    renderTypeFacets();
    applyRailSearch(el.search ? el.search.value : "");
  }

  function renderTagFacets(graph) {
    var counts = countBy(graph.modules, function (m) { return m.tags || []; });
    var tags = H ? H.sortedTags(graph.modules) : [];
    el.tagFacets.innerHTML = tags.map(function (tag) {
      var color = state.tagColors.get(tag) || "#3f5066";
      return facetRow("tag", tag, counts[tag] || 0, state.filters.tags.has(tag), color);
    }).join("") || '<span class="muted">none</span>';
    wireFacetRows(el.tagFacets, "tag", function (value) { toggleTagFilter(value); });
  }

  function renderProjectFacets(graph) {
    var counts = countBy(graph.modules, function (m) { return m.projectNames || []; });
    var projects = Object.keys(counts).sort();
    el.projectFacets.innerHTML = projects.map(function (project) {
      return facetRow("project", project, counts[project], state.filters.projects.has(project));
    }).join("") || '<span class="muted">none</span>';
    wireFacetRows(el.projectFacets, "project", function (value) { toggleSetFilter(state.filters.projects, value); });
  }

  function renderTypeFacets() {
    var types = ["barrel", "barrel-less"];
    el.typeFacets.innerHTML = types.map(function (type) {
      return facetRow("type", type, "", state.filters.moduleTypes.has(type));
    }).join("");
    wireFacetRows(el.typeFacets, "type", function (value) { toggleSetFilter(state.filters.moduleTypes, value); });
  }

  function renderExternalRail() {
    el.externalRail.hidden = !state.showExternals || !state.graph || !state.graph.externals.length;
    if (el.externalRail.hidden) {
      return;
    }
    var query = String(el.externalSearch.value || "").trim().toLowerCase();
    var libs = state.graph.externals.filter(function (ext) {
      return !query || ext.label.toLowerCase().indexOf(query) !== -1;
    });
    el.externalFacets.innerHTML = libs.map(function (ext) {
      var shown = !state.hiddenExternals.has(ext.id);
      // checkbox checked == visible
      return '<label class="facet"><input type="checkbox" data-ext="' + esc(ext.id) + '"' + (shown ? " checked" : "") + '>'
        + '<span class="facet-label">' + esc(ext.label) + "</span></label>";
    }).join("") || '<span class="muted">none</span>';
    el.externalFacets.querySelectorAll("input[data-ext]").forEach(function (input) {
      input.addEventListener("change", function () {
        var id = input.getAttribute("data-ext");
        if (input.checked) {
          state.hiddenExternals.delete(id);
        } else {
          state.hiddenExternals.add(id);
        }
        applyVisibility();
        scheduleHashWrite();
      });
    });
    // The external rail has its own search input; the main search only narrows
    // the facet groups, so don't cross-filter this list from applyRailSearch.
  }

  function facetRow(kind, value, count, checked, color) {
    var swatch = color ? '<span class="facet-swatch" style="background:' + esc(color) + '"></span>' : "";
    var countHtml = count === "" ? "" : '<span class="facet-count">' + esc(String(count)) + "</span>";
    return '<label class="facet"><input type="checkbox" data-' + esc(kind) + '="' + esc(value) + '"' + (checked ? " checked" : "") + ">"
      + swatch + '<span class="facet-label">' + esc(value) + "</span>" + countHtml + "</label>";
  }

  function wireFacetRows(container, kind, handler) {
    container.querySelectorAll("input[data-" + kind + "]").forEach(function (input) {
      input.addEventListener("change", function () {
        handler(input.getAttribute("data-" + kind));
      });
    });
  }

  function toggleTagFilter(tag) {
    if (!tag) {
      return;
    }
    toggleSetFilter(state.filters.tags, tag);
  }

  function toggleSetFilter(set, value) {
    if (set.has(value)) {
      set.delete(value);
    } else {
      set.add(value);
    }
    if (state.graph) {
      renderFacets(state.graph);
      renderLegend(state.graph);
    }
    applyVisibility();
    scheduleHashWrite();
  }

  function clearFilters() {
    state.filters = { tags: new Set(), projects: new Set(), moduleTypes: new Set(), violationOnly: false };
    el.violationOnly.checked = false;
    if (state.graph) {
      renderFacets(state.graph);
      renderLegend(state.graph);
    }
    applyVisibility();
    scheduleHashWrite();
  }

  function countBy(items, selector) {
    var counts = {};
    (items || []).forEach(function (item) {
      selector(item).forEach(function (key) {
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    return counts;
  }

  // ---- externals helpers ----------------------------------------------------

  function hideExternal(id) {
    state.hiddenExternals.add(id);
    renderExternalRail();
    applyVisibility();
    scheduleHashWrite();
  }

  // ---- details panels -------------------------------------------------------

  function renderDetailsForNode(node) {
    var data = node.data();
    var id = node.id();
    state.cy.nodes().removeClass("selected");
    node.addClass("selected");
    if (data.kind === "module") {
      var module = data.module;
      el.details.innerHTML = [
        "<h2>" + esc(module.label) + "</h2>",
        '<div class="chips">' + chips(module.tags) + "</div>",
        nodeActionsHtml(id, "module"),
        detailRow("type", module.moduleType),
        detailRow("projects", module.projectNames.join(", ") || "-"),
        detailRow("files", module.fileCount),
        focusActionsHtml(),
        violationsHtml(data.violations)
      ].join("");
      wireNodeActions(id);
      wireFocusActions();
      wireCopyButtons(el.details);
      return;
    }
    if (data.kind === "file") {
      el.details.innerHTML = [
        "<h2>" + esc(basename(data.file.id)) + "</h2>",
        nodeActionsHtml(id, "file"),
        detailRowCopyable("path", data.file.id),
        detailRow("module", data.file.parent),
        focusActionsHtml(),
        violationsHtml(data.violations)
      ].join("");
      wireNodeActions(id);
      wireFocusActions();
      wireCopyButtons(el.details);
      return;
    }
    el.details.innerHTML = [
      "<h2>" + esc(data.label) + "</h2>",
      nodeActionsHtml(id, "external"),
      detailRow("external", data.id)
    ].join("");
    wireNodeActions(id);
  }

  // Discoverable actions replacing the old hidden gestures: Expand/collapse a
  // module's files, pin/unpin any node, and hide an external library.
  function nodeActionsHtml(id, kind) {
    var buttons = [];
    if (kind === "module") {
      var expanded = state.expanded.has(id);
      buttons.push('<button type="button" data-action="expand">' + (expanded ? "Collapse files" : "Expand files") + "</button>");
    }
    var pinned = state.pinned.has(id);
    buttons.push('<button type="button" data-action="pin">' + (pinned ? "Unpin" : "Pin") + "</button>");
    if (kind === "external") {
      buttons.push('<button type="button" data-action="hide">Hide</button>');
    }
    return '<div class="node-actions" role="group" aria-label="Node actions">' + buttons.join("") + "</div>";
  }

  function wireNodeActions(id) {
    el.details.querySelectorAll(".node-actions [data-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        var action = button.getAttribute("data-action");
        if (action === "expand") {
          toggleModule(id);
          reselectAfterAction(id);
        } else if (action === "pin") {
          var node = state.cy.getElementById(id);
          if (node.length) {
            togglePin(node);
            reselectAfterAction(id);
          }
        } else if (action === "hide") {
          hideExternal(id);
        }
      });
    });
  }

  // toggleModule/togglePin change the graph; re-render the panel so its button
  // labels (Expand/Collapse, Pin/Unpin) reflect the new state.
  function reselectAfterAction(id) {
    var node = state.cy.getElementById(id);
    if (node.length) {
      renderDetailsForNode(node);
    }
  }

  function renderDetailsForEdge(edge) {
    state.cy.nodes().removeClass("selected");
    var data = edge.data();
    el.details.innerHTML = [
      "<h2>Dependency</h2>",
      detailRow("from", data.edge.source),
      detailRow("to", data.edge.target),
      data.edge.importCount ? detailRow("imports", data.edge.importCount) : "",
      violationsHtml(data.violations)
    ].join("");
    wireCopyButtons(el.details);
  }

  function focusActionsHtml() {
    return '<div class="focus-actions" role="group" aria-label="Focus this node">'
      + '<button type="button" data-focus="1|both">Focus (1 hop)</button>'
      + '<button type="button" data-focus="2|both">Focus (2 hops)</button>'
      + '<button type="button" data-focus="1|in">Incoming</button>'
      + '<button type="button" data-focus="1|out">Outgoing</button>'
      + '<button type="button" data-focus="clear">Clear focus</button>'
      + "</div>";
  }

  function wireFocusActions() {
    el.details.querySelectorAll("[data-focus]").forEach(function (button) {
      button.addEventListener("click", function () {
        var value = button.getAttribute("data-focus");
        if (value === "clear") {
          clearFocus();
          return;
        }
        var parts = value.split("|");
        setFocus(parseInt(parts[0], 10) || 1, parts[1]);
      });
    });
  }

  function violationsHtml(violations) {
    if (!violations || violations.length === 0) {
      return '<p class="muted">No violations.</p>';
    }
    return '<h3>Violations</h3><ul class="violations">' + violations.map(function (v) {
      var tags = v.fromTag || v.toTags ? detailLine((v.fromTag || "?") + " -> " + ((v.toTags || []).join(", ") || "?")) : "";
      var imp = v.rawImport || v.externalLibrary ? detailLine(v.rawImport || v.externalLibrary) : "";
      return '<li><strong>' + esc(formatType(v.type)) + "</strong>" + tags + imp + sourceFileLine(v.sourceFile) + "</li>";
    }).join("") + "</ul>";
  }

  // ---- violations drill-down ------------------------------------------------

  function renderViolationsPanel() {
    if (!state.graph || !H) {
      return;
    }
    var flat = H.flattenViolations(state.graph);
    if (!flat.length) {
      el.violationsPanel.innerHTML = '<h2>Violations</h2><p class="muted">No violations 🎉</p>';
      return;
    }
    var groups = groupViolationsByFile(flat);
    var files = Object.keys(groups).sort();
    var html = ['<h2>Violations</h2>', '<p class="vio-count">' + esc(String(flat.length)) + " violation" + (flat.length > 1 ? "s" : "") + " across " + esc(String(files.length)) + " file" + (files.length > 1 ? "s" : "") + "</p>"];
    files.forEach(function (file) {
      html.push('<div class="vio-group"><div class="vio-file">' + copyableText(file) + "</div>");
      groups[file].forEach(function (v, index) {
        var tags = v.fromTag || v.toTags ? detailLine((v.fromTag || "?") + " -> " + ((v.toTags || []).join(", ") || "?")) : "";
        var imp = v.rawImport || v.externalLibrary ? detailLine(v.rawImport || v.externalLibrary) : "";
        html.push('<div class="vio-row" role="button" tabindex="0" data-file="' + esc(file) + '" data-index="' + index + '">'
          + "<strong>" + esc(formatType(v.type)) + "</strong>" + tags + imp + "</div>");
      });
      html.push("</div>");
    });
    el.violationsPanel.innerHTML = html.join("");
    wireCopyButtons(el.violationsPanel);
    el.violationsPanel.querySelectorAll(".vio-row").forEach(function (row) {
      var handler = function () {
        var file = row.getAttribute("data-file");
        var idx = parseInt(row.getAttribute("data-index"), 10);
        locateViolation(groups[file][idx]);
      };
      row.addEventListener("click", handler);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handler();
        }
      });
    });
  }

  function groupViolationsByFile(flat) {
    var groups = {};
    flat.forEach(function (v) {
      var key = v.sourceFile || "(unknown)";
      (groups[key] = groups[key] || []).push(v);
    });
    // stable order within a file: by type
    Object.keys(groups).forEach(function (key) {
      groups[key].sort(function (a, b) { return String(a.type).localeCompare(String(b.type)); });
    });
    return groups;
  }

  function locateViolation(violation) {
    if (!violation || !violation.locate) {
      return;
    }
    var locate = violation.locate;
    if (locate.kind === "module") {
      // expand the offending module so its file-level detail is visible
      if (!state.expanded.has(locate.id)) {
        state.expanded.add(locate.id);
        renderGraph(state.graph);
      }
      var node = state.cy.getElementById(locate.id);
      if (node.length) {
        state.selectedId = node.id();
        state.activeTab = "details";
        syncTabs();
        renderDetailsForNode(node);
        centerOn(node);
      }
      return;
    }
    if (locate.kind === "moduleEdge") {
      var edge = state.cy.getElementById("moduleEdge:" + locate.id);
      if (edge.length) {
        state.selectedId = edge.id();
        state.activeTab = "details";
        syncTabs();
        renderDetailsForEdge(edge);
        centerOn(edge);
      }
    }
  }

  function centerOn(element) {
    state.cy.animate({ center: { eles: element }, zoom: Math.max(state.cy.zoom(), 0.6) }, { duration: 250 });
  }

  // ---- copy-path affordance -------------------------------------------------

  function sourceFileLine(sourceFile) {
    return '<div class="detail-line">' + copyableText(sourceFile) + "</div>";
  }

  function copyableText(text) {
    return esc(String(text)) + copyButton(text);
  }

  function copyButton(text) {
    return '<button type="button" class="copy-btn" data-copy="' + esc(String(text)) + '" aria-label="Copy path">copy</button>';
  }

  function wireCopyButtons(container) {
    container.querySelectorAll(".copy-btn").forEach(function (button) {
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        var value = button.getAttribute("data-copy");
        copyToClipboard(value, button);
      });
    });
  }

  function copyToClipboard(value, button) {
    var flash = function (ok) {
      button.classList.toggle("copied", ok);
      button.textContent = ok ? "copied" : "copy failed";
      window.setTimeout(function () {
        button.classList.remove("copied");
        button.textContent = "copy";
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // Only claim success once the write actually resolves; fall back on reject.
      navigator.clipboard.writeText(value).then(
        function () { flash(true); },
        function () { flash(execCommandCopy(value)); }
      );
    } else {
      // No async Clipboard API (older or insecure context): try execCommand,
      // and report honestly whether it worked.
      flash(execCommandCopy(value));
    }
  }

  function execCommandCopy(value) {
    try {
      var area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch (error) {
      return false;
    }
  }

  function detailRowCopyable(label, value) {
    return '<div class="detail-row"><span>' + esc(label) + "</span><b>" + copyableText(value) + "</b></div>";
  }

  // ---- graph helpers (violations lookup) ------------------------------------

  function moduleViolations(graph, moduleId) {
    var fromEdges = graph.moduleEdges
      .filter(function (edge) { return edge.source === moduleId || edge.target === moduleId; })
      .flatMap(function (edge) { return edge.violations || []; });
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

  function moduleColor(module) {
    var tag = (module.tags || [])[0];
    if (!tag) {
      return "#3f5066";
    }
    return state.tagColors.get(tag) || "#3f5066";
  }

  // ---- misc helpers ---------------------------------------------------------

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
    var visible = state.cy.elements(":visible").not(".out-of-focus, .hidden-facet");
    if (state.cy && visible.length) {
      state.cy.fit(visible, 48);
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

  // Distinct empty states so a blank canvas is never unexplained. Uses
  // textContent (not innerHTML), so the search term needs no escaping.
  function renderEmptyState(graph) {
    if (!graph.modules.length) {
      el.empty.textContent = "no modules found";
      el.empty.hidden = false;
      return;
    }
    var visibleModules = state.cy
      .nodes(".module")
      .not(".hidden-facet, .out-of-focus, .dimmed").length;
    if (visibleModules > 0) {
      el.empty.hidden = true;
      return;
    }
    var query = String(el.search.value || "").trim();
    if (query) {
      el.empty.textContent = 'no modules match "' + query + '"';
    } else {
      el.empty.textContent = "filters hide everything — clear filters to see the graph";
    }
    el.empty.hidden = false;
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

  // ---- URL state ------------------------------------------------------------

  function scheduleHashWrite() {
    clearTimeout(state.hashTimer);
    state.hashTimer = window.setTimeout(writeHash, 300);
  }

  function writeHash() {
    if (!H) {
      return;
    }
    var encoded = H.encodeUiState({
      selectedId: state.selectedId,
      search: el.search.value,
      showExternals: state.showExternals,
      hiddenExternals: state.hiddenExternals,
      expanded: state.expanded,
      activeTab: state.activeTab,
      filters: {
        tags: state.filters.tags,
        projects: state.filters.projects,
        moduleTypes: state.filters.moduleTypes,
        violationOnly: state.filters.violationOnly
      },
      focus: state.focus
    });
    var next = encoded ? "#" + encoded : "";
    // avoid a history entry storm; only replace when it actually changed
    if (("#" + (location.hash.replace(/^#/, ""))) !== ("#" + encoded)) {
      try {
        history.replaceState(null, "", location.pathname + location.search + next);
      } catch (error) {
        location.hash = encoded;
      }
    }
  }

  function restoreFromHash() {
    var pending = state.restorePending;
    if (!pending) {
      return;
    }
    state.restorePending = null;
    // re-select a node/edge if it still exists
    if (pending.selectedId) {
      var element = state.cy.getElementById(pending.selectedId);
      if (element.length) {
        if (element.isNode()) {
          renderDetailsForNode(element);
        } else {
          renderDetailsForEdge(element);
        }
      } else {
        state.selectedId = null;
      }
    }
    if (state.focus && !state.cy.getElementById(state.focus.id).length) {
      state.focus = null; // tolerate stale focus id
    }
    // Restore the active tab (Selection / Violations) from the permalink.
    syncTabs();
    if (state.activeTab === "violations") {
      renderViolationsPanel();
    }
  }

}());
