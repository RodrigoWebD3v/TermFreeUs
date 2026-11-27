// Databases screen: the PostgreSQL, MySQL / MariaDB and Redis containers of every saved host, with live numbers,
// the statements running right now and, for Redis, the slow log. Read only: the host answers fixed queries run
// inside each database's own container (see dba.rs), so nothing here can change data.
(function () {
  const D = (App.databases = { data: {}, state: {}, prev: {}, rates: {}, query: "", collapsed: {} });
  const INTERVAL = 10000; // while the Databases screen is open
  const RETRY_OFFLINE = 60000;
  let page = null;

  const loginKey = (t) => JSON.stringify([t.host, t.port, t.username, t.password, t.key, t.passphrase, t.trusted, t.chain]);
  const onPage = () => App.current === "vaults" && App.vaultPage === "databases";

  // ---------- reading ----------
  // Counters (queries, commits) only mean something as a change over time, so keep the last reading of each.
  const COUNTER = { postgres: (m) => (m.xact_commit || 0) + (m.xact_rollback || 0), mysql: (m) => m.questions, redis: (m) => m.commands };
  const trackRates = (hostId, res, at) => {
    for (const i of res.instances) {
      if (i.error) continue;
      const key = `${hostId}|${i.id}`;
      const v = COUNTER[i.kind](i.metrics);
      const p = D.prev[key];
      if (p && v != null && v >= p.v && at > p.at) D.rates[key] = (v - p.v) / ((at - p.at) / 1000);
      else if (p && v < p.v) delete D.rates[key]; // the server restarted
      D.prev[key] = { v, at };
    }
  };

  const pollHost = async (host, force) => {
    const t = App.usage.eligible(host);
    const st = (D.state[host.id] = D.state[host.id] || {});
    if (!t) { delete D.data[host.id]; return; }
    const key = loginKey(t);
    if (st.key !== key) { st.blockedKey = null; st.retryAt = 0; }
    if (st.busy) return;
    if (!force) {
      if (st.blockedKey === key) return;
      if (st.retryAt && Date.now() < st.retryAt) return;
      if (st.at && Date.now() - st.at < INTERVAL - 1000) return;
    }
    st.busy = true; st.key = key; st.at = Date.now();
    paintHost(host.id);
    try {
      const res = await App.invoke("host_databases", { id: host.id, target: t });
      const at = Date.now();
      trackRates(host.id, res, at);
      D.data[host.id] = { at, res };
      st.blockedKey = null; st.retryAt = 0;
    } catch (e) {
      const msg = String(e);
      D.data[host.id] = { at: Date.now(), err: msg };
      if (/^(AUTH_|HOSTKEY_|KEY_|UNSUPPORTED|NO_DOCKER|DOCKER_PERMISSION)/.test(msg)) st.blockedKey = key;
      else st.retryAt = Date.now() + RETRY_OFFLINE;
    } finally {
      st.busy = false;
      paintHost(host.id);
    }
  };

  D.tick = () => {
    if (document.hidden || !onPage()) return;
    App.data.hosts.forEach((x) => pollHost(x, false));
  };

  D.cleanup = () => {
    const ids = new Set(App.data.hosts.map((x) => x.id));
    for (const id of Object.keys(D.state)) if (!ids.has(id)) { delete D.state[id]; delete D.data[id]; }
  };

  // Made-up databases for the check pictures of the made-up hosts only.
  D.demo = () => {
    const base = { error: null, databases: [], activity: [], slow: [], role: "" };
    D.data["demo-h1"] = { at: Date.now(), res: { instances: [
      { ...base, kind: "postgres", id: "a1b2c3", name: "shop_db.1.x", image: "postgres:16", version: "16.3",
        metrics: { uptime: 864000, max_connections: 100, connections: 34, active: 3, idle_in_tx: 1, blocked: 0, xact_commit: 5.2e7, xact_rollback: 1200, deadlocks: 0, cache_hit: 99.2, size: 4.2e9 },
        databases: [{ name: "shop", size: 3.9e9, count: 28 }, { name: "postgres", size: 8e6, count: 1 }],
        activity: [{ id: "4242", db: "shop", user: "app", state: "active", secs: 14, query: "select o.id, sum(i.price) from orders o join items i on i.order_id = o.id group by o.id" },
                   { id: "4243", db: "shop", user: "app", state: "idle in transaction", secs: 75, query: "update stock set qty = qty - 1 where sku = 'A-100'" }] },
      { ...base, kind: "mysql", id: "b2c3d4", name: "shop_mysql.1.y", image: "mariadb:11", version: "11.4.2-MariaDB",
        metrics: { uptime: 432000, max_connections: 151, threads_connected: 12, threads_running: 2, max_used_connections: 40, questions: 9.1e8, slow_queries: 310, created_tmp_disk_tables: 4200, cache_hit: 99.7, innodb_buffer_pool_size: 1.07e9, bytes_received: 8e10, bytes_sent: 3e11, innodb_row_lock_current_waits: 0 },
        databases: [{ name: "shop", size: 8.4e8, count: 41 }], activity: [] },
      { ...base, kind: "redis", id: "c3d4e5", name: "cache.1.z", image: "redis:7", version: "7.2.4", role: "master",
        metrics: { uptime: 172800, clients: 9, blocked: 0, memory: 1.4e8, maxmemory: 2.5e8, ops: 840, commands: 3.3e8, hits: 9.0e7, misses: 1.0e7, hit_rate: 90, evicted: 0, expired: 5.1e6, keys: 52000, unsaved: 12, save_failed: 0, replicas: 0 },
        databases: [{ name: "db0", size: 0, count: 51000 }, { name: "db1", size: 0, count: 1000 }],
        slow: [{ at: Math.floor(Date.now() / 1000) - 300, micros: 15200, command: "keys session:*" }] },
    ] } };
  };

  D.start = () => {
    if (App.screenshotMode && App.data.hosts.every((x) => String(x.id).startsWith("demo-"))) D.demo();
    setInterval(() => { D.cleanup(); D.tick(); }, 5000);
    document.addEventListener("visibilitychange", () => !document.hidden && D.tick());
  };

  // ---------- formatting ----------
  const KIND = { postgres: "PostgreSQL", mysql: "MySQL", redis: "Redis" };
  const dur = (s) => {
    s = Math.max(0, Math.round(s));
    const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : m ? `${m}m` : `${s}s`;
  };
  const short = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : String(Math.round(n)));
  const pct = (v) => (v == null ? "—" : (v >= 99.95 || v < 10 ? v.toFixed(v >= 99.95 ? 0 : 1) : v.toFixed(1)) + "%");
  const rate = (r) => (r == null ? "—" : r < 10 ? r.toFixed(1) : short(r));
  const level = (v, warn, bad) => (v >= bad ? " bad" : v >= warn ? " warn" : "");
  const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const tile = (label, value, sub, bar, cls) =>
    h("div", { class: "s-stat" + (cls || "") },
      h("div", { class: "s-stat-label" }, label),
      h("div", { class: "s-stat-value" }, value),
      bar != null ? h("i", { class: "bar" + (cls || "") }, h("i", { style: `width:${Math.max(0, Math.min(100, Math.round(bar)))}%` })) : null,
      sub ? h("div", { class: "s-stat-sub", title: sub }, sub) : null);

  const tilesOf = (hostId, i) => {
    const m = i.metrics;
    const r = D.rates[`${hostId}|${i.id}`];
    if (i.kind === "postgres") {
      const cp = m.max_connections ? (m.connections / m.max_connections) * 100 : 0;
      return [
        tile("Connections", `${m.connections}`, `of ${m.max_connections} allowed`, cp, level(cp, 70, 90)),
        tile("Running now", `${m.active}`, m.idle_in_tx ? `${m.idle_in_tx} idle in transaction` : "statements executing", null, ""),
        tile("Waiting on locks", `${m.blocked}`, m.blocked ? "sessions are blocked" : "nothing blocked", null, m.blocked ? " bad" : ""),
        tile("Cache hit", pct(m.cache_hit), "reads served from memory", m.cache_hit, m.cache_hit < 90 ? " bad" : m.cache_hit < 97 ? " warn" : ""),
        tile("Transactions / s", rate(r), `${short(m.xact_commit)} committed · ${short(m.xact_rollback)} rolled back`),
        tile("Size", App.formatSize(m.size), `${i.databases.length} database${i.databases.length === 1 ? "" : "s"}`),
        tile("Deadlocks", `${m.deadlocks}`, "since statistics reset", null, m.deadlocks ? " warn" : ""),
        tile("Uptime", dur(m.uptime), `PostgreSQL ${i.version}`),
      ];
    }
    if (i.kind === "mysql") {
      const cp = m.max_connections ? (m.threads_connected / m.max_connections) * 100 : 0;
      return [
        tile("Connections", `${m.threads_connected ?? 0}`, `of ${m.max_connections ?? "?"} allowed · peak ${m.max_used_connections ?? "?"}`, cp, level(cp, 70, 90)),
        tile("Running now", `${m.threads_running ?? 0}`, "threads executing", null, level(m.threads_running || 0, 16, 64)),
        tile("Queries / s", rate(r), `${short(m.questions || 0)} since start`),
        tile("Slow queries", short(m.slow_queries || 0), `${short(m.created_tmp_disk_tables || 0)} temp tables on disk`, null, ""),
        tile("Buffer pool hit", pct(m.cache_hit), m.innodb_buffer_pool_size ? `pool ${App.formatSize(m.innodb_buffer_pool_size)}` : "", m.cache_hit, m.cache_hit < 90 ? " bad" : m.cache_hit < 97 ? " warn" : ""),
        tile("Row lock waits", `${m.innodb_row_lock_current_waits ?? 0}`, "InnoDB waiting right now", null, m.innodb_row_lock_current_waits ? " warn" : ""),
        tile("Traffic", `↓${App.formatSize(m.bytes_received || 0)}`, `↑${App.formatSize(m.bytes_sent || 0)} sent since start`),
        tile("Uptime", dur(m.uptime || 0), i.version),
      ];
    }
    const mp = m.maxmemory ? (m.memory / m.maxmemory) * 100 : null;
    return [
      tile("Memory", App.formatSize(m.memory), m.maxmemory ? `of ${App.formatSize(m.maxmemory)} limit` : "no memory limit set", mp, mp != null ? level(mp, 75, 90) : ""),
      tile("Operations / s", `${short(m.ops || 0)}`, `${short(m.commands || 0)} commands since start`),
      tile("Hit rate", pct(m.hit_rate), m.hit_rate == null ? "no reads yet" : `${short(m.hits)} hits · ${short(m.misses)} misses`, m.hit_rate, m.hit_rate != null && m.hit_rate < 50 ? " warn" : ""),
      tile("Clients", `${m.clients}`, m.blocked ? `${m.blocked} blocked` : "connected", null, m.blocked ? " warn" : ""),
      tile("Keys", short(m.keys || 0), i.databases.length ? `in ${i.databases.length} database${i.databases.length === 1 ? "" : "s"}` : "empty"),
      tile("Evicted keys", short(m.evicted || 0), `${short(m.expired || 0)} expired`, null, m.evicted ? " warn" : ""),
      tile("Last save", m.save_failed ? "Failed" : "OK", m.unsaved != null ? `${short(m.unsaved)} changes not saved yet` : "", null, m.save_failed ? " bad" : ""),
      tile("Uptime", dur(m.uptime || 0), `${i.role || "master"}${m.replicas ? ` · ${m.replicas} replica${m.replicas === 1 ? "" : "s"}` : ""} · ${i.version}`),
    ];
  };

  // ---------- tables ----------
  const copy = (text) => { navigator.clipboard.writeText(text); App.toast("Copied"); };

  const table = (title, count, head, rows) =>
    h("div", { class: "d-sec" },
      h("div", { class: "s-sec-title" }, title, h("span", { class: "count" }, String(count))),
      h("div", { class: "d-table", style: `--cols:${head.map((c) => c[1]).join(" ")}` },
        h("div", { class: "d-row d-head" }, ...head.map((c) => h("div", { class: c[2] || "" }, c[0]))),
        ...rows));

  const dbTable = (i) => {
    if (!i.databases.length) return null;
    const unit = i.kind === "redis" ? "Keys" : i.kind === "mysql" ? "Tables" : "Connections";
    const head = i.kind === "redis" ? [["Database", "1fr"], [unit, "100px", "num"]] : [["Database", "1fr"], ["Size", "100px", "num"], [unit, "100px", "num"]];
    const rows = i.databases.map((d) => h("div", { class: "d-row" },
      h("div", { class: "d-main" }, d.name),
      ...(i.kind === "redis" ? [] : [h("div", { class: "num" }, App.formatSize(d.size))]),
      h("div", { class: "num" }, short(d.count))));
    return table(i.kind === "mysql" ? "Schemas" : i.kind === "redis" ? "Keyspace" : "Databases", i.databases.length, head, rows);
  };

  const actTable = (i) => {
    if (i.kind === "redis") return null;
    const head = [["Time", "64px", "num"], ["State", "150px"], ["User · database", "180px"], ["Statement", "1fr"]];
    const rows = i.activity.map((a) => {
      const row = h("div", { class: "d-row click" + (a.secs >= 60 ? " bad" : a.secs >= 10 ? " warn" : ""), title: "Click to copy the statement" },
        h("div", { class: "num" }, dur(a.secs)),
        h("div", { class: "d-dim" }, a.state),
        h("div", { class: "d-dim" }, [a.user, a.db].filter(Boolean).join(" · ")),
        h("div", { class: "d-main mono" }, a.query || "—"));
      row.onclick = () => a.query && copy(a.query);
      return row;
    });
    const t = table("Running now", i.activity.length, head, rows);
    if (!rows.length) t.append(h("div", { class: "c-msg" }, "No statement is running."));
    return t;
  };

  const slowTable = (i) => {
    if (i.kind !== "redis") return null;
    const head = [["When", "90px", "num"], ["Took", "80px", "num"], ["Command", "1fr"]];
    const rows = i.slow.map((s) => {
      const row = h("div", { class: "d-row click" + (s.micros >= 100000 ? " bad" : s.micros >= 10000 ? " warn" : ""), title: "Click to copy the command" },
        h("div", { class: "num" }, s.at ? new Date(s.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"),
        h("div", { class: "num" }, s.micros >= 1000 ? `${(s.micros / 1000).toFixed(s.micros >= 10000 ? 0 : 1)} ms` : `${s.micros} µs`),
        h("div", { class: "d-main mono" }, s.command));
      row.onclick = () => copy(s.command);
      return row;
    });
    const t = table("Slow log", i.slow.length, head, rows);
    if (!rows.length) t.append(h("div", { class: "c-msg" }, "Nothing slow has been logged."));
    return t;
  };

  // ---------- emptying a Redis ----------
  // The one thing this screen can change. It asks first, shows what will go, and refuses nothing else:
  // the host only accepts a container ID that runs Redis (dba.rs).
  const flushRedis = async (host, i) => {
    const m = i.metrics;
    const what = `${short(m.keys || 0)} key${m.keys === 1 ? "" : "s"}, ${App.formatSize(m.memory || 0)} of memory`;
    const ok = await App.confirm("Empty Redis",
      `Delete every key from "${i.name}" on ${App.hostLabel(host)} (${what})? This can't be undone, and anything that lives only in this Redis is lost.`,
      "Empty it", "danger");
    if (!ok) return;
    const t = App.usage.eligible(host);
    if (!t) return;
    D.busy = D.busy || {};
    const key = `${host.id}|${i.id}`;
    D.busy[key] = true;
    App.toast("Emptying " + i.name + "...");
    try {
      await App.invoke("redis_flush", { id: host.id, target: t, container: i.id });
      App.toast(`${i.name} is empty`);
    } catch (e) {
      App.toast(App.errText(e), true);
    } finally {
      delete D.busy[key];
      pollHost(host, true);
    }
  };

  // ---------- instance and host blocks ----------
  const ERRORS = {
    NO_DOCKER: "Docker isn't installed on this host.",
    DOCKER_PERMISSION: "This login can't use Docker. Add the user to the docker group (sudo usermod -aG docker USER) and log in again.",
    DOCKER_DOWN: "Docker is installed but not running.",
    OFFLINE: "Can't reach this host right now. Trying again in a minute.",
  };

  const instanceEl = (host, i) => {
    const key = `${host.id}|${i.id}`;
    const card = h("div", { class: "d-card" });
    const head = h("div", { class: "d-top" },
      h("span", { class: "d-kind " + i.kind }, KIND[i.kind] || i.kind),
      h("div", { class: "d-title" }, i.name),
      h("div", { class: "d-image" }, i.image),
      h("div", { class: "grow" }));
    const btn = (icon, title, fn, cls) => {
      const b = h("button", { class: "icon-btn" + (cls ? " " + cls : ""), title, html: Icon(icon, 14) });
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      return b;
    };
    const safeId = /^[0-9a-f]+$/.test(i.id);
    if (i.kind === "redis") {
      // Console: redis-cli inside the container, signed in with the container's own REDIS_PASSWORD.
      head.append(btn("terminal", "Open the Redis console (redis-cli)", () => safeId && App.terminal.connectHost(host, {
        startup: `docker exec -it ${i.id} sh -c '[ -n "$REDISCLI_AUTH" ] || REDISCLI_AUTH="$REDIS_PASSWORD"; if [ -n "$REDISCLI_AUTH" ]; then export REDISCLI_AUTH; else unset REDISCLI_AUTH; fi; exec redis-cli'`,
        title: `${i.name} · redis`,
      })));
      head.append(btn("trash", "Empty this Redis (delete every key)", () => safeId && flushRedis(host, i), "danger"));
    } else {
      head.append(btn("terminal", "Open a shell in this container", () => safeId && App.terminal.connectHost(host, {
        startup: `docker exec -it ${i.id} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`, title: `${i.name} · shell`,
      })));
    }
    card.append(head);
    if (i.error) {
      const code = i.error.split("|")[0];
      card.append(h("div", { class: "c-msg bad" },
        code === "AUTH" ? "Couldn't sign in. The container's own login variables (for example POSTGRES_PASSWORD, MYSQL_ROOT_PASSWORD or REDIS_PASSWORD) are missing or wrong." : "Couldn't read this database.",
        h("div", { class: "d-err" }, App.errText(i.error))));
      return card;
    }
    card.append(h("div", { class: "s-stats d-tiles", "data-key": key }, ...tilesOf(host.id, i)));
    for (const sec of [dbTable(i), actTable(i), slowTable(i)]) if (sec) card.append(sec);
    return card;
  };

  const fillHost = (block, host) => {
    block.innerHTML = "";
    const d = D.data[host.id];
    const st = D.state[host.id] || {};
    const collapsed = !!D.collapsed[host.id];
    const n = d && d.res ? d.res.instances.length : 0;
    const head = h("div", { class: "c-head" },
      h("span", { class: "c-chev" + (collapsed ? " closed" : ""), html: Icon("chevron", 14) }),
      App.avatar(host.os, App.hostLabel(host), "avatar small"),
      h("div", { class: "c-host-title" }, App.hostLabel(host)),
      n ? h("div", { class: "c-host-sum" }, `${n} database${n === 1 ? "" : "s"}`) : null,
      h("div", { class: "grow" }),
      st.busy ? h("span", { class: "c-spin", html: Icon("refresh", 14) }) : null,
      d && d.at ? h("span", { class: "c-time" }, clock(d.at)) : null);
    const refresh = h("button", { class: "icon-btn", title: "Refresh now", html: Icon("refresh", 14) });
    refresh.onclick = (e) => { e.stopPropagation(); pollHost(host, true); };
    head.append(refresh);
    head.onclick = () => { D.collapsed[host.id] = !collapsed; fillHost(block, host); };
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
    const q = D.query.toLowerCase();
    const list = d.res.instances.filter((i) => !q || [i.name, i.image, i.kind, KIND[i.kind]].join(" ").toLowerCase().includes(q));
    if (!list.length) { body.append(h("div", { class: "c-msg" }, q ? "Nothing matches." : "No PostgreSQL, MySQL or Redis containers are running on this host.")); return; }
    for (const i of list) body.append(instanceEl(host, i));
  };

  const hostBlock = (host) => {
    const block = h("div", { class: "c-host", "data-dhost": host.id });
    fillHost(block, host);
    return block;
  };

  const paintHost = (hostId) => {
    if (!page || !onPage()) return;
    const block = page.querySelector(`.c-host[data-dhost="${CSS.escape(hostId)}"]`);
    const host = App.byId("hosts", hostId);
    if (block && host) fillHost(block, host);
  };

  D.render = (p) => {
    page = p;
    p.innerHTML = "";
    const input = h("input", { placeholder: "Find a database by name, image or type", value: D.query });
    p.append(h("div", { class: "searchbar" }, h("div", { class: "search" }, App.icon("search", 16), input)));
    const refreshAll = h("button", { class: "btn ghost" }, App.icon("refresh", 14), "Refresh");
    refreshAll.onclick = () => App.data.hosts.forEach((x) => pollHost(x, true));
    p.append(h("div", { class: "toolbar" }, h("span", { class: "s-hint" }, "Read only · every 10 s"), h("div", { class: "grow" }), refreshAll));
    const content = h("div", { class: "content" });
    p.append(content);
    const drawAll = () => {
      content.innerHTML = "";
      const hosts = App.sortItems(App.data.hosts.filter((x) => App.usage.eligible(x) || D.data[x.id]), App.hostLabel)
        .filter((x) => {
          const d = D.data[x.id];
          if (!d) return true;
          if (d.err) return !d.err.startsWith("NO_DOCKER");
          return d.res.instances.length > 0 || !!D.query;
        });
      if (!hosts.length) {
        const loaded = App.data.hosts.some((x) => D.data[x.id]);
        content.append(h("div", { class: "empty" }, h("div", { class: "empty-art", html: Icon("database", 48) }),
          h("h2", {}, loaded ? "No databases found" : "No hosts to read yet"),
          h("p", {}, loaded
            ? "Only PostgreSQL, MySQL / MariaDB and Redis running as Docker containers are shown."
            : "Hosts show up here once their login works on its own: a saved username with a password or key, and a host key you already accepted. Connect to a host once to accept its key.")));
        return;
      }
      content.append(h("div", { class: "section-title" }, "Databases", h("span", { class: "count" }, `${hosts.length} host${hosts.length === 1 ? "" : "s"}`)));
      for (const x of hosts) content.append(hostBlock(x));
    };
    D.redraw = drawAll;
    let typing;
    input.oninput = () => { D.query = input.value; clearTimeout(typing); typing = setTimeout(drawAll, 120); };
    drawAll();
    setTimeout(() => { input.focus(); D.tick(); }, 0);
  };
})();
