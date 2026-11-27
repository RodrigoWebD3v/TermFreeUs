// Shared helpers: saved data, calls to the Rust side, small DOM and dialog helpers.
(function () {
  const T = window.__TAURI__;
  const App = (window.App = {});

  App.invoke = (cmd, args) => (T ? T.core.invoke(cmd, args) : Promise.reject("not running inside the app"));
  App.listen = (ev, fn) => (T ? T.event.listen(ev, (e) => fn(e.payload)) : Promise.resolve(() => {}));
  App.emit = (ev, payload) => (T ? T.event.emit(ev, payload) : Promise.resolve());
  App.win = () => (T ? T.window.getCurrentWindow() : null);
  App.screenshotMode = location.hash.startsWith("#screenshot");
  App.screenshotView = location.hash.split("/")[1] || "";
  if (App.screenshotMode) {
    window.addEventListener("error", (e) => {
      const pre = document.createElement("pre");
      pre.style.cssText = "position:fixed;bottom:0;left:0;right:0;color:#f25e61;background:#000;z-index:99;margin:0;padding:6px";
      pre.textContent = e.message + " " + e.filename + ":" + e.lineno;
      document.body.append(pre);
    });
  }

  App.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------- saved data ----------
  // Defaults read from the original (see MECHANICS.md): text size 14 (4..40), scrollback 40000,
  // theme "default dark", keepalive 0 (off), terminal type xterm-256color.
  App.defaultSettings = () => ({
    fontSize: 14,
    fontFamily: "Source Code Pro",
    theme: "default dark",
    copyOnSelect: false,
    rightClickPaste: false,
    bell: false,
    brightBold: true,
    keepalive: 0,
    scrollback: 40000,
    termType: "xterm-256color",
    localShell: "",
    autoReconnect: false,
    logsEnabled: true,
    hostUsage: true,
    hostContainers: true,
    localKeys: true,
    layout: "grid",
    sort: "az",
    uiTheme: "light", paletteVersion: 1,
    uiMotion: "system",
  });

  const empty = () => ({
    version: 1,
    groups: [], hosts: [], keys: [], identities: [], snippets: [], packages: [],
    rules: [], knownHosts: [], logs: [], settings: App.defaultSettings(),
  });

  App.data = empty();

  App.load = async () => {
    let raw = "";
    try { raw = await App.invoke("data_load"); } catch (e) { raw = localStorage.getItem("shellbox") || ""; }
    const d = empty();
    if (raw) {
      try { Object.assign(d, JSON.parse(raw)); } catch (e) { console.error(e); }
    }
    const previousSettings = d.settings || {}; d.settings = Object.assign(App.defaultSettings(), previousSettings); if (!previousSettings.paletteVersion) { d.settings.uiTheme = "light"; d.settings.paletteVersion = 1; }
    for (const k of ["groups", "hosts", "keys", "identities", "snippets", "packages", "rules", "knownHosts", "logs"]) {
      if (!Array.isArray(d[k])) d[k] = [];
    }
    App.data = d;
    if (App.screenshotMode && d.hosts.length === 0) App.data = Object.assign(d, App.demoData());
    return d;
  };

  let saveTimer = null;
  App.save = () => {
    if (App.screenshotMode) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const json = JSON.stringify(App.data);
      try { await App.invoke("data_save", { json }); } catch (e) { localStorage.setItem("shellbox", json); }
      App.emit("store-changed", { from: App.windowLabel });
    }, 250);
  };

  App.demoData = () => {
    const g1 = { id: "demo-g1", label: "Production", parentId: null, username: "deploy" };
    const g2 = { id: "demo-g2", label: "Home lab", parentId: null, username: "pi" };
    return {
      groups: [g1, g2],
      hosts: [
        { id: "demo-h1", label: "web-01", address: "203.0.113.10", port: 22, groupId: null, username: "root", tags: ["web"], os: "ubuntu" },
        { id: "demo-h2", label: "database", address: "203.0.113.22", port: 22, groupId: null, username: "admin", tags: [], os: "debian" },
        { id: "demo-h3", label: "backup-server", address: "198.51.100.7", port: 2222, groupId: null, username: "backup", tags: ["backup"], os: "centos" },
        { id: "demo-h4", label: "raspberry", address: "192.168.0.40", port: 22, groupId: null, username: "pi", tags: [], os: "raspbian" },
        { id: "demo-h5", label: "api-02", address: "203.0.113.11", port: 22, groupId: null, username: "root", tags: [], os: "linux" },
      ],
    };
  };

  // ---------- lookups ----------
  App.byId = (list, id) => App.data[list].find((x) => x.id === id);
  App.groupPath = (groupId) => {
    const out = [];
    let g = groupId && App.byId("groups", groupId);
    let guard = 0;
    while (g && guard++ < 20) { out.unshift(g); g = g.parentId && App.byId("groups", g.parentId); }
    return out;
  };

  // Credentials of a host, filling blanks from its identity and parent groups (like the original's inheritance).
  App.resolveHost = (host) => {
    const r = { username: "", password: "", keyId: null, port: host.port || 22 };
    const layers = [...App.groupPath(host.groupId), host];
    for (const l of layers) {
      const ident = l.identityId && App.byId("identities", l.identityId);
      const user = l.username || (ident && ident.username);
      const pass = l.password || (ident && ident.password);
      const key = l.keyId || (ident && ident.keyId);
      if (user) r.username = user;
      if (pass) r.password = pass;
      if (key) r.keyId = key;
      if (l.port && l !== host) r.port = host.port || l.port;
    }
    r.port = host.port || r.port || 22;
    return r;
  };

  App.targetFor = (host, extra = {}) => {
    const c = App.resolveHost(host);
    const key = c.keyId && App.byId("keys", c.keyId);
    const trusted = App.data.knownHosts
      .filter((k) => k.host === host.address && Number(k.port) === Number(c.port))
      .map((k) => k.fingerprint);
    const chain = (host.chain || [])
      .map((id) => App.byId("hosts", id))
      .filter(Boolean)
      .map((h) => App.targetFor(Object.assign({}, h, { chain: [] })));
    return Object.assign(
      {
        host: host.address, port: Number(c.port) || 22, username: c.username, password: c.password,
        key: key ? key.privateKey || "" : "", passphrase: key ? key.passphrase || "" : "",
        trusted, trust_new: false, keepalive: Number(App.data.settings.keepalive) || 0, chain,
        local_keys: App.data.settings.localKeys !== false,
        extra_keys: key || App.data.settings.localKeys === false ? [] : App.data.keys.filter((k) => k.sourcePath && k.privateKey).map((k) => [k.privateKey, k.passphrase || ""]),
      },
      extra
    );
  };

  App.hostLabel = (h) => h.label || h.address || "Host";
  // Errors from the connection layer start with a code (KEY_REFUSED|...); people see only the sentence.
  App.errText = (err) => String(err).replace(/^[A-Z_]+\|/, "");

  // Coloured letter badges stand in for operating system logos.
  const OS = {
    ubuntu: ["#e95420", "U"], debian: ["#c70036", "D"], centos: ["#932279", "C"], fedora: ["#294172", "F"],
    redhat: ["#cc0000", "R"], rhel: ["#cc0000", "R"], arch: ["#1793d1", "A"], alpine: ["#0d597f", "A"],
    raspbian: ["#c51a4a", "R"], freebsd: ["#ab2b28", "B"], macos: ["#555555", "M"], darwin: ["#555555", "M"],
    windows: ["#0078d4", "W"], suse: ["#73ba25", "S"], opensuse: ["#73ba25", "S"], linux: ["#3e4257", "L"],
    amazon: ["#ff9900", "A"], kali: ["#367bf0", "K"], mint: ["#87cf3e", "M"], local: ["#21b568", ">"], serial: ["#6666d2", "S"],
  };
  App.osBadge = (os, fallbackText) => {
    const k = (os || "").toLowerCase();
    const hit = OS[k] || Object.entries(OS).find(([n]) => k.includes(n))?.[1];
    if (hit) return { color: hit[0], text: hit[1] };
    return { color: "var(--dark-grey-6)", text: ((fallbackText || "?").trim()[0] || "?").toUpperCase() };
  };
  // Operating system logos (Simple Icons, CC0) on their brand colour; letters only for unknown systems.
  App.OS_NAMES = {
    ubuntu: "Ubuntu", debian: "Debian", centos: "CentOS", fedora: "Fedora", redhat: "Red Hat", arch: "Arch Linux", alpine: "Alpine",
    raspbian: "Raspberry Pi OS", freebsd: "FreeBSD", openbsd: "OpenBSD", macos: "macOS", opensuse: "openSUSE", suse: "SUSE", linux: "Linux",
    kali: "Kali", mint: "Linux Mint", rocky: "Rocky Linux", alma: "AlmaLinux", gentoo: "Gentoo", manjaro: "Manjaro", nixos: "NixOS",
    elementary: "elementary OS", popos: "Pop!_OS", android: "Android", synology: "Synology", proxmox: "Proxmox", truenas: "TrueNAS",
    docker: "Docker", windows: "Windows",
  };
  const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(n >> 16) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
  };
  App.osLogo = (os) => {
    const k = (os || "").toLowerCase();
    const icons = window.OS_ICONS || {};
    const key = icons[k] ? k : Object.keys(icons).find((n) => k.includes(n));
    if (!key) return null;
    const ic = icons[key];
    let bg = ic.c;
    if (luminance(bg) < 0.02) bg = "#3e4257";
    const fg = luminance(bg) > 0.45 ? "#1d2033" : "#ffffff";
    return { d: ic.d, bg, fg };
  };
  App.avatar = (os, label, cls = "avatar") => {
    const logo = App.osLogo(os);
    if (logo) {
      const size = cls === "avatar" ? 22 : cls === "big-avatar" ? 36 : 13;
      return h("div", { class: cls, style: `background:${logo.bg}`,
        html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${logo.fg}"><path d="${logo.d}"/></svg>` });
    }
    const b = App.osBadge(os, label);
    const el = h("div", { class: cls, style: `background:${b.color}` });
    if (!os) el.innerHTML = Icon("hosts", cls === "avatar" ? 20 : 14);
    else el.textContent = b.text;
    return el;
  };

  // ---------- DOM ----------
  const h = (App.h = window.h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  });
  App.icon = (name, size) => h("span", { class: "ic", html: Icon(name, size) });

  App.escape = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------- overlay: menus and dialogs ----------
  const overlay = () => document.getElementById("overlay");
  let closeHook = null;
  // ---------- motion ----------
  // "system" follows Windows (Settings > Accessibility > Visual effects > Animation effects): when that is off,
  // the UI still fades, just without movement. "on" always animates, "off" never does.
  App.applyMotion = () => {
    const m = (App.data && App.data.settings && App.data.settings.uiMotion) || "system";
    document.body.classList.toggle("motion-on", m === "on");
    document.body.classList.toggle("motion-off", m === "off");
  };
  // How long a leaving element should stay before removal: 0 when animations are off, so nothing lingers.
  App.leaveMs = (ms) => (document.body.classList.contains("motion-off") ? 0 : ms);
  const removeAfter = (el, ms) => { const t = App.leaveMs(ms); if (!t) el.remove(); else { el.classList.add("leaving"); setTimeout(() => el.remove(), t); } };

  // Closing plays a short fade (the original's leaving time, 195 ms) before things are removed.
  const LEAVE_MS = 195;
  let closeSeq = 0;
  App.closeOverlay = () => {
    const o = overlay();
    const seq = ++closeSeq;
    const dimmed = o.classList.contains("dim");
    o.innerHTML = "";
    o.onmousedown = null;
    if (dimmed && App.leaveMs(LEAVE_MS)) {
      o.className = "show dim leaving";
      setTimeout(() => { if (seq === closeSeq && o.classList.contains("leaving")) o.className = ""; }, LEAVE_MS);
    } else o.className = "";
    document.querySelectorAll(".menu:not(.leaving), .dialog:not(.leaving), .palette:not(.leaving)").forEach((m) => {
      removeAfter(m, m.classList.contains("menu") ? 120 : LEAVE_MS);
    });
    if (closeHook) { const f = closeHook; closeHook = null; f(); }
  };

  // items: [{name, icon, handler, danger, disabled, hint, submenu} | "-"]
  const buildMenu = (items, level) => {
    const m = h("div", { class: "menu", "data-level": String(level) });
    for (const it of items) {
      if (!it) continue;
      if (it === "-") { m.append(h("div", { class: "menu-sep" })); continue; }
      const row = h("div", { class: "menu-item" + (it.danger ? " danger" : "") + (it.disabled ? " disabled" : "") },
        it.icon ? App.icon(it.icon, 14) : null, h("span", { style: "flex:1" }, it.name),
        it.hint ? h("span", { style: "color:var(--text-2);font-size:11px;margin-left:20px" }, it.hint) : null,
        it.checked ? h("span", { class: "menu-check", html: Icon("check", 14) }) : null,
        it.submenu ? App.icon("right", 12) : null);
      row.onmouseenter = () => {
        document.querySelectorAll(".menu:not(.leaving)").forEach((x) => { if (Number(x.dataset.level) > level) removeAfter(x, 120); });
        if (!it.submenu) return;
        const sub = buildMenu(it.submenu, level + 1);
        document.body.append(sub);
        const r = row.getBoundingClientRect(), sr = sub.getBoundingClientRect();
        let x = r.right + 2;
        if (x + sr.width > innerWidth - 8) x = r.left - sr.width - 2;
        sub.style.left = x + "px";
        sub.style.top = Math.min(r.top - 5, innerHeight - sr.height - 8) + "px";
        sub.style.transformOrigin = `${x < r.left ? "right" : "left"} top`;
      };
      if (!it.submenu) row.onclick = () => { App.closeOverlay(); it.handler && it.handler(); };
      m.append(row);
    }
    return m;
  };
  App.menu = (anchorOrEvent, items) => {
    App.closeOverlay();
    const o = overlay();
    o.className = "show";
    o.onmousedown = (e) => { if (e.target === o) App.closeOverlay(); };
    const m = buildMenu(items, 0);
    document.body.append(m);
    let x, y;
    if (anchorOrEvent instanceof MouseEvent && anchorOrEvent.type === "contextmenu") { x = anchorOrEvent.clientX; y = anchorOrEvent.clientY; }
    else {
      const el = anchorOrEvent.currentTarget || anchorOrEvent.target || anchorOrEvent;
      const r = el.getBoundingClientRect();
      x = r.left; y = r.bottom + 6;
    }
    const mr = m.getBoundingClientRect();
    const wantX = x, wantY = y;
    x = Math.min(x, innerWidth - mr.width - 8);
    y = Math.min(y, innerHeight - mr.height - 8);
    m.style.left = x + "px"; m.style.top = y + "px";
    m.style.transformOrigin = `${x < wantX ? "right" : "left"} ${y < wantY ? "bottom" : "top"}`;
  };

  App.dialog = ({ title, body, actions, onClose, width }) => {
    App.closeOverlay();
    const o = overlay();
    o.className = "show dim";
    o.onmousedown = (e) => { if (e.target === o) App.closeOverlay(); };
    closeHook = onClose || null;
    const d = h("div", { class: "dialog" }, h("h3", {}, title));
    if (width) d.style.width = width + "px";
    if (typeof body === "string") d.append(h("p", { html: body })); else if (body) d.append(body);
    const acts = h("div", { class: "actions" });
    for (const a of actions || []) {
      const b = h("button", { class: "btn " + (a.kind || "") }, a.name);
      b.onclick = async () => {
        if (a.keepOpen) { await a.handler(); return; }
        closeHook = null;
        App.closeOverlay();
        a.handler && a.handler();
      };
      acts.append(b);
    }
    d.append(acts);
    document.body.append(d);
    const first = d.querySelector("input, textarea, select");
    if (first) setTimeout(() => first.focus(), 30);
    return d;
  };

  App.confirm = (title, text, okName = "Delete", kind = "danger") =>
    new Promise((res) => {
      App.dialog({ title, body: App.escape(text), onClose: () => res(false),
        actions: [{ name: "Cancel", kind: "ghost", handler: () => res(false) }, { name: okName, kind, handler: () => res(true) }] });
    });

  App.prompt = (title, label, value = "", okName = "Save") =>
    new Promise((res) => {
      const inp = h("input", { class: "input", value });
      const body = h("div", {}, h("div", { class: "field" }, h("label", {}, label), inp));
      inp.onkeydown = (e) => { if (e.key === "Enter") { App.closeOverlay(); res(inp.value); } };
      App.dialog({ title, body, onClose: () => res(null),
        actions: [{ name: "Cancel", kind: "ghost", handler: () => res(null) }, { name: okName, kind: "primary", handler: () => res(inp.value) }] });
    });

  App.toast = (text, error = false) => {
    const t = h("div", { class: "toast" + (error ? " error" : "") }, text);
    document.getElementById("toasts").append(t);
    setTimeout(() => removeAfter(t, LEAVE_MS), error ? 6000 : 3000);
  };

  // ---------- right slider ----------
  App.slider = {
    el: () => document.getElementById("slider"),
    onClose: null,
    open(title, body, { menu, foot, onClose } = {}) {
      const s = this.el();
      if (this.onClose) { const f = this.onClose; this.onClose = null; f(); }
      s.innerHTML = "";
      const head = h("div", { class: "slider-head" }, h("h3", {}, title));
      if (menu) {
        const mb = h("button", { class: "icon-btn", title: "More", html: Icon("dots") });
        mb.onclick = (e) => App.menu(e, menu);
        head.append(mb);
      }
      const x = h("button", { class: "icon-btn", title: "Close", html: Icon("close") });
      x.onclick = () => this.close();
      head.append(x);
      s.append(head, h("div", { class: "slider-body" }, body));
      if (foot) s.append(h("div", { class: "slider-foot" }, foot));
      s.classList.add("open");
      document.body.classList.add("with-slider");
      this.onClose = onClose || null;
    },
    close() {
      this.el().classList.remove("open");
      document.body.classList.remove("with-slider");
      if (this.onClose) { const f = this.onClose; this.onClose = null; f(); }
    },
    isOpen() { return this.el().classList.contains("open"); },
  };

  App.formatDate = (secsOrMs) => {
    if (!secsOrMs) return "";
    const d = new Date(secsOrMs > 1e12 ? secsOrMs : secsOrMs * 1000);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + ", " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };
  App.formatSize = (n) => {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
  };

  App.sortItems = (items, labelFn) => {
    const s = App.data.settings.sort;
    const arr = [...items];
    if (s === "za") arr.sort((a, b) => labelFn(b).localeCompare(labelFn(a)));
    else if (s === "newest") arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    else if (s === "oldest") arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    else arr.sort((a, b) => labelFn(a).localeCompare(labelFn(b)));
    return arr;
  };

  App.parseSsh = (text) => {
    // "ssh user@host -p 2222", "user@host:2222", "host"
    let t = (text || "").trim();
    if (!t) return null;
    t = t.replace(/^ssh\s+/, "");
    let port = 22;
    const pm = t.match(/\s-p\s*(\d+)/);
    if (pm) { port = Number(pm[1]); t = t.replace(pm[0], ""); }
    t = t.trim().split(/\s+/)[0];
    let user = "";
    if (t.includes("@")) { [user, t] = [t.slice(0, t.lastIndexOf("@")), t.slice(t.lastIndexOf("@") + 1)]; }
    const cm = t.match(/^([^:\[\]]+):(\d+)$/);
    if (cm) { t = cm[1]; port = Number(cm[2]); }
    if (!t) return null;
    return { username: user, address: t, port };
  };
})();
