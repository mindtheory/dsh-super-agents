/**
 * dsh-super-agents — browser half (client plugin)
 *
 * Registers an official sidebar seat (sidebar.panellist + main, same pattern
 * as dsh-novel-writer) and renders a compact console: agent roster, dispatch
 * box, run feed with result viewer. Data comes from the node half's
 * /api/dsh-super-agents/* routes.
 *
 * Safety rules learned from dsh-novel-writer:
 *  - never ctx.inject() waiting for client services (can break host boot);
 *    use ctx.slots.inject which only fires once a seat is declared.
 *  - every host API access is wrapped; the panel must never throw upward.
 */
window.__ModuleLoader__.load({
  id: "dsh-super-agents",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require("react");
    var h = react.createElement;

    var inject = ["slots", "locale"];
    var PANEL_ID = "dsh-super-agents";
    var PANEL_ORDER = 26; // novel-writer=25, skill-explorer=30
    var API = "/api/dsh-super-agents";

    // ---- locale (inline dictionaries; host locale service optional) ----
    var localeId = "";
    var DICT = {
      zh: {
        "panel.title": "超级智能体",
        "panel.loading": "加载中…",
        "panel.agents": "智能体",
        "panel.noAgents": "还没有 agent：点「新建」创建角色卡，或让 AI 用 sa_agent 创建。",
        "panel.newAgent": "新建",
        "panel.edit": "编辑",
        "panel.del": "删除",
        "panel.dispatch": "派活",
        "panel.taskPlaceholder": "这次要它做什么？（具体、可验收）",
        "panel.send": "派出",
        "panel.cancel": "取消",
        "panel.save": "保存",
        "panel.schedules": "自主调度",
        "panel.runs": "运行记录",
        "panel.noRuns": "暂无运行记录",
        "panel.detail": "详情",
        "panel.cancelRun": "取消运行",
        "panel.confirmDel": "删除智能体",
      },
      en: {
        "panel.title": "Super Agents",
        "panel.loading": "loading…",
        "panel.agents": "Agents",
        "panel.noAgents": "No agents yet: create one here or via the sa_agent tool.",
        "panel.newAgent": "New",
        "panel.edit": "Edit",
        "panel.del": "Delete",
        "panel.dispatch": "Dispatch",
        "panel.taskPlaceholder": "What should it do? (specific, verifiable)",
        "panel.send": "Run",
        "panel.cancel": "Cancel",
        "panel.save": "Save",
        "panel.schedules": "Schedules",
        "panel.runs": "Runs",
        "panel.noRuns": "No runs yet",
        "panel.detail": "Detail",
        "panel.cancelRun": "Cancel run",
        "panel.confirmDel": "Delete agent",
      },
    };
    function currentLang() {
      if (localeId) return localeId;
      try { return (document.documentElement.lang || "zh").split("-")[0]; } catch (e) { return "zh"; }
    }
    function t(key) {
      var d = DICT[currentLang()] || DICT.zh;
      return d[key] || DICT.en[key] || key;
    }

    // ---- tiny state controller ----
    function makeController() {
      var listeners = [];
      var state = {
        loading: true,
        error: "",
        agents: [],
        schedules: [],
        runs: [],
        queue: 0,
        active: 0,
        detail: null, // {runId, run, artifact, logTail}
        detailBusy: false,
        dispatchFor: "", // agentId selected in dispatch box
        dispatchText: "",
        dispatchBusy: false,
        editing: null, // agent row being edited (or {} for new)
        saveBusy: false,
      };
      return {
        state: state,
        subscribe: function (fn) {
          listeners.push(fn);
          return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
        },
        emit: function () { for (var i = 0; i < listeners.length; i += 1) { try { listeners[i](); } catch (e) { /* ignore */ } } },
        set: function (patch) { Object.assign(state, patch); this.emit(); },
      };
    }

    function apiGet(path) {
      return fetch(path, { credentials: "same-origin" }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }
    function apiPost(path, body) {
      return fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }).then(function (res) {
        if (!res.ok) return res.json().then(function (j) { throw new Error(j.error || ("HTTP " + res.status)); });
        return res.json();
      });
    }

    function useTick(controller) {
      var force = react.useState(0)[1];
      react.useEffect(function () {
        return controller.subscribe(function () { force(function (n) { return n + 1; }); });
      }, [controller]);
    }

    // ---- components ----
    var css = [
      ".saWrap{padding:12px;display:flex;flex-direction:column;gap:12px;font-size:13px}",
      ".saCard{border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px}",
      ".saRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".saBtn{border:1px solid rgba(128,128,128,.4);background:transparent;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px}",
      ".saBtn:disabled{opacity:.5;cursor:default}",
      ".saInput,.saArea{width:100%;box-sizing:border-box;border:1px solid rgba(128,128,128,.4);border-radius:8px;padding:6px;font-size:12px;background:transparent;color:inherit;font-family:inherit}",
      ".saTag{font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid rgba(128,128,128,.4)}",
      ".saTag.done{color:#2e7d32;border-color:#2e7d32}",
      ".saTag.running{color:#1565c0;border-color:#1565c0}",
      ".saTag.queued{color:#777;border-color:#777}",
      ".saTag.failed,.saTag.timeout{color:#c62828;border-color:#c62828}",
      ".saTag.done_no_artifact{color:#ef6c00;border-color:#ef6c00}",
      ".saMono{font-family:ui-monospace,monospace;font-size:11px;opacity:.75}",
      ".saPre{white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:8px;font-size:12px}",
      ".saErr{color:#c62828;font-size:12px}",
      ".saGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}",
      ".saAgent{border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px}",
      ".saAgent.off{opacity:.55}",
      ".saH{font-weight:600}",
    ].join("\n");

    function StyleTag() { return h("style", null, css); }

    function StatusTag(props) {
      return h("span", { className: "saTag " + props.status }, props.status);
    }

    function RunRow(props) {
      var r = props.run;
      var live = r.status === "queued" || r.status === "running";
      return h("div", { className: "saRow", key: r.id },
        h(StatusTag, { status: r.status }),
        h("span", { className: "saMono" }, r.id),
        h("span", null, r.agentName),
        h("span", { className: "saMono", style: { maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, (r.taskText || "").slice(0, 60)),
        h("button", { className: "saBtn", onClick: function () { props.controller.openDetail(r.id); } }, t("panel.detail")),
        live ? h("button", { className: "saBtn", onClick: function () { props.controller.cancelRun(r.id); } }, t("panel.cancelRun")) : null
      );
    }

    function AgentCard(props) {
      var a = props.a;
      var c = props.controller;
      return h("div", { className: "saAgent" + (a.enabled === false ? " off" : ""), key: a.id },
        h("div", { className: "saRow" },
          h("span", { className: "saH" }, a.name),
          h("span", { className: "saMono" }, a.id)
        ),
        a.model ? h("span", { className: "saMono" }, "model: " + a.model) : null,
        a.cwd ? h("span", { className: "saMono" }, "cwd: " + a.cwd) : null,
        h("span", { className: "saMono" }, "playbook: " + ((a.playbook || "").split("\n").filter(Boolean).length) + " 条" + (a.learn === false ? " · 学习关闭" : "")),
        h("div", { className: "saRow" },
          h("button", { className: "saBtn", onClick: function () { c.set({ dispatchFor: a.id, detail: null }); } }, t("panel.dispatch")),
          h("button", { className: "saBtn", onClick: function () { c.set({ editing: Object.assign({}, a) }); } }, t("panel.edit")),
          h("button", { className: "saBtn", onClick: function () { c.removeAgent(a); } }, t("panel.del"))
        )
      );
    }

    function PanelView(props) {
      var c = props.controller;
      var s = c.state;
      useTick(c);
      react.useEffect(function () { c.refresh(); var id = setInterval(function () { c.refresh(); }, 5000); return function () { clearInterval(id); }; }, [c]);

      var body;
      if (s.loading && !s.agents.length) body = h("div", { className: "saMono" }, t("panel.loading"));
      else if (s.error) body = h("div", { className: "saErr" }, s.error);
      else body = h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        // roster
        h("div", { className: "saCard" },
          h("div", { className: "saRow" },
            h("span", { className: "saH" }, t("panel.agents")),
            h("span", { className: "saMono" }, "active " + s.active + " / queue " + s.queue),
            h("span", { style: { flex: 1 } }),
            h("button", { className: "saBtn", onClick: function () { c.set({ editing: {} }); } }, t("panel.newAgent"))
          ),
          s.agents.length
            ? h("div", { className: "saGrid" }, s.agents.map(function (a) { return h(AgentCard, { key: a.id, a: a, controller: c }); }))
            : h("div", { className: "saMono" }, t("panel.noAgents"))
        ),
        // dispatch box
        s.dispatchFor
          ? h("div", { className: "saCard" },
              h("div", { className: "saH" }, t("panel.dispatch") + " → " + (s.agents.find(function (a) { return a.id === s.dispatchFor; }) || {}).name),
              h("textarea", { className: "saArea", rows: 3, value: s.dispatchText, placeholder: t("panel.taskPlaceholder"), onChange: function (e) { c.set({ dispatchText: e.target.value }); } }),
              h("div", { className: "saRow" },
                h("button", {
                  className: "saBtn", disabled: s.dispatchBusy || !s.dispatchText.trim(),
                  onClick: function () { c.dispatch(); }
                }, t("panel.send")),
                h("button", { className: "saBtn", onClick: function () { c.set({ dispatchFor: "", dispatchText: "" }); } }, t("panel.cancel"))
              )
            )
          : null,
        // editor
        s.editing
          ? h("div", { className: "saCard" },
              h("div", { className: "saH" }, s.editing.id ? t("panel.edit") : t("panel.newAgent")),
              h("input", { className: "saInput", placeholder: "name", value: s.editing.name || "", onChange: function (e) { c.set({ editing: Object.assign({}, s.editing, { name: e.target.value }) }); } }),
              h("input", { className: "saInput", placeholder: "model provider/model (optional)", value: s.editing.model || "", onChange: function (e) { c.set({ editing: Object.assign({}, s.editing, { model: e.target.value }) }); } }),
              h("input", { className: "saInput", placeholder: "cwd (optional)", value: s.editing.cwd || "", onChange: function (e) { c.set({ editing: Object.assign({}, s.editing, { cwd: e.target.value }) }); } }),
              h("textarea", { className: "saArea", rows: 4, placeholder: "systemRole", value: s.editing.systemRole || "", onChange: function (e) { c.set({ editing: Object.assign({}, s.editing, { systemRole: e.target.value }) }); } }),
              h("div", { className: "saRow" },
                h("button", { className: "saBtn", disabled: s.saveBusy, onClick: function () { c.saveAgent(); } }, t("panel.save")),
                h("button", { className: "saBtn", onClick: function () { c.set({ editing: null }); } }, t("panel.cancel"))
              )
            )
          : null,
        // schedules
        s.schedules.length
          ? h("div", { className: "saCard" },
              h("div", { className: "saH" }, t("panel.schedules")),
              s.schedules.map(function (sc) {
                return h("div", { className: "saRow", key: sc.id },
                  h("span", { className: "saMono" }, sc.id),
                  h("span", null, sc.agentName),
                  h("span", { className: "saMono" }, sc.kind + " " + (sc.cron || sc.everySeconds + "s" || (sc.at || "").slice(0, 16))),
                  h("span", { className: "saMono", style: { maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, sc.title || sc.prompt)
                );
              })
            )
          : null,
        // runs
        h("div", { className: "saCard" },
          h("div", { className: "saH" }, t("panel.runs")),
          s.runs.length
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, s.runs.slice(0, 30).map(function (r) { return h(RunRow, { key: r.id, run: r, controller: c }); }))
            : h("div", { className: "saMono" }, t("panel.noRuns"))
        ),
        // detail
        s.detail
          ? h("div", { className: "saCard" },
              h("div", { className: "saRow" },
                h("span", { className: "saH" }, t("panel.detail") + " " + s.detail.runId),
                h("span", { style: { flex: 1 } }),
                h("button", { className: "saBtn", onClick: function () { c.set({ detail: null }); } }, "✕")
              ),
              s.detail.run ? h("div", { className: "saMono" }, "status: " + s.detail.run.status + "  session: " + (s.detail.run.sessionId || "-")) : null,
              s.detail.artifact ? h("pre", { className: "saPre" }, s.detail.artifact) : h("pre", { className: "saPre" }, s.detail.logTail || "-")
            )
          : null
      );
      return h("div", { className: "saWrap" }, h(StyleTag), body);
    }

    // ---- controller methods that touch the API ----
    function wireController(c) {
      c.refresh = function () {
        return apiGet(API + "/state").then(function (data) {
          c.set({ loading: false, error: "", agents: data.agents || [], schedules: data.schedules || [], runs: data.runs || [], queue: data.queue || 0, active: data.active || 0 });
        }).catch(function (err) {
          c.set({ loading: false, error: String(err.message || err) });
        });
      };
      c.dispatch = function () {
        var s = c.state;
        if (!s.dispatchFor || !s.dispatchText.trim()) return;
        c.set({ dispatchBusy: true });
        apiPost(API + "/run", { agentId: s.dispatchFor, prompt: s.dispatchText }).then(function () {
          c.set({ dispatchBusy: false, dispatchText: "" });
          return c.refresh();
        }).catch(function (err) { c.set({ dispatchBusy: false, error: String(err.message || err) }); });
      };
      c.saveAgent = function () {
        var e = c.state.editing || {};
        if (!e.name || !e.name.trim()) return;
        c.set({ saveBusy: true });
        apiPost(API + "/agent-save", { id: e.id, name: e.name, systemRole: e.systemRole, model: e.model, cwd: e.cwd, learn: e.learn }).then(function () {
          c.set({ saveBusy: false, editing: null });
          return c.refresh();
        }).catch(function (err) { c.set({ saveBusy: false, error: String(err.message || err) }); });
      };
      c.removeAgent = function (a) {
        if (!window.confirm(t("panel.confirmDel") + " " + a.name + " ?")) return;
        apiPost(API + "/agent-delete", { agentId: a.id }).then(function () { return c.refresh(); }).catch(function (err) { c.set({ error: String(err.message || err) }); });
      };
      c.openDetail = function (runId) {
        c.set({ detail: { runId: runId } });
        apiGet(API + "/run-detail?runId=" + encodeURIComponent(runId)).then(function (data) {
          c.set({ detail: { runId: runId, run: data.run, artifact: data.artifact, logTail: data.logTail } });
        }).catch(function (err) { c.set({ detail: { runId: runId, artifact: String(err.message || err) } }); });
      };
      c.cancelRun = function (runId) {
        apiPost(API + "/run-cancel", { runId: runId }).then(function () { return c.refresh(); }).catch(function (err) { c.set({ error: String(err.message || err) }); });
      };
    }

    // ---- seat registration (slots only; never ctx.inject here) ----
    function slotDeclared(ctx, name) {
      try {
        var slots = ctx && ctx.slots;
        if (!slots) return false;
        if (typeof slots.specDynamic === "function") return !!slots.specDynamic(name);
        if (typeof slots.spec === "function") return !!slots.spec(name);
      } catch (e) { /* treat as undeclared */ }
      return false;
    }

    function SidebarIcon(props) {
      var size = typeof props.size === "number" && props.size > 0 ? props.size : 16;
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z" }),
        h("path", { d: "M18 14l.9 2.1 2.1.9-2.1.9L18 20l-.9-2.1-2.1-.9 2.1-.9L18 14z" })
      );
    }

    function MainPanelPage(props) {
      useTick(props.controller);
      return h(PanelView, { controller: props.controller });
    }

    function apply(ctx) {
      var controller = makeController();
      wireController(controller);
      var localeSub = null;
      var applyLocale = function () {
        try {
          var snap = ctx && ctx.locale && typeof ctx.locale.getSnapshot === "function" ? ctx.locale.getSnapshot() : null;
          localeId = snap && typeof snap.active === "string" ? snap.active.split("-")[0] : "";
        } catch (e) { localeId = ""; }
      };
      try {
        applyLocale();
        if (ctx && ctx.locale && typeof ctx.locale.subscribe === "function") {
          localeSub = ctx.locale.subscribe(function () { applyLocale(); controller.emit(); });
        }
      } catch (e) { /* locale optional */ }

      var disposers = [];
      if (ctx && ctx.slots && typeof ctx.slots.inject === "function" && slotDeclared(ctx, "sidebar.panellist") && slotDeclared(ctx, "main")) {
        try {
          disposers.push(ctx.slots.inject("main", function () {
            return ctx.slots.register({
              name: "main",
              key: PANEL_ID,
              inject: function () { return { controller: controller }; },
            }, MainPanelPage);
          }));
          disposers.push(ctx.slots.inject("sidebar.panellist", function () {
            return ctx.slots.register({
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: function () { return t("panel.title"); },
            }, SidebarIcon);
          }));
        } catch (err) {
          console.warn("[dsh-super-agents] panel seat failed:", err);
        }
      }
      return function () {
        for (var i = 0; i < disposers.length; i += 1) { try { disposers[i](); } catch (e) { /* ignore */ } }
        if (typeof localeSub === "function") { try { localeSub(); } catch (e) { /* ignore */ } }
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
