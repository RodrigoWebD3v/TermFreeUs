// Servers screen: every saved host whose login works on its own, with uptime, load and its numbers
// right now (CPU, memory, swap, disks, network), read every 2 seconds while the screen is open, plus
// a chart of the last 10 minutes, the busiest containers and the requests passing through Traefik (traffic.js).
(function () {
  const S = (App.servers = { live: {}, hist: {}, state: {} });
  const INTERVAL = 2000;
  const RETRY_OFFLINE = 30000;
  const KEEP_MS = 10 * 60 * 1000;
  // Validated pair (light and dark surfaces): first series blue, second orange.
  const C1 = "#2091f6", C2 = "#e0682e";
  let page = null;

  const loginKey = (t) => JSON.stringify([t.host, t.port, t.username, t.password, t.key, t.passphrase, t.trusted, t.chain]);
  const onPage = () => App.current === "vaults" && App.vaultPage === "servers" && !document.hidden;
  const demoOnly = () => App.screenshotMode && App.data.hosts.every((x) => String(x.id).startsWith("demo-"));

  // ---------- reading ----------
  const pollHost = async (host, force) => {
    const t = App.usage.eligible(host);
    const st = (S.state[host.id] = S.state[host.id] || {});
    if (!t) return;
    const key = loginKey(t);
    if (st.key !== key) { st.blockedKey = null; st.retryAt = 0; }
    if (st.busy) return;
    if (!force && (st.blockedKey === key || (st.retryAt && Date.now() < st.retryAt))) return;
    st.busy = true; st.key = key;
    try {
      const m = await App.invoke("host_monitor", { id: host.id, target: t });
      const now = Date.now();
      S.live[host.id] = Object.assign(m, { at: now });
      const memPct = m.mem_total ? (m.mem_used / m.mem_total) * 100 : null;
      const hist = (S.hist[host.id] = S.hist[host.id] || []);
      hist.push({ t: now, cpu: m.cpu, mem: memPct, rx: m.net_rx, tx: m.net_tx });
      while (hist.length && now - hist[0].t > KEEP_MS) hist.shift();
      st.err = null; st.blockedKey = null; st.retryAt = 0;
    } catch (e) {
      const msg = String(e);
      st.err = msg;
      if (/^(AUTH_|HOSTKEY_|KEY_|UNSUPPORTED)/.test(msg)) st.blockedKey = key;
      else st.retryAt = Date.now() + RETRY_OFFLINE;
    } finally {
      st.busy = false;
      if (page && onPage()) paint(host.id);
    }
  };

  S.tick = () => {
    if (!onPage() || demoOnly()) return;
    for (const x of App.data.hosts) {
      pollHost(x);
      App.traffic.poll(x, () => { if (page && onPage()) paint(x.id); });
    }
  };

  S.start = () => {
    if (demoOnly()) S.demo();
    setInterval(S.tick, INTERVAL);
    document.addEventListener("visibilitychange", S.tick);
  };

  // Made-up numbers for the check pictures of the made-up hosts only.
  S.demo = () => {
    const now = Date.now();
    for (const [id, base] of [["demo-h1", 18], ["demo-h2", 55]]) {
      const hist = (S.hist[id] = []);
      for (let i = 299; i >= 0; i--) {
        const w = Math.sin(i / 17) * 8 + Math.sin(i / 5) * 4;
        hist.push({ t: now - i * 2000, cpu: Math.max(1, base + w + (i % 37 === 0 ? 30 : 0)), mem: base + 20 + Math.sin(i / 60) * 3, rx: 4e4 + w * 3e3 + (i % 23 === 0 ? 4e5 : 0), tx: 2e4 + w * 1e3 });
      }
      const last = hist[hist.length - 1];
      S.live[id] = { hostname: id, os: "Ubuntu 24.04.3 LTS", kernel: "6.8.0-45-generic", uptime_secs: 470135, load: [1.19, 0.93, 0.74], cpus: 2,
        cpu: last.cpu, iowait: 0.4, mem_used: 3.1e9, mem_total: 7.9e9, swap_used: 0, swap_total: 2e9, net_rx: last.rx, net_tx: last.tx,
        disks: [{ mount: "/", size: 1e11, used: 2.9e10 }, { mount: "/boot", size: 2e9, used: 2.6e8 }], at: now };
    }
  };

  // ---------- formatting ----------
  const pct = (v) => (v == null ? "—" : (v < 10 ? v.toFixed(1) : Math.round(v)) + "%");
  const gb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(b >= 10 * 1073741824 ? 0 : 1) + " GB" : Math.round(b / 1048576) + " MB");
  const rate = (b) => (b == null ? "—" : b < 1024 ? Math.round(b) + " B/s" : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + " KB/s" : (b / 1048576).toFixed(1) + " MB/s");
  const uptime = (s) => {
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m`;
  };
  const level = (v, warn, bad) => (v == null ? "" : v >= bad ? " bad" : v >= warn ? " warn" : "");
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // ---------- chart: two series on one axis, crosshair and tooltip ----------
  // opts: { keys: [k1, k2], names: [n1, n2], max: fixed top or null, fmt }
  const chart = (opts) => {
    const W = 600, H = 110;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "s-svg");
    const grid = document.createElementNS(ns, "g");
    const lines = opts.keys.map((_, i) => {
      const p = document.createElementNS(ns, "polyline");
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", i ? C2 : C1);
      p.setAttribute("stroke-width", "2");
      p.setAttribute("stroke-linejoin", "round");
      p.setAttribute("vector-effect", "non-scaling-stroke");
      return p;
    });
    svg.append(grid, ...lines);
    const yLabels = h("div", { class: "s-ylabels" });
    const hair = h("div", { class: "s-hair" });
    const dots = opts.keys.map((_, i) => h("i", { class: "s-dot", style: `background:${i ? C2 : C1}` }));
    const tip = h("div", { class: "s-tip" });
    const plot = h("div", { class: "s-plot", tabindex: "0" }, svg, hair, ...dots, tip);
    const legend = h("div", { class: "s-legend" }, ...opts.names.map((n, i) =>
      h("span", {}, h("i", { style: `background:${i ? C2 : C1}` }), h("span", { class: "s-legend-name" }, n), h("b", { class: "s-legend-val" }, ""))));
    const el = h("div", { class: "s-chart" }, h("div", { class: "s-chart-head" }, h("div", { class: "s-chart-title" }, opts.title), legend),
      h("div", { class: "s-chart-body" }, yLabels, plot),
      h("div", { class: "s-xlabels" }, h("span", { class: "s-xstart" }, "1 min ago"), h("span", {}, "now")));
    // The window grows with the history: 1 minute at first, up to 10.
    let data = [], top = 1, hoverX = null, span = 60000;

    const xOf = (t, now) => W - ((now - t) / span) * W;
    const yOf = (v) => H - 2 - (Math.max(0, v) / top) * (H - 6);

    const showTip = () => {
      if (hoverX == null || !data.length) { hair.style.display = tip.style.display = "none"; dots.forEach((d) => (d.style.display = "none")); return; }
      const r = plot.getBoundingClientRect();
      const now = data[data.length - 1].t;
      const tAt = now - (1 - hoverX / r.width) * span;
      let best = data[0];
      for (const p of data) if (Math.abs(p.t - tAt) < Math.abs(best.t - tAt)) best = p;
      const px = (xOf(best.t, now) / W) * r.width;
      hair.style.display = "block"; hair.style.left = px + "px";
      opts.keys.forEach((k, i) => {
        const v = best[k];
        dots[i].style.display = v == null ? "none" : "block";
        if (v != null) { dots[i].style.left = px + "px"; dots[i].style.top = (yOf(v) / H) * r.height + "px"; }
      });
      tip.textContent = "";
      tip.append(h("div", { class: "s-tip-time" }, clock(best.t)),
        ...opts.keys.map((k, i) => h("div", { class: "s-tip-row" }, h("i", { style: `background:${i ? C2 : C1}` }), h("b", {}, opts.fmt(best[k])), h("span", {}, opts.names[i]))));
      tip.style.display = "block";
      const tw = tip.offsetWidth;
      tip.style.left = (px + 10 + tw > r.width ? Math.max(0, px - tw - 10) : px + 10) + "px";
    };
    plot.addEventListener("pointermove", (e) => { hoverX = e.clientX - plot.getBoundingClientRect().left; showTip(); });
    plot.addEventListener("pointerleave", () => { hoverX = null; showTip(); });
    plot.addEventListener("focus", () => { hoverX = plot.getBoundingClientRect().width - 1; showTip(); });
    plot.addEventListener("blur", () => { hoverX = null; showTip(); });

    const update = (points) => {
      data = points;
      const now = points.length ? points[points.length - 1].t : Date.now();
      const age = points.length ? now - points[0].t : 0;
      span = Math.min(KEEP_MS, Math.max(60000, Math.ceil(age / 60000) * 60000));
      el.querySelector(".s-xstart").textContent = `${Math.round(span / 60000)} min ago`;
      const peak = Math.max(0, ...points.flatMap((p) => opts.keys.map((k) => p[k] || 0)));
      top = opts.max || (opts.nice || niceTop)(peak);
      grid.textContent = "";
      yLabels.textContent = "";
      for (const f of [1, 0.5, 0]) {
        const y = yOf(top * f);
        const l = document.createElementNS(ns, "line");
        l.setAttribute("x1", 0); l.setAttribute("x2", W); l.setAttribute("y1", y); l.setAttribute("y2", y);
        l.setAttribute("class", "s-gridline"); l.setAttribute("vector-effect", "non-scaling-stroke");
        grid.append(l);
        yLabels.append(h("span", { style: `top:${(y / H) * 100}%` }, opts.fmtAxis(top * f)));
      }
      opts.keys.forEach((k, i) => {
        lines[i].setAttribute("points", points.filter((p) => p[k] != null).map((p) => `${xOf(p.t, now).toFixed(1)},${yOf(p[k]).toFixed(1)}`).join(" "));
      });
      const last = points[points.length - 1];
      legend.querySelectorAll(".s-legend-val").forEach((b, i) => (b.textContent = last ? opts.fmt(last[opts.keys[i]]) : ""));
      showTip();
    };
    return { el, update };
  };
  // Counts: 1, 2, 5, 10, 20, 50... just above the peak.
  const niceCount = (v) => {
    const want = Math.max(1, v * 1.15);
    const p = Math.pow(10, Math.floor(Math.log10(want)));
    return [1, 2, 5, 10].map((m) => m * p).find((x) => x >= want);
  };
  const niceTop = (v) => {
    if (v <= 0) return 1024;
    const p = Math.pow(2, Math.ceil(Math.log2(v * 1.15)));
    return Math.max(1024, p);
  };

  // ---------- cards ----------
  const cards = {};

  const meterBar = (v, cls) => h("i", { class: "bar" + cls }, h("i", { style: `width:${Math.max(0, Math.min(100, v || 0))}%` }));

  const buildCard = (host) => {
    const head = h("div", { class: "s-head" });
    const stats = h("div", { class: "s-stats" });
    const cpuMem = chart({ title: "CPU and memory", keys: ["cpu", "mem"], names: ["CPU", "RAM"], max: 100, fmt: pct, fmtAxis: (v) => Math.round(v) + "%" });
    const net = chart({ title: "Network", keys: ["rx", "tx"], names: ["Down", "Up"], max: null, fmt: rate, fmtAxis: (v) => (v ? rate(v).replace("/s", "") : "0") });
    const bottom = h("div", { class: "s-bottom" });
    const msg = h("div", { class: "s-msg" });
    const perSec = (v) => (v == null ? "—" : (v < 10 ? v.toFixed(1) : Math.round(v)) + "/s");
    const reqs = chart({ title: "Requests per second", keys: ["rps", "e5"], names: ["Requests", "5xx errors"], max: null, nice: niceCount, fmt: perSec, fmtAxis: (v) => String(Math.round(v * 10) / 10) });
    const traffic = h("div", { class: "s-traffic" });
    const el = h("div", { class: "s-card", "data-shost": host.id }, head, msg, stats, h("div", { class: "s-charts" }, cpuMem.el, net.el), traffic, bottom);
    head.ondblclick = () => App.terminal.connectHost(host);
    cards[host.id] = { el, head, stats, cpuMem, net, bottom, msg, traffic, reqs };
    paint(host.id);
    return el;
  };

  const stat = (label, value, sub, bar) => h("div", { class: "s-stat" }, h("div", { class: "s-stat-label" }, label), h("div", { class: "s-stat-value" }, value), bar || null, h("div", { class: "s-stat-sub" }, sub || ""));

  const paint = (hostId) => {
    const c = cards[hostId];
    const host = App.byId("hosts", hostId);
    if (!c || !host || !c.el.isConnected) return;
    const m = S.live[hostId];
    const st = S.state[hostId] || {};
    const stale = m && Date.now() - m.at > 15000;
    c.el.classList.toggle("stale", !!(st.err && m) || !!stale);

    c.head.textContent = "";
    const term = h("button", { class: "icon-btn", title: "Open terminal", html: Icon("terminal", 14) });
    term.onclick = () => App.terminal.connectHost(host);
    const cont = h("button", { class: "icon-btn", title: "Containers", html: Icon("box", 14) });
    cont.onclick = () => { App.containers.focusHost = hostId; App.openVaultPage("containers"); };
    c.head.append(App.avatar(host.os, App.hostLabel(host)),
      h("div", { class: "s-title" }, h("div", { class: "title" }, App.hostLabel(host), h("span", { class: "s-live" + (m && !st.err && !stale ? " on" : "") }, m && !st.err && !stale ? "live" : st.busy && !m ? "connecting" : "offline")),
        h("div", { class: "subtitle" }, m ? [m.os, m.kernel].filter(Boolean).join(" · ") : host.address)),
      h("div", { class: "grow" }),
      m ? h("div", { class: "s-uptime", title: "Time since the server last started" }, h("span", {}, "Uptime"), h("b", {}, uptime(m.uptime_secs))) : null,
      m ? h("div", { class: "s-uptime", title: `Processes waiting to run, averaged over 1, 5 and 15 minutes, on ${m.cpus} CPU${m.cpus === 1 ? "" : "s"}` },
        h("span", {}, `Load · ${m.cpus} CPU${m.cpus === 1 ? "" : "s"}`), h("b", { class: level(m.load[0] / Math.max(1, m.cpus) * 100, 80, 120).trim() }, m.load.map((x) => x.toFixed(2)).join("  "))) : null,
      cont, term);

    c.msg.textContent = st.err && !m ? App.errText(st.err) : st.err ? "Lost contact, showing the last numbers. " + App.errText(st.err) : "";
    c.msg.style.display = c.msg.textContent ? "block" : "none";
    if (!m) { c.stats.textContent = ""; c.stats.append(h("div", { class: "s-skel" }), h("div", { class: "s-skel" }), h("div", { class: "s-skel" }), h("div", { class: "s-skel" })); return; }

    const memPct = m.mem_total ? (m.mem_used / m.mem_total) * 100 : 0;
    const root = m.disks[0];
    const rootPct = root ? (root.used / root.size) * 100 : null;
    c.stats.textContent = "";
    c.stats.append(
      stat("CPU", pct(m.cpu), m.iowait != null && m.iowait >= 1 ? `${pct(m.iowait)} waiting on disk` : `${m.cpus} core${m.cpus === 1 ? "" : "s"}`, meterBar(m.cpu, level(m.cpu, 70, 90))),
      stat("Memory", pct(memPct), `${gb(m.mem_used)} of ${gb(m.mem_total)}` + (m.swap_total ? ` · swap ${pct((m.swap_used / m.swap_total) * 100)}` : ""), meterBar(memPct, level(memPct, 75, 90))),
      stat("Disk " + (root ? root.mount : ""), pct(rootPct), root ? `${gb(root.used)} of ${gb(root.size)}` : "", meterBar(rootPct, level(rootPct, 80, 90))),
      stat("Network", h("span", { class: "s-net" }, h("span", {}, "↓ " + rate(m.net_rx)), h("span", {}, "↑ " + rate(m.net_tx))), "all interfaces, right now"));

    const hist = S.hist[hostId] || [];
    c.cpuMem.update(hist);
    c.net.update(hist);

    // Other disks and the busiest containers (from the Containers screen's last reading).
    paintTraffic(hostId, c, host);
    c.bottom.textContent = "";
    const more = m.disks.slice(1).filter((d) => d.size > 5e8);
    if (more.length) {
      c.bottom.append(h("div", { class: "s-sec" }, h("div", { class: "s-sec-title" }, "Other disks"),
        ...more.map((d) => { const p = (d.used / d.size) * 100; return h("div", { class: "s-line" }, h("span", { class: "s-line-name" }, d.mount), meterBar(p, level(p, 80, 90)), h("span", { class: "s-line-val" }, `${pct(p)} · ${gb(d.used)} of ${gb(d.size)}`)); })));
    }
    const cd = App.containers.data[hostId];
    if (cd && cd.res) {
      const top = cd.res.containers.filter((x) => x.state === "running" && x.cpu != null).sort((a, b) => b.cpu - a.cpu).slice(0, 4);
      if (top.length) {
        const name = (x) => (x.service || x.name);
        c.bottom.append(h("div", { class: "s-sec" }, h("div", { class: "s-sec-title" }, "Busiest containers", h("span", { class: "count" }, "as of " + clock(cd.at))),
          ...top.map((x) => h("div", { class: "s-line" }, h("span", { class: "s-line-name" }, name(x)), meterBar(x.cpu, level(x.cpu, 70, 90)), h("span", { class: "s-line-val" }, `${pct(x.cpu)} · ${gb(x.mem_used)}`)))));
      }
    }
  };

  // ---------- Traefik traffic ----------
  const ms = (v) => (v == null ? "—" : v >= 1000 ? (v / 1000).toFixed(1) + " s" : Math.round(v) + " ms");
  const perMin = (v) => (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1)) + "/min";

  const paintTraffic = (hostId, c, host) => {
    const sum = App.traffic.summary(hostId);
    const tst = App.traffic.state[hostId] || {};
    c.traffic.style.display = sum ? "" : "none";
    if (!sum) return;
    const open = App.traffic.open[hostId] !== false;
    if (!c.trafficHead) {
      c.trafficHead = h("div", { class: "s-tr-head" });
      c.trafficBody = h("div", { class: "s-tr-body" });
      c.trafficStats = h("div", { class: "s-stats" });
      c.trafficRest = h("div", { class: "s-tr-rest" });
      c.trafficBody.append(c.trafficStats, c.reqs.el, c.trafficRest);
      c.traffic.append(c.trafficHead, c.trafficBody);
      c.trafficHead.onclick = () => { App.traffic.open[hostId] = !(App.traffic.open[hostId] !== false); paint(hostId); };
    }
    c.trafficHead.textContent = "";
    c.trafficHead.append(...[h("span", { class: "c-chev" + (open ? "" : " closed"), html: Icon("chevron", 14) }),
      h("div", { class: "s-sec-title", style: "margin:0" }, "Traefik traffic",
        h("span", { class: "count" }, `${perSec1(sum.rps)} now · ${sum.total} requests in the last ${Math.max(1, Math.round(sum.minutes))} min`)),
      sum.e5 ? h("span", { class: "s-tr-alert" }, `${sum.e5} errors 5xx`) : null,
      tst.err ? h("span", { class: "s-tr-alert" }, "Lost contact") : null].filter(Boolean));
    c.trafficBody.style.display = open ? "" : "none";
    if (!open) return;

    c.trafficStats.textContent = "";
    c.trafficStats.append(
      stat("Requests", perSec1(sum.rps), "last 10 seconds"),
      stat("Errors 5xx", sum.e5Pct ? (sum.e5Pct < 10 ? sum.e5Pct.toFixed(1) : Math.round(sum.e5Pct)) + "%" : "0%", `${sum.e5} of ${sum.total} in ${Math.max(1, Math.round(sum.minutes))} min`),
      stat("Response time", ms(sum.avg), `average · 95% under ${ms(sum.p95)}`),
      stat("Sent to visitors", rate(sum.outRate), "last 10 seconds"));
    c.reqs.update(App.traffic.series(hostId));

    c.trafficRest.textContent = "";
    const all = !!App.traffic.showAll[hostId];
    const rows = all ? sum.rows : sum.rows.slice(0, 6);
    const table = h("div", { class: "s-tr-table" },
      h("div", { class: "s-tr-row s-tr-th" }, h("span", {}, "Service"), h("span", {}, "Requests"), h("span", {}, "4xx"), h("span", {}, "5xx"), h("span", {}, "Average"), h("span", {}, "95%"), h("span", {}, "Sent")),
      ...rows.map((r) => {
        const dom = r.domains.length ? r.domains[0] + (r.domains.length > 1 ? ` +${r.domains.length - 1}` : "") : "";
        const row = h("div", { class: "s-tr-row" + (r.e5 ? " bad" : ""), title: r.domains.join("\n") },
          h("span", { class: "s-tr-svc" }, h("b", {}, r.service), dom ? h("small", {}, dom) : null),
          h("span", {}, perMin(r.perMin)), h("span", { class: r.e4 ? "" : "muted" }, String(r.e4)), h("span", { class: r.e5 ? "s-red" : "muted" }, String(r.e5)),
          h("span", {}, ms(r.avg)), h("span", {}, ms(r.p95)), h("span", {}, App.formatSize(r.bytes)));
        return row;
      }));
    const sec = h("div", { class: "s-sec" }, h("div", { class: "s-sec-title" }, "By service", h("span", { class: "count" }, `last ${Math.max(1, Math.round(sum.minutes))} min`)), table);
    if (sum.rows.length > 6) {
      const more = h("button", { class: "btn ghost lower s-tr-more" }, all ? "Show fewer" : `Show all ${sum.rows.length}`);
      more.onclick = () => { App.traffic.showAll[hostId] = !all; paint(hostId); };
      sec.append(more);
    }
    c.trafficRest.append(sec);
    if (sum.errors.length) {
      c.trafficRest.append(h("div", { class: "s-sec" }, h("div", { class: "s-sec-title" }, "Latest 5xx errors"),
        ...sum.errors.map((r) => h("div", { class: "s-tr-err" },
          h("span", { class: "s-tr-time" }, clock(r.t * 1000)), h("b", { class: "s-red" }, String(r.status)),
          h("span", { class: "s-tr-path", title: `${r.method} ${r.path}` }, `${r.method} ${r.path}`),
          h("span", { class: "s-tr-time" }, r.service), h("span", { class: "s-tr-time" }, ms(r.ms))))));
    }
    if (sum.gaps) c.trafficRest.append(h("div", { class: "s-stat-sub" }, "Traffic peaked above 1,500 requests per second at times; some requests were left out of these numbers."));
  };
  const perSec1 = (v) => (v < 10 ? v.toFixed(1) : Math.round(v)) + "/s";

  S.render = (p) => {
    page = p;
    p.innerHTML = "";
    for (const k of Object.keys(cards)) delete cards[k];
    p.append(h("div", { class: "toolbar" }, h("div", { class: "section-title", style: "margin:0" }, "Servers"),
      h("div", { class: "s-hint" }, "Live, every 2 seconds while this screen is open"), h("div", { class: "grow" })));
    const content = h("div", { class: "content" });
    p.append(content);
    const hosts = App.sortItems(App.data.hosts.filter((x) => App.usage.eligible(x) || S.live[x.id]), App.hostLabel);
    if (!hosts.length) {
      content.append(h("div", { class: "empty" }, h("div", { class: "empty-art", html: Icon("pulse", 48) }), h("h2", {}, "No servers to watch yet"),
        h("p", {}, "Servers show up here once their login works on its own: a saved username with a password or key, and a host key you already accepted. Connect to a server once to accept its key.")));
      return;
    }
    const grid = h("div", { class: "s-grid" });
    for (const x of hosts) grid.append(buildCard(x));
    content.append(grid);
    // The containers' "busiest" list follows the Containers screen's reading; ask for it once here too.
    setTimeout(() => { S.tick(); App.containers.tick(); }, 0);
  };
})();
