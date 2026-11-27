// Starts the app: top tabs, vault side menu, pages, keyboard shortcuts and the settings window.
(function () {
  // Side menu order read from the original: Hosts, Keychain, Port Forwarding, Snippets, Known Hosts, Logs,
  // with Servers (live numbers) and Containers (Docker / Easypanel), added at the person's request, right after Hosts.
  const VAULT_PAGES = [
    ["hosts", "Hosts", "hosts", () => App.hosts],
    ["servers", "Servers", "pulse", () => App.servers],
    ["containers", "Containers", "box", () => App.containers],
    ["databases", "Databases", "database", () => App.databases],
    ["keychain", "Keychain", "keychain", () => App.keychain],
    ["forwarding", "Port Forwarding", "forward", () => App.forwarding],
    ["snippets", "Snippets", "snippets", () => App.snippets],
    ["known", "Known Hosts", "known", () => App.known],
    ["logs", "Logs", "logs", () => App.logs],
  ];
  App.current = "vaults";
  App.vaultPage = "hosts";
  const pages = {};

  const page = (id) => {
    if (!pages[id]) { pages[id] = h("div", { class: "page hidden" }); document.getElementById("main").append(pages[id]); }
    return pages[id];
  };

  App.applyUiTheme = () => {
    document.body.classList.toggle("light", App.data.settings.uiTheme === "light");
    document.body.classList.toggle("dark", App.data.settings.uiTheme !== "light");
    App.applyMotion();
  };

  // ---------- top tabs ----------
  const seenTabs = new Set();
  App.drawTabs = () => {
    const bar = document.getElementById("tabs");
    bar.innerHTML = "";
    // Vaults: logo, name and sync state, joined to a small arrow that opens the vault menu (as in the original).
    const vaultTab = h("button", { class: "tab" + (App.current === "vaults" ? " active" : "") },
      h("span", { class: "tab-ico", html: Icon("vaultFill", 18) }), h("span", { class: "tab-title" }, "Vaults"),
      h("span", { class: "tab-sync", title: "Stored on this computer only", html: Icon("cloud", 16) }));
    vaultTab.onclick = () => App.openTab("vaults");
    const vaultChev = h("button", { class: "tab tab-chev" + (App.current === "vaults" ? " active" : ""), title: "Vault", html: Icon("chevron", 16) });
    vaultChev.onclick = (e) => App.menu(e, [
      ...VAULT_PAGES.map(([id, label, icon]) => ({ name: label, icon, handler: () => App.openVaultPage(id) })),
      "-",
      { name: "Settings", icon: "gear", hint: "Ctrl+,", handler: () => App.openSettings() },
    ]);
    bar.append(h("div", { class: "tab-split" }, vaultTab, vaultChev));
    const sftp = h("button", { class: "tab" + (App.current === "sftp" ? " active" : "") },
      h("span", { class: "tab-ico", html: Icon("folderFill", 16) }), h("span", { class: "tab-title" }, "SFTP"));
    sftp.onclick = () => App.openTab("sftp");
    bar.append(sftp);
    if (App.terminal.tabs.length) bar.append(h("div", { class: "tab-sep" }));
    for (const t of App.terminal.tabs) {
      const dotCls = t.status === "connected" ? "" : t.status === "connecting" ? " wait" : t.status === "error" ? " err" : " off";
      const x = h("span", { class: "tab-close", title: "Close", html: Icon("close", 12) });
      x.onclick = (e) => { e.stopPropagation(); App.closeTab(t.id); };
      const fresh = !seenTabs.has(t.id);
      seenTabs.add(t.id);
      const b = h("button", { class: "tab" + (App.current === t.id ? " active" : "") + (fresh ? " entering" : ""), title: t.title, "data-tab": t.id }, h("span", { class: "dot" + dotCls }), h("span", { class: "tab-title" }, t.title), x);
      b.onclick = () => App.openTab(t.id);
      b.onauxclick = (e) => { if (e.button === 1) App.closeTab(t.id); };
      b.oncontextmenu = (e) => { e.preventDefault(); App.menu(e, [
        { name: "Rename", icon: "edit", handler: async () => { const v = await App.prompt("Tab Title", "Title", t.title); if (v) { t.title = v; App.drawTabs(); } } },
        { name: "Duplicate", icon: "copy", disabled: t.kind !== "ssh" || !t.host, handler: () => App.terminal.connectHost(t.host) },
        { name: "Reconnect", icon: "refresh", disabled: t.kind !== "ssh", handler: () => { App.invoke("term_close", { id: t.id }); setTimeout(() => App.terminal.startSsh(t, t.lastTarget), 300); } },
        "-",
        { name: "Close", icon: "close", handler: () => App.closeTab(t.id) },
        { name: "Close other tabs", handler: () => App.terminal.tabs.filter((o) => o.id !== t.id).forEach((o) => App.closeTab(o.id)) },
      ]); };
      bar.append(b);
    }
    const plus = h("button", { class: "tab tab-new", title: "New tab (Ctrl+T)", html: Icon("plus", 16) });
    plus.onclick = () => App.palette("newTab");
    bar.append(plus);
  };

  // ---------- side menu ----------
  const drawSidebar = () => {
    const nav = document.getElementById("sidebar");
    nav.innerHTML = "";
    for (const [id, label, icon] of VAULT_PAGES) {
      const b = h("button", { class: "nav-item" + (App.vaultPage === id ? " selected" : ""), title: label },
        h("span", { class: "nav-icon", html: Icon(icon, 16) }), h("span", { class: "nav-title" }, label));
      b.onclick = () => App.openVaultPage(id);
      nav.append(b);
    }
    nav.append(h("div", { class: "nav-spacer" }),
      h("div", { class: "nav-footer" }, h("div", { class: "free-badge" }, "Free"), h("div", {}, "All features unlocked. Your data stays on this computer.")));
  };

  App.openVaultPage = (id) => {
    if (App.slider.isOpen()) App.slider.close();
    App.vaultPage = id;
    App.openTab("vaults");
  };

  App.openTab = (id) => {
    App.current = id;
    App.closeOverlay();
    if (id !== "vaults" && App.slider.isOpen()) App.slider.close();
    document.querySelectorAll("#main > .page").forEach((p) => p.classList.add("hidden"));
    document.getElementById("sidebar").classList.toggle("closed", id !== "vaults");
    if (id === "vaults") {
      drawSidebar();
      const p = page(App.vaultPage);
      p.classList.remove("hidden");
      VAULT_PAGES.find((v) => v[0] === App.vaultPage)[3]().render(p);
    } else if (id === "sftp") {
      const p = page("sftp");
      p.classList.remove("hidden");
      App.sftp.render(p);
    } else {
      const t = App.terminal.tabs.find((x) => x.id === id);
      if (t) {
        t.el.classList.remove("hidden");
        App.terminal.lastId = id;
        setTimeout(() => { App.terminal.fit(t); t.term && t.term.focus(); }, 0);
      }
    }
    App.drawTabs();
  };

  // The tab shrinks out of the top bar first (150 ms), then the terminal is closed.
  const closingTabs = new Set();
  App.closeTab = (id) => {
    if (closingTabs.has(id)) return;
    const btn = document.querySelector(`#tabs .tab[data-tab="${CSS.escape(String(id))}"]`);
    const ms = App.leaveMs(150);
    if (!btn || !ms) return closeTabNow(id);
    closingTabs.add(id);
    btn.classList.remove("entering");
    btn.classList.add("leaving");
    setTimeout(() => { closingTabs.delete(id); closeTabNow(id); }, ms);
  };
  const closeTabNow = (id) => {
    const idx = App.terminal.tabs.findIndex((t) => t.id === id);
    App.terminal.close(id);
    if (App.current === id) {
      const next = App.terminal.tabs[idx] || App.terminal.tabs[idx - 1];
      App.openTab(next ? next.id : "vaults");
    } else App.drawTabs();
  };

  App.refresh = () => { if (App.current === "vaults") { const p = page(App.vaultPage); VAULT_PAGES.find((v) => v[0] === App.vaultPage)[3]().render(p); drawSidebar(); } };
  App.refreshSoft = () => {
    if (App.current !== "vaults") return;
    const active = document.activeElement;
    const inSlider = active && App.slider.el().contains(active);
    App.refresh();
    if (inSlider) active.focus();
  };

  App.sortMenu = (e, done) => {
    const set = (v) => { App.data.settings.sort = v; App.save(); done(); };
    const cur = App.data.settings.sort;
    const mark = (v) => (cur === v ? "check" : null);
    App.menu(e, [
      { name: "A-z", icon: mark("az"), handler: () => set("az") },
      { name: "Z-a", icon: mark("za"), handler: () => set("za") },
      { name: "Newest to oldest", icon: mark("newest"), handler: () => set("newest") },
      { name: "Oldest to newest", icon: mark("oldest"), handler: () => set("oldest") },
    ]);
  };

  App.openSettings = (section) => App.invoke("open_settings", { section: section || null }).catch((e) => App.toast(String(e), true));

  // ---------- keyboard shortcuts (the original's PC preset) ----------
  const currentTerm = () => App.terminal.tabs.find((t) => t.id === App.current);
  const allTabs = () => ["vaults", "sftp", ...App.terminal.tabs.map((t) => t.id)];
  const onKey = (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const combo = (ctrl ? "ctrl+" : "") + (e.altKey ? "alt+" : "") + (e.shiftKey ? "shift+" : "") + k;
    const t = currentTerm();
    const acts = {
      "ctrl+shift+c": () => t && t.term.hasSelection() && navigator.clipboard.writeText(t.term.getSelection()),
      "ctrl+shift+v": () => t && App.terminal.paste(t),
      "ctrl+shift+a": () => t && t.term.selectAll(),
      "ctrl+.": () => t && App.terminal.toggleSide(t),
      "ctrl+l": () => App.terminal.openLocal(),
      "ctrl+alt+s": () => App.terminal.serialDialog(),
      "ctrl+shift+f": () => t && App.terminal.openSearch(t),
      "ctrl+shift+w": () => t && App.closeTab(t.id),
      "ctrl+shift+s": () => App.openVaultPage("snippets"),
      "ctrl+p": () => App.openVaultPage("forwarding"),
      "ctrl+k": () => App.palette("commands"),
      "ctrl+j": () => App.palette("jump"),
      "ctrl+t": () => App.palette("newTab"),
      "ctrl+,": () => App.openSettings(),
      "ctrl+=": () => fontStep(1),
      "ctrl++": () => fontStep(1),
      "ctrl+-": () => fontStep(-1),
      "ctrl+0": () => fontStep(0),
      "F11": async () => { const w = App.win(); if (w) w.setFullscreen(!(await w.isFullscreen())); },
      "alt+ArrowRight": () => { const a = allTabs(); App.openTab(a[(a.indexOf(App.current) + 1) % a.length]); },
      "alt+ArrowLeft": () => { const a = allTabs(); App.openTab(a[(a.indexOf(App.current) - 1 + a.length) % a.length]); },
    };
    if (ctrl && !e.shiftKey && !e.altKey && /^[1-9]$/.test(k)) {
      const n = Number(k), terms = App.terminal.tabs;
      e.preventDefault(); e.stopPropagation();
      if (n === 1) App.openTab("vaults");
      else if (n === 2) App.openTab("sftp");
      else if (terms.length) App.openTab(n === 9 ? terms[terms.length - 1].id : terms[Math.min(Math.max(n - 2, 1), terms.length) - 1].id);
      return;
    }
    if (acts[combo]) { e.preventDefault(); e.stopPropagation(); acts[combo](); return; }
    if (e.key === "Escape" && !t) {
      if (document.querySelector(".menu, .dialog, .palette")) App.closeOverlay();
      else if (App.slider.isOpen()) App.slider.close();
    }
  };

  // ---------- window buttons ----------
  // The original's Windows menu (hamburger button left of minimize): Vaults, SFTP, Settings, then
  // File, Edit, View, Window and Help.
  const fontStep = (d) => {
    const t = currentTerm();
    if (!t) return;
    t.fontSize = d === 0 ? App.data.settings.fontSize : Math.min(40, Math.max(4, (t.fontSize || App.data.settings.fontSize) + d));
    App.terminal.applySettings(t);
  };
  App.appMenu = (e) => {
    const t = currentTerm();
    App.menu(e, [
      { name: "Vaults", hint: "Ctrl+1", handler: () => App.openTab("vaults") },
      { name: "SFTP", hint: "Ctrl+2", handler: () => App.openTab("sftp") },
      { name: "Settings", hint: "Ctrl+,", handler: () => App.openSettings() },
      "-",
      { name: "File", submenu: [
        { name: "New Local Terminal", hint: "Ctrl+L", handler: () => App.terminal.openLocal() },
        { name: "New Serial Connection", hint: "Ctrl+Alt+S", handler: () => App.terminal.serialDialog() },
      ] },
      { name: "Edit", submenu: [
        { name: "Copy", hint: "Ctrl+Shift+C", disabled: !t, handler: () => t && t.term.hasSelection() && navigator.clipboard.writeText(t.term.getSelection()) },
        { name: "Paste", hint: "Ctrl+Shift+V", disabled: !t, handler: () => t && App.terminal.paste(t) },
        { name: "Select All", hint: "Ctrl+Shift+A", disabled: !t, handler: () => t && t.term.selectAll() },
        { name: "Find", hint: "Ctrl+Shift+F", disabled: !t, handler: () => t && App.terminal.openSearch(t) },
      ] },
      { name: "View", submenu: [
        { name: "Toggle Full Screen", hint: "F11", handler: async () => { const w = App.win(); if (w) w.setFullscreen(!(await w.isFullscreen())); } },
        { name: "Show terminal side-panel", hint: "Ctrl+.", disabled: !t, handler: () => t && App.terminal.toggleSide(t) },
        { name: "Increase terminal font size", hint: "Ctrl+=", disabled: !t, handler: () => fontStep(1) },
        { name: "Decrease terminal font size", hint: "Ctrl+-", disabled: !t, handler: () => fontStep(-1) },
        { name: "Reset terminal font size to default", hint: "Ctrl+0", disabled: !t, handler: () => fontStep(0) },
      ] },
      { name: "Window", submenu: [
        { name: "Minimize", handler: () => App.win() && App.win().minimize() },
      ] },
      { name: "Help", submenu: [
        { name: "Keyboard shortcuts", handler: () => App.openSettings("shortcuts") },
        { name: "About", handler: () => App.dialog({ title: "Shellbox", body: "A free SSH client: hosts, terminal tabs, SFTP, keychain, port forwarding and snippets. Your data stays on this computer.", actions: [{ name: "Close", kind: "primary" }] }) },
      ] },
    ]);
  };

  const wireWindow = (settingsWindow) => {
    const w = App.win();
    document.getElementById("btn-menu").innerHTML = Icon("menu", 18);
    document.getElementById("btn-bell").innerHTML = Icon("bell", 16);
    document.getElementById("btn-bell").onclick = (e) => App.menu(e, [{ name: "No new notifications", disabled: true }]);
    document.getElementById("win-min").innerHTML = Icon("min", 14);
    document.getElementById("win-max").innerHTML = Icon("max", 12);
    document.getElementById("win-close").innerHTML = Icon("close", 14);
    document.getElementById("btn-menu").onmousedown = (e) => { e.preventDefault(); App.appMenu(e); };
    document.getElementById("win-min").onclick = () => w && w.minimize();
    document.getElementById("win-max").onclick = () => w && w.toggleMaximize();
    document.getElementById("win-close").onclick = () => w && w.close();
    if (settingsWindow) {
      document.getElementById("btn-menu").classList.add("hidden");
      document.getElementById("btn-bell").classList.add("hidden");
      document.getElementById("win-min").classList.add("hidden");
      document.getElementById("win-max").classList.add("hidden");
    }
  };

  // ---------- start ----------
  const start = async () => {
    const isSettings = location.hash.startsWith("#settings");
    App.windowLabel = App.win() ? App.win().label : "main";
    await App.load();
    App.applyUiTheme();
    wireWindow(isSettings);

    App.listen("store-changed", async (p) => {
      if (p && p.from === App.windowLabel) return;
      await App.load();
      App.applyUiTheme();
      if (isSettings) App.renderSettings(document.getElementById("main"));
      else { App.terminal.applyAll(); if (!App.slider.isOpen()) App.refresh(); }
    });

    if (isSettings) {
      document.body.classList.add("settings-window");
      document.getElementById("sidebar").classList.add("closed");
      const bar = document.getElementById("tabs");
      bar.append(h("div", { style: "font-size:14px;font-weight:600;padding-left:12px", "data-tauri-drag-region": true }, "Settings"));
      App.renderSettings(document.getElementById("main"));
      window.addEventListener("hashchange", () => App.renderSettings(document.getElementById("main")));
      return;
    }

    // Connections left over from before a reload are closed so they don't linger unseen.
    await App.invoke("sessions_reset").catch(() => {});
    App.terminal.init();
    App.usage.start();
    App.containers.start();
    App.databases.start();
    App.servers.start();
    window.addEventListener("keydown", onKey, true);
    App.openTab("vaults");
    if (App.screenshotMode) {
      const v = App.screenshotView;
      try {
        if (["servers", "containers", "databases", "keychain", "forwarding", "snippets", "known", "logs"].includes(v)) App.openVaultPage(v);
        else if (v === "sftp") App.openTab("sftp");
        else if (v === "local") App.terminal.openLocal();
        else if (v === "newhost") App.hosts.editHost(App.data.hosts[0]);
        else if (v === "palette") App.palette("newTab");
        else if (v === "auth") App.terminal.demoAuthPrompt();
        else if (v === "layoutmenu") setTimeout(() => document.querySelector('.toolbar .icon-btn[title="View"]')?.click(), 50);
        else if (v === "selected") { App.hosts.selected = App.data.hosts[App.data.hosts.length > 1 ? 1 : 0]?.id; App.refresh(); }
        else if (v === "localkeys") { App.openVaultPage("keychain"); App.keychain.localKeysDialog(); }
        else if (v === "connect") App.terminal.connectHost(App.data.hosts[0]);
        else if (v === "quick") App.invoke("shot_quick").then((q) => q && App.hosts.quickConnect(q));
      } catch (e) { document.body.append(h("pre", { style: "position:fixed;bottom:0;left:0;color:red;z-index:99" }, String(e.stack || e))); }
      window.onerror = (m, s, l) => document.body.append(h("pre", { style: "position:fixed;bottom:0;left:0;color:red;z-index:99" }, m + " " + s + ":" + l));
      requestAnimationFrame(() => requestAnimationFrame(() => App.invoke("ui_ready").catch(() => {})));
    }
  };
  document.addEventListener("DOMContentLoaded", start);
})();
