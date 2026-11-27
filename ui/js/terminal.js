// Terminal tabs: SSH, local terminal and serial sessions drawn with xterm.js.
(function () {
  const T = (App.terminal = { tabs: [], lastId: null });
  const dec = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  // ---------- settings → xterm ----------
  T.themeByName = (name) => {
    const list = window.THEMES || [];
    const n = (name || "").toLowerCase();
    return list.find((t) => t.name.toLowerCase() === n) || list[0];
  };
  T.xtermTheme = (t) => {
    const p = t.palette;
    const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    const o = { background: t.bg, foreground: t.fg, cursor: t.cursor, cursorAccent: t.bg, selectionBackground: t.sel };
    names.forEach((n, i) => { o[n] = p[i]; o["bright" + n[0].toUpperCase() + n.slice(1)] = p[i + 8]; });
    return o;
  };
  T.fontStack = (f) => `"${f}", "Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace`;
  T.applySettings = (tab) => {
    const s = App.data.settings;
    const host = tab.hostId && App.byId("hosts", tab.hostId);
    const theme = T.themeByName((tab.themeOverride || (host && host.theme) || s.theme));
    tab.theme = theme;
    if (!tab.term) return;
    tab.term.options.theme = T.xtermTheme(theme);
    tab.term.options.fontSize = Math.min(40, Math.max(4, Number(tab.fontSize || s.fontSize) || 14));
    tab.term.options.fontFamily = T.fontStack(s.fontFamily);
    tab.term.options.scrollback = Number(s.scrollback) || 40000;
    tab.term.options.drawBoldTextInBrightColors = !!s.brightBold;
    tab.el.style.background = theme.bg;
    tab.el.querySelector(".term-status").style.background = theme.bg;
    tab.el.querySelector(".term-status").style.color = theme.fg;
    setTimeout(() => T.fit(tab), 0);
  };
  T.applyAll = () => T.tabs.forEach(T.applySettings);

  // ---------- tab lifecycle ----------
  T.isConnected = (hostId) => T.tabs.some((t) => t.hostId === hostId && t.status === "connected");
  T.openTerminals = () => T.tabs.filter((t) => t.status === "connected");
  T.lastTerminal = () => T.tabs.find((t) => t.id === T.lastId && t.status === "connected");

  const newTab = (title, kind, host) => {
    const id = "t" + App.uid();
    const el = h("div", { class: "page term-page hidden" });
    const wrap = h("div", { class: "term-wrap" });
    const hostEl = h("div", { class: "term-host" });
    const status = h("div", { class: "term-status" });
    wrap.append(hostEl, status);
    el.append(wrap);
    document.getElementById("main").append(el);
    const tab = { id, title, kind, hostId: host && !host.quick ? host.id : null, host, el, wrap, hostEl, statusEl: status, status: "connecting", term: null, osBuf: "" };
    T.tabs.push(tab);
    T.makeTerm(tab);
    App.openTab(id);
    return tab;
  };

  T.makeTerm = (tab) => {
    const s = App.data.settings;
    const term = new Terminal({
      allowProposedApi: true, cursorBlink: true, fontSize: s.fontSize, fontFamily: T.fontStack(s.fontFamily),
      scrollback: Number(s.scrollback) || 40000, macOptionIsMeta: true, rightClickSelectsWord: false,
    });
    const fit = new FitAddon.FitAddon();
    const search = new SearchAddon.SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(tab.hostEl);
    tab.term = term; tab.fitAddon = fit; tab.search = search;
    term.onData((d) => { if (tab.status === "connected") App.invoke("term_write", { id: tab.id, data: d }).catch(() => {}); });
    term.onResize(({ cols, rows }) => { if (tab.status === "connected") App.invoke("term_resize", { id: tab.id, cols, rows }).catch(() => {}); });
    term.onBell(() => { if (App.data.settings.bell) T.beep(); });
    term.onSelectionChange(() => {
      if (App.data.settings.copyOnSelect && term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    });
    tab.hostEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (App.data.settings.rightClickPaste) { T.paste(tab); return; }
      App.menu(e, [
        { name: "Copy", icon: "copy", disabled: !term.hasSelection(), handler: () => navigator.clipboard.writeText(term.getSelection()) },
        { name: "Paste", icon: "copy", handler: () => T.paste(tab) },
        { name: "Select all", handler: () => term.selectAll() },
        { name: "Clear", handler: () => term.clear() },
        "-",
        { name: "Find", icon: "search", handler: () => T.openSearch(tab) },
        { name: "Show side panel", icon: "side", handler: () => T.toggleSide(tab) },
      ]);
    });
    new ResizeObserver(() => T.fit(tab)).observe(tab.wrap);
    T.applySettings(tab);
  };

  T.fit = (tab) => {
    if (!tab.term || tab.el.classList.contains("hidden")) return;
    try { tab.fitAddon.fit(); } catch (e) { /* not visible yet */ }
  };

  T.beep = () => {
    try {
      const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.12);
    } catch (e) { /* no audio */ }
  };

  T.paste = async (tab) => {
    try { const text = await navigator.clipboard.readText(); if (text) tab.term.paste(text); } catch (e) { App.toast("Clipboard is not available", true); }
  };

  T.close = (id) => {
    const tab = T.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.closing = true;
    App.invoke("term_close", { id }).catch(() => {});
    if (tab.logId) App.logs.finish(tab.logId, "Closed");
    tab.term && tab.term.dispose();
    tab.el.remove();
    T.tabs = T.tabs.filter((t) => t.id !== id);
  };

  // ---------- status screen (connecting / errors / questions) ----------
  const statusView = (tab, { title, sub, lines = [], busy, actions = [], form }) => {
    const s = tab.statusEl;
    s.classList.remove("hidden");
    s.innerHTML = "";
    const host = tab.host;
    s.append(App.avatar(host ? host.os : tab.kind === "local" ? "local" : tab.kind === "serial" ? "serial" : null, tab.title, "big-avatar"));
    s.append(h("h2", {}, title), sub ? h("div", { class: "sub" }, sub) : null);
    if (busy) s.append(h("div", { class: "progress" }, h("div")));
    if (lines.length) s.append(h("div", { class: "status-log" }, ...lines.map((l) => h("div", { class: l.cls || "" }, l.text))));
    if (form) s.append(form);
    if (actions.length) {
      const row = h("div", { class: "actions" });
      for (const a of actions) { const b = h("button", { class: "btn " + (a.kind || "") }, a.name); b.onclick = a.handler; row.append(b); }
      s.append(row);
    }
  };
  const hideStatus = (tab) => tab.statusEl.classList.add("hidden");

  // ---------- answering questions while connecting ----------
  T.askHostKey = (info, tab) =>
    new Promise((res) => {
      const [tag, fp, type, where] = info;
      const changed = tag === "HOSTKEY_CHANGED";
      const text = changed
        ? `WARNING: the key of ${where} has changed. Someone could be intercepting the connection, or the server was reinstalled.`
        : `The authenticity of ${where} can't be established. Are you sure you want to continue connecting?`;
      const actions = [
        { name: "Close", kind: "ghost", handler: () => res(null) },
        { name: "Continue", kind: "", handler: () => res("once") },
        { name: changed ? "Replace and continue" : "Add and continue", kind: changed ? "danger" : "green", handler: () => res("add") },
      ];
      if (tab) {
        statusView(tab, { title: changed ? "Host key changed" : "Unknown host", sub: text,
          lines: [{ text: `${type} fingerprint is ${fp}` }], actions });
      } else {
        App.dialog({ title: changed ? "Host key changed" : "Unknown host",
          body: h("div", {}, h("p", {}, text), h("p", { class: "mono" }, `${type} ${fp}`)), onClose: () => res(null),
          actions: actions.map((a) => Object.assign({}, a)) });
      }
    });

  T.askCredentials = (host, target, message, tab) =>
    new Promise((res) => {
      const vals = { username: target.username || "", password: "", save: true };
      const user = h("input", { class: "input", placeholder: "Username", value: vals.username });
      const pass = h("input", { class: "input", placeholder: "Password", type: "password" });
      const saveCb = h("input", { type: "checkbox", checked: true });
      const form = h("div", { class: "inline-form" }, user, pass,
        host && !host.quick ? h("label", { class: "hint", style: "display:flex;gap:6px;align-items:center" }, saveCb, "Save to host") : null);
      const done = (ok) => res(ok ? { username: user.value.trim(), password: pass.value, save: saveCb.checked } : null);
      // A handler that returns false throws the keystroke away, so this one returns nothing.
      [user, pass].forEach((i) => (i.onkeydown = (e) => { if (e.key === "Enter") done(true); }));
      if (tab) {
        statusView(tab, { title: "Authentication required", sub: message, form,
          actions: [{ name: "Close", kind: "ghost", handler: () => done(false) }, { name: "Continue", kind: "green", handler: () => done(true) }] });
        setTimeout(() => (vals.username ? pass : user).focus(), 30);
      } else {
        App.dialog({ title: "Authentication required", body: h("div", {}, h("p", {}, message), form), onClose: () => done(false),
          actions: [{ name: "Cancel", kind: "ghost", handler: () => done(false) }, { name: "Continue", kind: "green", handler: () => done(true) }] });
      }
    });

  // Check pictures only: a terminal tab waiting for a password, like a host whose login failed.
  T.demoAuthPrompt = () => {
    const tab = newTab("ubuntu EC2", "ssh", { id: "demo-auth", label: "ubuntu EC2", quick: true });
    T.askCredentials(tab.host, { username: "ubuntu" }, "Wrong username or password", tab).then((c) => { window.__authResult = c; });
  };

  // A key locked with a passphrase: asks for it (not the account password) and can keep it with the key.
  T.askPassphrase = (key, message, tab) =>
    new Promise((res) => {
      const pass = h("input", { class: "input", placeholder: "Key passphrase", type: "password" });
      const saveCb = h("input", { type: "checkbox", checked: true });
      const form = h("div", { class: "inline-form" }, pass,
        key ? h("label", { class: "hint", style: "display:flex;gap:6px;align-items:center" }, saveCb, `Save to key "${key.label || "Key"}"`) : null);
      const done = (ok) => res(ok ? { passphrase: pass.value, save: saveCb.checked } : null);
      pass.onkeydown = (e) => { if (e.key === "Enter") done(true); };
      if (tab) {
        statusView(tab, { title: "Key passphrase", sub: message, form,
          actions: [{ name: "Close", kind: "ghost", handler: () => done(false) }, { name: "Continue", kind: "green", handler: () => done(true) }] });
        setTimeout(() => pass.focus(), 30);
      } else {
        App.dialog({ title: "Key passphrase", body: h("div", {}, h("p", {}, message), form), onClose: () => done(false),
          actions: [{ name: "Cancel", kind: "ghost", handler: () => done(false) }, { name: "Continue", kind: "green", handler: () => done(true) }] });
      }
    });

  // Shared by SSH tabs, SFTP and port forwarding. Calls retry(newTarget) when it can be fixed.
  T.handleConnectError = async (err, host, target, retry, tab) => {
    const parts = err.split("|");
    if (parts[0] === "HOSTKEY_UNKNOWN" || parts[0] === "HOSTKEY_CHANGED") {
      const answer = await T.askHostKey(parts, tab);
      if (!answer) return "cancelled";
      if (answer === "add") {
        const [h0, p0] = parts[3].split(/:(?=\d+$)/);
        App.known.add(h0, Number(p0), parts[1], parts[2]);
      }
      await retry(Object.assign({}, target, { trust_new: true, trusted: [parts[1]] }));
      return "handled";
    }
    if (parts[0] === "KEY_PASSPHRASE") {
      const keyId = host && !host.quick ? App.resolveHost(host).keyId : null;
      const key = keyId && App.byId("keys", keyId);
      const c = await T.askPassphrase(key, parts[1], tab);
      if (!c) return "cancelled";
      if (c.save && key) { key.passphrase = c.passphrase; App.save(); }
      await retry(Object.assign({}, target, { passphrase: c.passphrase }));
      return "handled";
    }
    if (parts[0] === "AUTH_NEEDED" || parts[0] === "AUTH_FAILED") {
      const c = await T.askCredentials(host, target, parts[1] || "Enter your credentials", tab);
      if (!c) return "cancelled";
      if (c.save && host && !host.quick && App.byId("hosts", host.id)) {
        host.username = c.username; host.password = c.password; App.save(); App.refreshSoft();
      }
      await retry(Object.assign({}, target, { username: c.username, password: c.password }));
      return "handled";
    }
    return false;
  };

  // ---------- SSH ----------
  T.connectHost = (host, opts = {}) => {
    const tab = newTab(opts.title || App.hostLabel(host), "ssh", host);
    tab.startup = opts.startup || null;
    T.startSsh(tab, App.targetFor(host));
    if (!host.quick) { host.lastUsed = Date.now(); App.save(); }
    return tab;
  };

  T.startSsh = async (tab, target) => {
    const host = tab.host;
    tab.status = "connecting";
    tab.lastTarget = target;
    App.drawTabs();
    statusView(tab, { title: tab.title, sub: `${target.username ? target.username + "@" : ""}${target.host}`, busy: true,
      lines: [{ text: `Connecting to ${target.host} port ${target.port}...` }, ...(target.chain || []).map((c) => ({ text: `via ${c.host}:${c.port}` }))],
      actions: [{ name: "Cancel", kind: "ghost", handler: () => App.closeTab(tab.id) }] });
    T.fit(tab);
    const env = ((host && host.env) || []).filter((p) => p.k).map((p) => [p.k, p.v || ""]);
    try {
      await App.invoke("term_open_ssh", { id: tab.id, target, cols: tab.term.cols, rows: tab.term.rows, termType: App.data.settings.termType, env });
      if (tab.closing) { App.invoke("term_close", { id: tab.id }); return; }
      tab.status = "connected";
      tab.reconnects = 0;
      hideStatus(tab);
      App.drawTabs();
      tab.term.focus();
      App.invoke("term_resize", { id: tab.id, cols: tab.term.cols, rows: tab.term.rows }).catch(() => {});
      tab.logId = App.logs.add({ hostId: tab.hostId, label: tab.title, address: target.host, user: target.username, kind: "SSH", status: "Connected" })?.id;
      const snippet = host && host.startupSnippetId && App.byId("snippets", host.startupSnippetId);
      const script = tab.startup || (snippet && snippet.script);
      if (script) setTimeout(() => T.sendTo(tab.id, script, true), 600);
    } catch (e) {
      if (tab.closing) return;
      const err = String(e);
      const r = await T.handleConnectError(err, host, target, (t2) => T.startSsh(tab, t2), tab);
      if (r === "cancelled") { App.closeTab(tab.id); return; }
      if (r) return;
      tab.status = "error";
      App.drawTabs();
      statusView(tab, { title: "Connection failed", sub: tab.title, lines: [{ text: App.errText(err), cls: "bad" }],
        actions: [
          { name: "Close", kind: "ghost", handler: () => App.closeTab(tab.id) },
          ...(host && !host.quick && App.byId("hosts", host.id) ? [{ name: "Edit host", kind: "", handler: () => { App.openVaultPage("hosts"); App.hosts.editHost(host); } }] : []),
          { name: "Retry", kind: "green", handler: () => T.startSsh(tab, App.byId("hosts", tab.hostId) ? App.targetFor(App.byId("hosts", tab.hostId)) : target) },
        ] });
    }
  };

  // ---------- local terminal and serial ----------
  T.openLocal = async () => {
    const tab = newTab("Local Terminal", "local", { os: "local", quick: true, label: "Local Terminal" });
    statusView(tab, { title: "Local Terminal", busy: true });
    T.fit(tab);
    try {
      await App.invoke("term_open_local", { id: tab.id, shell: App.data.settings.localShell || "", cols: tab.term.cols, rows: tab.term.rows });
      tab.status = "connected"; hideStatus(tab); App.drawTabs(); tab.term.focus();
      tab.logId = App.logs.add({ label: "Local Terminal", kind: "Local terminal", status: "Opened" })?.id;
    } catch (e) {
      tab.status = "error"; App.drawTabs();
      statusView(tab, { title: "Could not start the local terminal", lines: [{ text: String(e), cls: "bad" }],
        actions: [{ name: "Close", kind: "ghost", handler: () => App.closeTab(tab.id) }] });
    }
  };

  T.serialDialog = async () => {
    let ports = [];
    try { ports = await App.invoke("serial_ports"); } catch (e) { /* none */ }
    const o = { path: ports[0] || "", baud: 9600 };
    const pathSel = ports.length
      ? App.forms.select(o, "path", ports.map((p) => ({ value: p, label: p })))
      : App.forms.input(o, "path", { placeholder: "COM3 or /dev/ttyUSB0" });
    const baudSel = App.forms.select(o, "baud", [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => ({ value: b, label: String(b) })));
    App.dialog({ title: "Serial", body: h("div", {}, App.forms.field("Port", pathSel), App.forms.field("Baud rate", baudSel),
      ports.length ? null : h("p", {}, "No serial ports were found on this computer.")),
      actions: [{ name: "Cancel", kind: "ghost" }, { name: "Connect", kind: "green", handler: () => T.openSerial(o.path, Number(o.baud)) }] });
  };

  T.openSerial = async (path, baud) => {
    if (!path) return;
    const tab = newTab(`${path} (${baud})`, "serial", { os: "serial", quick: true, label: path });
    try {
      await App.invoke("term_open_serial", { id: tab.id, path, baud });
      tab.status = "connected"; hideStatus(tab); App.drawTabs(); tab.term.focus();
      tab.logId = App.logs.add({ label: path, kind: "Serial", status: "Opened" })?.id;
    } catch (e) {
      tab.status = "error"; App.drawTabs();
      statusView(tab, { title: "Could not open the serial port", lines: [{ text: String(e), cls: "bad" }],
        actions: [{ name: "Close", kind: "ghost", handler: () => App.closeTab(tab.id) }] });
    }
  };

  // ---------- sending text ----------
  T.sendTo = (id, script, run) => {
    const tab = T.tabs.find((t) => t.id === id);
    if (!tab || tab.status !== "connected") return;
    let text = script.replace(/\r?\n/g, "\r");
    if (run && !text.endsWith("\r")) text += "\r";
    App.invoke("term_write", { id, data: text }).catch(() => {});
  };
  T.sendToLast = (script, run) => { const t = T.lastTerminal(); if (t) { T.sendTo(t.id, script, run); App.openTab(t.id); } };

  // ---------- events from the Rust side ----------
  const osWords = [["ubuntu", "ubuntu"], ["debian", "debian"], ["centos", "centos"], ["fedora", "fedora"], ["red hat", "redhat"], ["raspbian", "raspbian"],
    ["raspberry", "raspbian"], ["alpine", "alpine"], ["arch linux", "arch"], ["freebsd", "freebsd"], ["openbsd", "openbsd"], ["opensuse", "opensuse"],
    ["rocky linux", "rocky"], ["almalinux", "alma"], ["gentoo", "gentoo"], ["manjaro", "manjaro"], ["nixos", "nixos"], ["pop!_os", "popos"],
    ["elementary os", "elementary"], ["proxmox", "proxmox"], ["synology", "synology"], ["truenas", "truenas"], ["kali", "kali"],
    ["linux mint", "mint"], ["darwin", "macos"], ["microsoft windows", "windows"]];
  T.init = () => {
    App.listen("term-data", ({ id, data }) => {
      const tab = T.tabs.find((t) => t.id === id);
      if (!tab) return;
      const bytes = dec(data);
      tab.term.write(bytes);
      // Guess the operating system from the login banner (shown as the host's badge).
      const known = tab.hostId && App.byId("hosts", tab.hostId);
      if (tab.kind === "ssh" && tab.osBuf.length < 6000 && known && !known.osManual) {
        tab.osBuf += new TextDecoder().decode(bytes).toLowerCase();
        const host = App.byId("hosts", tab.hostId);
        const hit = osWords.find(([w]) => tab.osBuf.includes(w));
        if (host && hit && host.os !== hit[1]) { host.os = hit[1]; App.save(); App.drawTabs(); }
        else if (host && !host.os && tab.osBuf.includes("linux")) { host.os = "linux"; App.save(); }
      }
    });
    App.listen("term-exit", ({ id, reason }) => {
      const tab = T.tabs.find((t) => t.id === id);
      if (!tab || tab.closing) return;
      const wasConnected = tab.status === "connected";
      tab.status = "closed";
      if (tab.logId) App.logs.finish(tab.logId, reason);
      App.drawTabs();
      const lost = /lost|closed/i.test(reason) && !/exited/i.test(reason);
      if (tab.kind === "ssh" && wasConnected && lost && App.data.settings.autoReconnect && (tab.reconnects || 0) < 3) {
        tab.reconnects = (tab.reconnects || 0) + 1;
        tab.term.write(`\r\n\x1b[33m${reason}. Reconnecting...\x1b[0m\r\n`);
        setTimeout(() => T.startSsh(tab, tab.lastTarget), 2000);
        return;
      }
      tab.term.write(`\r\n\x1b[90m${reason}.\x1b[0m\r\n`);
      const acts = [{ name: "Close", kind: "ghost", handler: () => App.closeTab(tab.id) }];
      if (tab.kind === "ssh") acts.push({ name: "Reconnect", kind: "green", handler: () => T.startSsh(tab, tab.lastTarget) });
      if (tab.kind === "local") acts.push({ name: "Start again", kind: "green", handler: async () => { App.closeTab(tab.id); T.openLocal(); } });
      statusView(tab, { title: "Disconnected", sub: reason, actions: acts });
    });
  };

  // ---------- find and side panel ----------
  T.openSearch = (tab) => {
    if (tab.el.querySelector(".search-pop")) { tab.el.querySelector(".search-pop input").focus(); return; }
    const inp = h("input", { class: "input", placeholder: "Find", style: "width:200px;height:28px" });
    const next = h("button", { class: "icon-btn", html: Icon("chevron", 14), title: "Next" });
    const prev = h("button", { class: "icon-btn", html: Icon("up", 14), title: "Previous" });
    const x = h("button", { class: "icon-btn", html: Icon("close", 14) });
    const pop = h("div", { class: "search-pop" }, inp, prev, next, x);
    inp.onkeydown = (e) => { if (e.key === "Enter") (e.shiftKey ? tab.search.findPrevious(inp.value) : tab.search.findNext(inp.value)); if (e.key === "Escape") x.click(); };
    next.onclick = () => tab.search.findNext(inp.value);
    prev.onclick = () => tab.search.findPrevious(inp.value);
    x.onclick = () => { pop.remove(); tab.term.focus(); };
    tab.wrap.append(pop);
    inp.focus();
  };

  T.toggleSide = (tab, which) => {
    const old = tab.el.querySelector(".term-side");
    if (old && !which) { old.remove(); setTimeout(() => T.fit(tab), 0); tab.term.focus(); return; }
    if (old) old.remove();
    const side = h("div", { class: "term-side" });
    const tabs = h("div", { class: "side-tabs" });
    const body = h("div", { class: "side-body" });
    const pick = (name) => {
      tabs.querySelectorAll(".btn").forEach((b) => b.classList.toggle("primary", b.dataset.n === name));
      body.innerHTML = "";
      if (name === "snippets") {
        if (!App.data.snippets.length) body.append(h("div", { class: "hint" }, "No snippets yet. Add them in the Snippets screen."));
        for (const s of App.data.snippets) {
          const it = h("div", { class: "side-item" }, h("div", { class: "t" }, s.label || "Snippet"), h("div", { class: "s" }, (s.script || "").split("\n")[0]));
          it.onclick = () => { T.sendTo(tab.id, s.script || "", false); tab.term.focus(); };
          it.ondblclick = () => { T.sendTo(tab.id, "\r", false); };
          it.title = "Click to paste, then press Enter in the terminal to run";
          const run = h("button", { class: "btn green lower", style: "height:24px;margin-top:6px" }, "Run");
          run.onclick = (e) => { e.stopPropagation(); T.sendTo(tab.id, s.script || "", true); tab.term.focus(); };
          it.append(run);
          body.append(it);
        }
      } else {
        const size = h("div", { class: "stepper", style: "margin-bottom:10px" });
        const val = h("input", { class: "input", value: tab.fontSize || App.data.settings.fontSize });
        const minus = h("button", { class: "icon-btn", html: Icon("min", 14) });
        const plus = h("button", { class: "icon-btn", html: Icon("plus", 14) });
        const setSize = (n) => { tab.fontSize = Math.min(40, Math.max(4, n)); val.value = tab.fontSize; T.applySettings(tab); };
        minus.onclick = () => setSize((tab.fontSize || App.data.settings.fontSize) - 1);
        plus.onclick = () => setSize((tab.fontSize || App.data.settings.fontSize) + 1);
        val.onchange = () => setSize(Number(val.value) || 14);
        size.append(h("span", { style: "flex:1" }, "Text Size"), minus, val, plus);
        body.append(size);
        const list = h("div", { class: "theme-swatch" });
        for (const t of window.THEMES || []) list.append(T.swatch(t, tab.theme && tab.theme.name === t.name, () => { tab.themeOverride = t.name; T.applySettings(tab); pick("themes"); }));
        body.append(list);
      }
    };
    for (const [n, label] of [["snippets", "Snippets"], ["themes", "Themes"]]) {
      const b = h("button", { class: "btn lower", "data-n": n }, label);
      b.onclick = () => pick(n);
      tabs.append(b);
    }
    const x = h("button", { class: "icon-btn", html: Icon("close", 14), style: "margin-left:auto" });
    x.onclick = () => T.toggleSide(tab);
    tabs.append(x);
    side.append(tabs, body);
    tab.el.append(side);
    pick(which || "snippets");
    setTimeout(() => T.fit(tab), 0);
  };

  T.swatch = (t, selected, onClick) => {
    const sw = h("div", { class: "swatch" + (selected ? " sel" : ""), style: `background:${t.bg};color:${t.fg}` },
      h("div", {}, t.name), h("div", { class: "bars" }, ...t.palette.slice(1, 8).map((c) => h("span", { style: `background:${c}` }))));
    sw.onclick = onClick;
    return sw;
  };
})();
