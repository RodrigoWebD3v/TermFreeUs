// Host usage on the host cards: CPU, memory and battery of the hosts whose saved login works,
// read every 10 seconds over a quiet SSH connection while the Hosts screen is open.
(function () {
  const U = (App.usage = { stats: {}, state: {} });
  const INTERVAL = 10000;
  const RETRY_OFFLINE = 60000;
  // Check pictures only: hold every card in its loading state to show the skeleton.
  const SHOT_LOADING = App.screenshotMode && App.screenshotView === "usage-loading";

  U.enabled = () => App.data.settings.hostUsage !== false;

  // Only hosts that can log in on their own: a username and an already trusted host key, so a check
  // never asks for anything. A host whose login failed waits until its saved login changes.
  const loginKey = (t) => JSON.stringify([t.host, t.port, t.username, t.password, t.key, t.passphrase, t.trusted, t.chain]);
  const eligible = (host) => {
    if (!host.address || host.quick) return null;
    const t = App.targetFor(host);
    if (!t.username || !t.trusted.length) return null;
    if ((t.chain || []).some((c) => !c.username || !c.trusted.length)) return null;
    return t;
  };

  U.eligible = eligible;

  const pollHost = async (host) => {
    const t = eligible(host);
    const st = (U.state[host.id] = U.state[host.id] || {});
    if (!t) { delete U.stats[host.id]; return; }
    const key = loginKey(t);
    const fresh = st.at && Date.now() - st.at < INTERVAL - 1000 && st.key === key;
    if (st.busy || fresh || (st.blockedKey && st.blockedKey === key) || (st.retryAt && Date.now() < st.retryAt && st.key === key)) return;
    st.busy = true;
    st.key = key;
    st.at = Date.now();
    if (!U.stats[host.id]) U.paint(host.id); // skeleton while the first numbers are on their way
    try {
      U.stats[host.id] = Object.assign(await App.invoke("host_stats", { id: host.id, target: t }), { at: Date.now() });
      st.blockedKey = null; st.retryAt = 0;
    } catch (e) {
      const msg = String(e);
      delete U.stats[host.id];
      if (/^(AUTH_|HOSTKEY_|KEY_|UNSUPPORTED)/.test(msg)) st.blockedKey = key;
      else st.retryAt = Date.now() + RETRY_OFFLINE;
    } finally {
      st.busy = false;
      U.paint(host.id);
    }
  };

  U.tick = () => {
    if (SHOT_LOADING) return;
    if (App.screenshotMode && App.data.hosts.every((x) => String(x.id).startsWith("demo-"))) return;
    if (!U.enabled() || document.hidden || App.current !== "vaults" || App.vaultPage !== "hosts") return;
    for (const host of App.data.hosts) pollHost(host);
  };

  // Sample numbers for the made-up hosts shown in check pictures only.
  U.demo = () => {
    const now = Date.now();
    U.stats["demo-h1"] = { cpu: 23, mem_used: 2.6e9, mem_total: 8.3e9, battery: null, at: now };
    U.stats["demo-h2"] = { cpu: 71, mem_used: 13.1e9, mem_total: 16.6e9, battery: null, at: now };
    U.stats["demo-h4"] = { cpu: 8, mem_used: 0.9e9, mem_total: 4.1e9, battery: 64, battery_status: "Charging", at: now };
  };

  const gb = (b) => (b / 1073741824).toFixed(b >= 10 * 1073741824 ? 0 : 1) + " GB";
  const level = (v, warn, bad) => (v >= bad ? " bad" : v >= warn ? " warn" : "");

  const meter = (label, pct, cls, title) =>
    h("span", { class: "meter" + cls, title },
      h("b", {}, label),
      h("i", { class: "bar" }, h("i", { style: `width:${Math.round(pct)}%` })),
      Math.round(pct) + "%");

  const battery = (pct, status) => {
    const charging = /charging|full/i.test(status || "") && !/discharging|not charging/i.test(status || "");
    const cls = pct <= 15 ? " bad" : pct <= 30 ? " warn" : "";
    const fill = Math.max(1, Math.round((pct / 100) * 12));
    const svg = `<svg width="20" height="11" viewBox="0 0 20 11"><rect x="0.5" y="0.5" width="16" height="10" rx="2" fill="none" stroke="currentColor"/>` +
      `<rect x="17.5" y="3.5" width="2" height="4" rx="1" fill="currentColor"/><rect class="lvl" x="2.5" y="2.5" width="${fill}" height="6" rx="1"/>` +
      (charging ? `<path d="M9.6 1.8 6.6 6h2.2l-1 3.4 3.4-4.6H9l1-3z" fill="#fff" stroke="var(--card-bg)" stroke-width=".6"/>` : "") + `</svg>`;
    return h("span", { class: "meter batt" + cls, title: `Battery ${pct}%` + (status ? ` (${status})` : "") },
      h("span", { class: "batt-ico", html: svg }), pct + "%");
  };

  // Before a host's first numbers arrive: a host that will be read and isn't known to fail.
  U.loading = (hostId) => {
    if (SHOT_LOADING) return true;
    if (!U.enabled() || U.stats[hostId]) return false;
    const st = U.state[hostId];
    if (st) return !!st.busy;
    const host = App.byId("hosts", hostId);
    return !!(host && eligible(host));
  };

  const skeleton = (el) => {
    el.classList.add("on", "loading");
    el.title = "Reading usage...";
    for (const w of [62, 66, 40]) el.append(h("span", { class: "skel", style: `width:${w}px` }));
  };

  // The usage line for a host card; empty while there's nothing to show.
  U.badge = (hostId) => {
    const el = h("div", { class: "usage" });
    fill(el, hostId);
    return el;
  };

  const fill = (el, hostId) => {
    const wasLoading = el.classList.contains("loading");
    el.innerHTML = "";
    el.classList.remove("loading", "fresh");
    el.removeAttribute("title");
    const s = U.enabled() && U.stats[hostId];
    const card = el.closest(".card");
    if (!s && U.loading(hostId)) { skeleton(el); card && card.classList.add("has-usage"); return; }
    if (!s) { el.classList.remove("on"); card && card.classList.remove("has-usage"); return; }
    el.classList.add("on");
    if (wasLoading) el.classList.add("fresh");
    card && card.classList.add("has-usage");
    if (s.cpu != null) el.append(meter("CPU", s.cpu, level(s.cpu, 70, 90), `Processor ${s.cpu.toFixed(1)}% busy`));
    if (s.mem_total) {
      const pct = (s.mem_used / s.mem_total) * 100;
      el.append(meter("RAM", pct, level(pct, 75, 90), `Memory ${gb(s.mem_used)} of ${gb(s.mem_total)} used`));
    }
    if (s.battery != null) el.append(battery(s.battery, s.battery_status));
  };

  U.paint = (hostId) => {
    document.querySelectorAll(`.card[data-host="${CSS.escape(hostId)}"] .usage`).forEach((el) => fill(el, hostId));
  };

  // Connections of removed hosts are closed; turning the setting off closes them all.
  U.cleanup = () => {
    const ids = new Set(App.data.hosts.map((x) => x.id));
    for (const id of Object.keys(U.state)) {
      if (!ids.has(id) || !U.enabled()) {
        App.invoke("host_stats_forget", { id }).catch(() => {});
        delete U.state[id]; delete U.stats[id];
      }
    }
  };

  U.start = () => {
    if (App.screenshotMode && !SHOT_LOADING && App.data.hosts.every((x) => String(x.id).startsWith("demo-"))) U.demo();
    setInterval(() => { U.cleanup(); U.tick(); }, INTERVAL);
    document.addEventListener("visibilitychange", () => !document.hidden && U.tick());
    setTimeout(U.tick, 300);
  };
})();
