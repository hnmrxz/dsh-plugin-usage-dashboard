/**
 * dsh-plugin-usage-dashboard — Client half
 *
 * Renders a compact cost/usage chip in the `conversation.composer.dock` slot
 * (next to the balance plugin): estimated spend + budget alert badge, with a
 * per-session breakdown in the tooltip. Polls `/dsh-usage` every 30s; click to
 * refresh.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-usage-dashboard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    const NS = "ds-usage";
    const ROUTE_PATH = "/dsh-usage";
    const POLL_MS = 30000;
    const inject = ["slots", "timer", "locale"];

    // composer.dock 的多个状态 chip 横向排列：InputBar 根容器改 row+wrap，
    // card 独占一行，footer 的 chip（余额/用量/系统）横排成一条。
    if (typeof document !== "undefined" && document.querySelector("style[data-dsh-composer-row]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-usage-dashboard";
      tag.dataset.dshComposerRow = "";
      tag.textContent =
        "div:has(> [data-composer-card]){flex-direction:row!important;flex-wrap:wrap!important;justify-content:center;align-items:center}" +
        "[data-composer-card]{flex:1 1 100%!important}";
      document.head.appendChild(tag);
    }

    const zh = {
      label: "用量",
      loading: "用量加载中…",
      error: "加载失败",
      cost: "估算花费",
      sessions: "会话",
      tokens: "tokens",
      budgetAlert: "余额偏低",
      noData: "暂无用量数据",
      perSession: "按会话",
      others: "其他会话",
    };
    const en = {
      label: "Usage",
      loading: "Loading usage…",
      error: "Failed to load",
      cost: "Est. cost",
      sessions: "sessions",
      tokens: "tokens",
      budgetAlert: "Low balance",
      noData: "No usage data",
      perSession: "By session",
      others: "other sessions",
    };

    const wrapStyle = {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      fontSize: 12,
      lineHeight: 1,
      color: "var(--dsw-alias-label-secondary)",
      whiteSpace: "nowrap",
      userSelect: "none",
    };
    const chipStyle = {
      background: "transparent",
      border: 0,
      padding: 0,
      margin: 0,
      font: "inherit",
      color: "inherit",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
    };
    const amtStyle = { color: "var(--dsw-alias-label-primary)", fontWeight: 500 };
    const alertStyle = { color: "var(--dsw-alias-state-warn-primary)", fontWeight: 600 };
    const okStyle = { color: "var(--dsw-alias-state-success-primary)" };
    const errStyle = { color: "var(--dsw-alias-state-error-primary)" };

    function cny(value) {
      const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
      return "¥" + n.toFixed(2);
    }

    function routeUrl() {
      const origin = typeof location !== "undefined" && location.origin && location.origin !== "null" ? location.origin : "";
      return origin + ROUTE_PATH;
    }

    async function fetchUsage() {
      const response = await fetch(routeUrl(), { cache: "no-store" });
      return response.json();
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "usage-dashboard: dictionaries");
      const t = typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : ((key) => (zh[key] ?? key));

      function UsageView(props) {
        const tt = props && typeof props.t === "function" ? props.t : t;
        const [state, setState] = react.useState({ phase: "loading", data: null, error: null });

        react.useEffect(() => {
          let alive = true;
          const refresh = async () => {
            try {
              const res = await fetchUsage();
              if (!alive) return;
              if (res && res.ok === true) setState({ phase: "ready", data: res, error: null });
              else setState({ phase: "error", data: null, error: (res && res.error) || tt("error") });
            } catch (err) {
              if (!alive) return;
              setState({ phase: "error", data: null, error: String(err && err.message || err) });
            }
          };
          refresh();
          const stop = ctx.interval(refresh, POLL_MS);
          return () => { alive = false; stop(); };
        }, []);

        const onClick = () => {
          setState({ phase: "loading", data: state.data, error: null });
          fetchUsage().then((res) => {
            if (res && res.ok === true) setState({ phase: "ready", data: res, error: null });
            else setState({ phase: "error", data: null, error: (res && res.error) || tt("error") });
          }).catch((err) => {
            setState({ phase: "error", data: null, error: String(err && err.message || err) });
          });
        };

        let inner;
        let title = "";
        if (state.phase === "loading" && state.data === null) {
          title = tt("loading");
          inner = react.createElement("span", null, "DS " + tt("loading"));
        } else if (state.phase === "ready" && state.data !== null) {
          const budget = state.data.budget || {};
          const usage = state.data.usage && state.data.usage.ok ? state.data.usage : null;
          if (usage && usage.aggregate) {
            const cost = usage.aggregate.estimatedCostCny;
            const per = (usage.aggregate.perSession || []).map((row) =>
              row.title + " " + cny(row.estimatedCostCny) + (row.tokens ? " · " + row.tokens.toLocaleString() + " " + tt("tokens") : "")
            ).join("\n");
            title = tt("cost") + " " + cny(cost) + "\n" + tt("sessions") + " " + usage.aggregate.sessionCount + " · " + usage.aggregate.tokens.total.toLocaleString() + " " + tt("tokens") +
              (per ? "\n" + tt("perSession") + ":\n" + per : "") +
              (budget.alert ? "\n⚠ " + tt("budgetAlert") + "：余额 " + cny(budget.balanceCny) + "（阈值 " + cny(budget.thresholdCny) + "）· 已花费 " + cny(cost) : "");
            // 告警时展示的是「当前余额」而不是花费，避免误读成"还剩这么多"
            inner = budget.alert
              ? react.createElement("span", { style: alertStyle },
                  react.createElement("span", null, "⚠ " + tt("budgetAlert")),
                  react.createElement("span", { style: amtStyle }, cny(budget.balanceCny)))
              : react.createElement("span", { style: okStyle },
                  react.createElement("span", { style: amtStyle }, cny(cost)),
                  react.createElement("span", null, " " + tt("cost")));
          } else {
            title = tt("noData");
            inner = react.createElement("span", null, "DS " + tt("noData"));
          }
        } else {
          title = state.error || tt("error");
          inner = react.createElement("span", { style: errStyle }, "DS --");
        }

        return react.createElement("div", { style: wrapStyle },
          react.createElement("button", { type: "button", style: chipStyle, title: title, onClick: onClick },
            react.createElement("span", { style: { opacity: 0.85 } }, "DS"),
            inner
          )
        );
      }

      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "ds-usage",
        order: 2,
        locale: NS,
        label: () => "DS " + t("label"),
      }, UsageView));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
