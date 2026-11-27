// Containers screen: the Docker containers of every saved host, grouped by host and by Easypanel project,
// with their usage, logs, a shell inside them and start / stop / restart. Easypanel runs on Docker Swarm,
// so its apps are services: those rows act on the service (scale and redeploy), not on one container.
(function () {
  const C = (App.containers = { data: {}, state: {}, query: "", problemsOnly: false, collapsed: {} });
  const INTERVAL_PAGE = 10000; // while the Containers screen is open
  const INTERVAL_CARDS = 30000; // for the summary on host cards
  const RETRY_OFFLINE = 60000;
  let page = null;

  C.enabled = () => App.data.settings.hostContainers !== false;

  const loginKey = (t) => JSON.stringify([t.host, t.port, t.username, t.password, t.key, t.passphrase, t.trusted, t.chain]);
  const onPage = () => App.current === "vaults" && App.vaultPage === "containers";
  // The host cards and the Servers screen's "busiest containers" use the slower refresh.
  const onHosts = () => App.current === "vaults" && (App.vaultPage === "hosts" || App.vaultPage === "servers");

  // ---------- reading ----------
  const pollHost = async (host, every, force) => {
    const t = App.usage.eligible(host);
    const st = (C.state[host.id] = C.state[host.id] || {});
    if (!t) { delete C.data[host.id]; return; }
    const key = loginKey(t);
    if (st.key !== key) { st.blockedKey = null; st.retryAt = 0; }
    if (st.busy) return;
    if (!force) {
      if (st.blockedKey === key) return;
      if (st.retryAt && Date.now() < st.retryAt) return;
      if (st.at && Date.now() - st.at < every - 1000) return;
    }
    st.busy = true; st.key = key; st.at = Date.now();
    paintHost(host.id);
    try {
      C.data[host.id] = { at: Date.now(), res: await App.invoke("host_containers", { id: host.id, target: t }) };
      st.blockedKey = null; st.retryAt = 0;
    } catch (e) {
      const msg = String(e);
      C.data[host.id] = { at: Date.now(), err: msg };
      if (/^(AUTH_|HOSTKEY_|KEY_|UNSUPPORTED|NO_DOCKER|DOCKER_PERMISSION)/.test(msg)) st.blockedKey = key;
      else st.retryAt = Date.now() + RETRY_OFFLINE;
    } finally {
      st.busy = false;
      paintHost(host.id);
    }
  };

  const demoOnly = () => App.screenshotMode && App.data.hosts.every((x) => String(x.id).startsWith("demo-"));

  C.tick = () => {
    if (!C.enabled() || document.hidden || demoOnly()) return;
    if (onPage()) App.data.hosts.forEach((x) => pollHost(x, INTERVAL_PAGE));
    else if (onHosts()) App.data.hosts.forEach((x) => pollHost(x, INTERVAL_CARDS));
  };

  C.cleanup = () => {
    const ids = new Set(App.data.hosts.map((x) => x.id));
    for (const id of Object.keys(C.state)) if (!ids.has(id) || !C.enabled()) { delete C.state[id]; delete C.data[id]; }
  };

  // Made-up containers for the check pictures of the made-up hosts only.
  C.demo = () => {
    const c = (name, image, state, status, service, project, cpu, mem, limit) =>
      ({ id: name, name, image, state, status, created: "", ports: "", service, project, cpu, mem_used: mem, mem_limit: limit, net_rx: 3.2e7, net_tx: 1.1e8, pids: 12 });
    C.data["demo-h1"] = { at: Date.now(), res: {
      containers: [
        c("shop_api.1.a1", "easypanel/shop/api:latest", "running", "Up 3 hours (healthy)", "shop_api", "shop", 12.4, 3.1e8, 2e9),
        c("shop_web.1.b2", "easypanel/shop/web:latest", "running", "Up 3 hours", "shop_web", "shop", 2.1, 1.2e8, 2e9),
        c("easypanel.1.c3", "easypanel/easypanel:latest", "running", "Up 2 days", "easypanel", "", 0.8, 2.2e8, 8e9),
        c("redis-cache", "redis:7", "exited", "Exited (1) 5 minutes ago", "", "", null, 0, 0),
      ],
      services: [
        { id: "s1", name: "shop_api", mode: "replicated", running: 1, wanted: 1, image: "easypanel/shop/api:latest", project: "shop" },
        { id: "s2", name: "shop_web", mode: "replicated", running: 1, wanted: 1, image: "easypanel/shop/web:latest", project: "shop" },
        { id: "s3", name: "shop_worker", mode: "replicated", running: 0, wanted: 0, image: "easypanel/shop/worker:latest", project: "shop" },
        { id: "s4", name: "easypanel", mode: "replicated", running: 1, wanted: 1, image: "easypanel/easypanel:latest", project: "" },
      ],
    } };
  };

  C.start = () => {
    if (demoOnly()) C.demo();
    setInterval(() => { C.cleanup(); C.tick(); }, 5000);
    document.addEventListener("visibilitychange", () => !document.hidden && C.tick());
    setTimeout(C.tick, 800);
  };

  // ---------- rows ----------
  // One row per Swarm service (with its running tasks) and per plain container. Exited tasks of a
  // service are its history, so they are left out.
  const rowsOf = (res) => {
    const rows = [];
    const svcNames = new Set(res.services.map((s) => s.name));
    for (const s of res.services) {
      const tasks = res.containers.filter((c) => c.service === s.name && c.state === "running");
      const sum = (k) => tasks.reduce((a, c) => a + (c[k] || 0), 0);
      const cpus = tasks.filter((c) => c.cpu != null);
      const health = s.wanted === 0 ? "stopped" : s.running < s.wanted ? "bad" : tasks.some((c) => /unhealthy/i.test(c.status)) ? "warn" : "ok";
      rows.push({
        kind: "service", name: s.name, image: s.image, project: s.project, mode: s.mode,
        health, statusText: s.wanted === 0 ? "Stopped" : `${s.running}/${s.wanted} running`,
        detail: tasks[0] ? tasks[0].status : "", ports: tasks.map((c) => c.ports).filter(Boolean).join(", "),
        cpu: cpus.length ? cpus.reduce((a, c) => a + c.cpu, 0) : null,
        mem_used: sum("mem_used"), mem_limit: tasks.length ? Math.max(...tasks.map((c) => c.mem_limit || 0)) : 0,
        net_rx: sum("net_rx"), net_tx: sum("net_tx"),
        // A service that should run but has no task (0/1) offers Restart (redeploy), not Start.
        shellTarget: tasks[0] ? tasks[0].name : null, running: s.wanted > 0,
      });
    }
    for (const c of res.containers) {
      if (c.service && svcNames.has(c.service)) continue;
      if (c.service && c.state !== "running") continue;
      const exitCode = /^Exited \((\d+)\)/.exec(c.status);
      const health = c.state === "running" ? (/unhealthy/i.test(c.status) ? "warn" : "ok")
        : c.state === "restarting" || c.state === "dead" || (exitCode && exitCode[1] !== "0") ? "bad"
        : c.state === "paused" ? "warn" : "stopped";
      rows.push({
        kind: "container", name: c.name, image: c.image, project: c.project,
        health, statusText: c.state.charAt(0).toUpperCase() + c.state.slice(1),
        detail: c.status, ports: c.ports, cpu: c.cpu, mem_used: c.mem_used, mem_limit: c.mem_limit,
        net_rx: c.net_rx, net_tx: c.net_tx, shellTarget: c.state === "running" ? c.name : null, running: c.state === "running",
      });
    }
    return rows;
  };

  C.summary = (hostId) => {
    const d = C.data[hostId];
    if (!d || !d.res) return null;
    const rows = rowsOf(d.res);
    return {
      running: rows.filter((r) => r.health === "ok" || r.health === "warn").length,
      stopped: rows.filter((r) => r.health === "stopped").length,
      down: rows.filter((r) => r.health === "bad").length,
    };
  };

  // ---------- host card summary ----------
  C.badge = (hostId) => {
    const el = h("div", { class: "cbadge" });
    fillBadge(el, hostId);
    return el;
  };
  const fillBadge = (el, hostId) => {
    el.innerHTML = "";
    const s = C.enabled() && C.summary(hostId);
    const card = el.closest(".card");
    if (!s || s.running + s.stopped + s.down === 0) { el.classList.remove("on"); card && card.classList.remove("has-cbadge"); return; }
    el.classList.add("on");
    card && card.classList.add("has-cbadge");
    el.append(App.icon("box", 12), h("span", {}, `${s.running} running`));
    if (s.stopped) el.append(h("span", { class: "muted" }, `· ${s.stopped} stopped`));
    if (s.down) el.append(h("span", { class: "bad" }, `· ${s.down} down`));
    el.title = "Open containers";
    el.onclick = (e) => { e.stopPropagation(); C.focusHost = hostId; App.openVaultPage("containers"); };
  };

  const paintHost = (hostId) => {
    document.querySelectorAll(`.card[data-host="${CSS.escape(hostId)}"] .cbadge`).forEach((el) => fillBadge(el, hostId));
    if (page && onPage()) drawHost(hostId);
  };

  // ---------- actions ----------
  const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const safe = (n) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(n || "");

  const openLogs = (host, r) => {
    if (!safe(r.name)) return;
    const cmd = r.kind === "service" ? `docker service logs -f --tail 200 ${quote(r.name)}` : `docker logs -f --tail 200 ${quote(r.name)}`;
    App.terminal.connectHost(host, { startup: cmd, title: `${r.name} · logs` });
  };

  const openShell = (host, r) => {
    if (!safe(r.shellTarget)) return;
    const cmd = `docker exec -it ${quote(r.shellTarget)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`;
    App.terminal.connectHost(host, { startup: cmd, title: `${r.name} · shell` });
  };

  const ACTION_TEXT = { start: ["Start", "Starting"], stop: ["Stop", "Stopping"], restart: ["Restart", "Restarting"] };
  const act = async (host, r, action) => {
    const [verb, ing] = ACTION_TEXT[action];
    if (action !== "start") {
      const what = r.kind === "service"
        ? (action === "stop" ? `Scale the service "${r.name}" to 0 on ${App.hostLabel(host)}? Its app goes offline until you start it again.`
          : `Redeploy the service "${r.name}" on ${App.hostLabel(host)}? Its containers are replaced one by one.`)
        : `${verb} the container "${r.name}" on ${App.hostLabel(host)}?`;
      if (!(await App.confirm(`${verb} ${r.kind}`, what, verb, action === "stop" ? "danger" : "primary"))) return;
    }
    const t = App.usage.eligible(host);
    if (!t) return;
    const key = `${host.id}|${r.name}`;
    C.pending = C.pending || {};
    C.pending[key] = ing;
    drawHost(host.id);
    try {
      await App.invoke("container_action", { id: host.id, target: t, kind: r.kind, name: r.name, action });
      App.toast(`${verb}: ${r.name}`);
    } catch (e) {
      App.toast(App.errText(e), true);
    } finally {
      delete C.pending[key];
      // Swarm needs a moment to move tasks before the new state shows.
      setTimeout(() => pollHost(host, 0, true), r.kind === "service" ? 2500 : 300);
    }
  };

  const rowMenu = (host, r) => [
    { name: "Logs", icon: "logs", handler: () => openLogs(host, r) },
    { name: "Shell", icon: "terminal", disabled: !r.shellTarget, handler: () => openShell(host, r) },
    "-",
    { name: "Start", icon: "play", disabled: r.running && !(r.kind === "service" && r.health === "stopped"), handler: () => act(host, r, "start") },
    { name: "Restart", icon: "refresh", disabled: !r.running, handler: () => act(host, r, "restart") },
    { name: "Stop", icon: "stop", danger: true, disabled: !r.running || (r.kind === "service" && r.mode === "global"), handler: () => act(host, r, "stop") },
    "-",
    { name: "Copy name", icon: "copy", handler: () => navigator.clipboard.writeText(r.name) },
  ];

  // ---------- drawing ----------
  const gb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB");
  const level = (v, warn, bad) => (v >= bad ? " bad" : v >= warn ? " warn" : "");
  const meter = (pct, cls) => h("i", { class: "bar" + cls }, h("i", { style: `width:${Math.max(0, Math.min(100, Math.round(pct)))}%` }));

  const rowEl = (host, r) => {
    const pending = C.pending && C.pending[`${host.id}|${r.name}`];
    const cpu = r.cpu != null ? h("div", { class: "c-num" + level(r.cpu, 70, 90) }, meter(r.cpu, ""), r.cpu.toFixed(r.cpu < 10 ? 1 : 0) + "%") : h("div", { class: "c-num muted" }, "—");
    const memPct = r.mem_limit ? (r.mem_used / r.mem_limit) * 100 : 0;
    const mem = r.mem_used ? h("div", { class: "c-num" + level(memPct, 75, 90), title: r.mem_limit ? `${gb(r.mem_used)} of ${gb(r.mem_limit)}` : "" }, meter(memPct, ""), gb(r.mem_used)) : h("div", { class: "c-num muted" }, "—");
    const net = r.net_rx || r.net_tx ? h("div", { class: "c-num c-net", title: "Received / sent since the container started" }, `↓${App.formatSize(r.net_rx)} ↑${App.formatSize(r.net_tx)}`) : h("div", { class: "c-num c-net muted" }, "—");
    const btn = (icon, title, fn, disabled) => {
      const b = h("button", { class: "icon-btn", title, html: Icon(icon, 14), disabled: disabled || undefined });
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };
    const more = btn("dots", "More", () => {});
    more.onclick = (e) => { e.stopPropagation(); App.menu(e, rowMenu(host, r)); };
    const el = h("div", { class: "c-row " + r.health, title: r.detail || "" },
      h("span", { class: "c-dot" }),
      h("div", { class: "c-name" }, h("div", { class: "title" }, r.name, r.kind === "service" ? h("span", { class: "c-kind" }, "service") : null),
        h("div", { class: "subtitle" }, [r.image, r.ports].filter(Boolean).join(" · "))),
      h("div", { class: "c-status" }, pending ? pending + "..." : r.statusText),
      cpu, mem, net,
      h("div", { class: "c-actions" },
        btn("logs", "Logs", () => openLogs(host, r)),
        btn("terminal", "Shell", () => openShell(host, r), !r.shellTarget),
        r.running ? btn("refresh", "Restart", () => act(host, r, "restart")) : btn("play", "Start", () => act(host, r, "start")),
        more));
    el.oncontextmenu = (e) => { e.preventDefault(); App.menu(e, rowMenu(host, r)); };
    el.ondblclick = () => openLogs(host, r);
    return el;
  };

  const ERRORS = {
    NO_DOCKER: "Docker isn't installed on this host.",
    DOCKER_PERMISSION: "This login can't use Docker. Add the user to the docker group (sudo usermod -aG docker USER) and log in again.",
    DOCKER_DOWN: "Docker is installed but not running.",
    OFFLINE: "Can't reach this host right now. Trying again in a minute.",
  };

  const hostBlock = (host) => {
    const block = h("div", { class: "c-host", "data-chost": host.id });
    fillHost(block, host);
    return block;
  };

  const fillHost = (block, host) => {
    block.innerHTML = "";
    const d = C.data[host.id];
    const st = C.state[host.id] || {};
    const collapsed = !!C.collapsed[host.id];
    const s = C.summary(host.id);
    const head = h("div", { class: "c-head" },
      h("span", { class: "c-chev" + (collapsed ? " closed" : ""), html: Icon("chevron", 14) }),
      App.avatar(host.os, App.hostLabel(host), "avatar small"),
      h("div", { class: "c-host-title" }, App.hostLabel(host)),
      s ? h("div", { class: "c-host-sum" }, `${s.running} running`, s.stopped ? ` · ${s.stopped} stopped` : "", s.down ? h("span", { class: "bad" }, ` · ${s.down} down`) : null) : null,
      h("div", { class: "grow" }),
      st.busy ? h("span", { class: "c-spin", html: Icon("refresh", 14) }) : null,
      d && d.at ? h("span", { class: "c-time" }, new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })) : null);
    const refresh = h("button", { class: "icon-btn", title: "Refresh now", html: Icon("refresh", 14) });
    refresh.onclick = (e) => { e.stopPropagation(); pollHost(host, 0, true); };
    head.append(refresh);
    head.onclick = () => { C.collapsed[host.id] = !collapsed; fillHost(block, host); };
    block.append(head);
    if (collapsed) return;
    const body = h("div", { class: "c-body" });
    block.append(body);
    if (!d) { body.append(h("div", { class: "c-msg" }, h("span", { class: "skel", style: "width:220px" }))); return; }
    if (d.err) {
      const code = d.err.split("|")[0];
      body.append(h("div", { class: "c-msg" + (code === "NO_DOCKER" ? "" : " bad") }, ERRORS[code] || App.errText(d.err)));
      return;
    }
    const q = C.query.toLowerCase();
    let rows = rowsOf(d.res);
    if (C.problemsOnly) rows = rows.filter((r) => r.health !== "ok");
    if (q) rows = rows.filter((r) => [r.name, r.image, r.project, r.ports].join(" ").toLowerCase().includes(q));
    if (!rows.length) { body.append(h("div", { class: "c-msg" }, q || C.problemsOnly ? "Nothing matches." : "No containers on this host.")); return; }
    const groups = {};
    for (const r of rows) (groups[r.project || ""] = groups[r.project || ""] || []).push(r);
    const order = { bad: 0, warn: 1, ok: 2, stopped: 3 };
    for (const name of Object.keys(groups).sort((a, b) => (a === "") - (b === "") || a.localeCompare(b))) {
      body.append(h("div", { class: "c-project" }, name || "No project", h("span", { class: "count" }, String(groups[name].length))));
      groups[name].sort((a, b) => order[a.health] - order[b.health] || a.name.localeCompare(b.name));
      for (const r of groups[name]) body.append(rowEl(host, r));
    }
  };

  const drawHost = (hostId) => {
    if (!page) return;
    const block = page.querySelector(`.c-host[data-chost="${CSS.escape(hostId)}"]`);
    const host = App.byId("hosts", hostId);
    if (block && host) fillHost(block, host);
  };

  C.render = (p) => {
    page = p;
    p.innerHTML = "";
    const input = h("input", { placeholder: "Find a container, image or project", value: C.query });
    p.append(h("div", { class: "searchbar" }, h("div", { class: "search" }, App.icon("search", 16), input)));
    const only = h("button", { class: "btn ghost lower" + (C.problemsOnly ? " on" : "") }, App.icon("bolt", 14), "Only problems and stopped");
    only.onclick = () => { C.problemsOnly = !C.problemsOnly; only.classList.toggle("on", C.problemsOnly); drawAll(); };
    const refreshAll = h("button", { class: "btn ghost" }, App.icon("refresh", 14), "Refresh");
    refreshAll.onclick = () => App.data.hosts.forEach((x) => pollHost(x, 0, true));
    p.append(h("div", { class: "toolbar" }, h("div", { class: "grow" }), only, refreshAll));
    const content = h("div", { class: "content" });
    p.append(content);
    const drawAll = () => {
      content.innerHTML = "";
      if (!C.enabled()) {
        content.append(h("div", { class: "empty" }, h("div", { class: "empty-art", html: Icon("box", 48) }), h("h2", {}, "Containers are turned off"),
          h("p", {}, "Turn on \"Show Docker containers\" in Settings > Terminal.")));
        return;
      }
      const hosts = App.sortItems(App.data.hosts.filter((x) => App.usage.eligible(x) || C.data[x.id]), App.hostLabel)
        .filter((x) => !(C.data[x.id] && C.data[x.id].err && C.data[x.id].err.startsWith("NO_DOCKER")));
      if (!hosts.length) {
        content.append(h("div", { class: "empty" }, h("div", { class: "empty-art", html: Icon("box", 48) }), h("h2", {}, "No Docker hosts yet"),
          h("p", {}, "Hosts show up here once their login works on its own: a saved username with a password or key, and a host key you already accepted. Connect to a host once to accept its key.")));
        return;
      }
      content.append(h("div", { class: "section-title" }, "Containers", h("span", { class: "count" }, `${hosts.length} host${hosts.length === 1 ? "" : "s"}`)));
      for (const x of hosts) content.append(hostBlock(x));
      if (C.focusHost) {
        const el = content.querySelector(`.c-host[data-chost="${CSS.escape(C.focusHost)}"]`);
        C.collapsed[C.focusHost] = false;
        if (el) setTimeout(() => el.scrollIntoView({ block: "start" }), 0);
        C.focusHost = null;
      }
    };
    let typing;
    input.oninput = () => { C.query = input.value; clearTimeout(typing); typing = setTimeout(drawAll, 120); };
    drawAll();
    setTimeout(() => { input.focus(); C.tick(); }, 0);
  };
})();
