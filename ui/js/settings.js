// Settings window: Account, Terminal, SFTP, Logs and Shortcuts (the original's sections, in its order).
(function () {
  const F = App.forms;
  const SECTIONS = [["account", "Account"], ["terminal", "Terminal"], ["sftp", "SFTP"], ["logs", "Logs"], ["shortcuts", "Shortcuts"]];
  // The original's "PC hotkeys" preset (see MECHANICS.md).
  App.SHORTCUTS = [
    ["Copy from Terminal", "Ctrl+Shift+C"], ["Paste to Terminal", "Ctrl+Shift+V"], ["Select All in Terminal", "Ctrl+Shift+A"],
    ["Show Terminal Side-panel", "Ctrl+."], ["Open Local Terminal", "Ctrl+L"], ["Open Serial Connection", "Ctrl+Alt+S"],
    ["Open Terminal Search", "Ctrl+Shift+F"], ["Close Tab", "Ctrl+Shift+W"], ["Open Snippets", "Ctrl+Shift+S"],
    ["Open Port Forwarding", "Ctrl+P"], ["Open Command Palette", "Ctrl+K"], ["Jump to", "Ctrl+J"], ["New tab", "Ctrl+T"],
    ["Next Tab", "Alt+→"], ["Previous Tab", "Alt+←"], ["Switch to tab 1-9", "Ctrl+1-9"],
  ];

  App.renderSettings = (root) => {
    const section = (location.hash.split("/")[1] || "terminal").toLowerCase();
    root.innerHTML = "";
    const wrap = h("div", { class: "settings" });
    const nav = h("div", { class: "settings-nav" });
    for (const [id, label] of SECTIONS) {
      const b = h("button", { class: "nav-item" + (id === section ? " selected" : "") }, h("span", { class: "nav-title" }, label));
      b.onclick = () => { location.hash = "#settings/" + id; };
      nav.append(b);
    }
    const body = h("div", { class: "settings-body" });
    wrap.append(nav, body);
    root.append(wrap);
    const s = App.data.settings;
    const save = () => { App.save(); };

    if (section === "account") {
      body.append(h("h2", {}, "Account"));
      const loc = h("div", { class: "desc", style: "user-select:text" }, "...");
      App.invoke("data_location").then((p) => (loc.textContent = p)).catch(() => (loc.textContent = "this computer"));
      body.append(h("div", { class: "set-group" },
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Local account"), h("div", { class: "desc" }, "Free, no sign-in. Everything stays on this computer.")), h("span", { class: "tag", style: "background:var(--green)" }, "Free")),
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Saved in"), loc)),
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Export everything"), h("div", { class: "desc" }, "Hosts, keys, snippets and rules as one file (passwords included, keep it safe).")),
          (() => { const b = h("button", { class: "btn" }, "Export"); b.onclick = async () => { if (await App.invoke("save_text_file", { title: "Export", name: "shellbox-backup.json", contents: JSON.stringify(App.data, null, 2) })) App.toast("Exported"); }; return b; })()),
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Import a backup"), h("div", { class: "desc" }, "Replaces what is saved now.")),
          (() => { const b = h("button", { class: "btn" }, "Import"); b.onclick = async () => {
            const f = await App.invoke("pick_files", { title: "Backup file", folder: false, multiple: false });
            if (!f[0]) return;
            try { const d = JSON.parse(await App.invoke("read_text_file", { path: f[0] })); if (!Array.isArray(d.hosts)) throw "not a backup file"; App.data = Object.assign(App.data, d); App.save(); App.toast("Imported"); } catch (e) { App.toast("Import failed: " + e, true); }
          }; return b; })())));
      return;
    }

    if (section === "terminal") {
      body.append(h("h2", {}, "Terminal"));
      const minus = h("button", { class: "icon-btn", html: Icon("min", 14) });
      const plus = h("button", { class: "icon-btn", html: Icon("plus", 14) });
      const size = h("input", { class: "input", value: s.fontSize });
      const setSize = (n) => { s.fontSize = Math.min(40, Math.max(4, n || 14)); size.value = s.fontSize; minus.disabled = s.fontSize <= 4; plus.disabled = s.fontSize >= 40; save(); };
      minus.onclick = () => setSize(s.fontSize - 1); plus.onclick = () => setSize(s.fontSize + 1);
      size.onchange = () => setSize(parseInt(size.value.replace(/[^\d]/g, ""), 10));
      const fonts = ["Source Code Pro", "Source Code Pro Medium", "Fira Mono", "Fira Mono Medium", "Inconsolata-g", "Anonymous Pro", "Ubuntu Mono", "Droid Sans Mono",
        "Dejavu Sans Mono", "PT Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", "Meslo", "Consolas"];
      body.append(h("div", { class: "set-group" },
        h("div", { class: "set-row" }, h("div", { class: "lbl" }, "Text Size"), h("div", { class: "stepper" }, minus, size, plus)),
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Font"), h("div", { class: "desc" }, "Fonts not installed on this computer fall back to Cascadia Mono or Consolas.")),
          h("div", { style: "width:220px" }, F.select(s, "fontFamily", fonts.map((f) => ({ value: f, label: f }))))),
        h("div", { class: "set-row" }, h("div", { class: "lbl" }, "App theme"),
          h("div", { style: "width:220px" }, F.select(s, "uiTheme", [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }], { onChange: () => App.applyUiTheme() }))),
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Interface animations"), h("div", { class: "desc" }, "System follows Windows: with animation effects off there, menus and panels only fade.")),
          h("div", { style: "width:220px" }, F.select(s, "uiMotion", [{ value: "system", label: "System" }, { value: "on", label: "Always on" }, { value: "off", label: "Off" }], { onChange: () => App.applyMotion() })))));
      body.append(h("h3", {}, "Terminal theme"));
      const grid = h("div", { class: "theme-grid" });
      const drawThemes = () => {
        grid.innerHTML = "";
        for (const t of window.THEMES || []) grid.append(App.terminal.swatch(t, t.name.toLowerCase() === s.theme, () => { s.theme = t.name.toLowerCase(); save(); drawThemes(); }));
      };
      drawThemes();
      body.append(grid);
      const tg = (label, key, desc) => h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, label), desc ? h("div", { class: "desc" }, desc) : null), F.toggle(s, key, { onChange: save }));
      body.append(h("h3", {}, "Terminal settings"));
      body.append(h("div", { class: "set-group" },
        tg("Autoreconnect", "autoReconnect", "Reconnect up to 3 times when a connection drops."),
        tg("Select text to copy & Right click to paste", "rightClickPaste"),
        tg("Copy on select", "copyOnSelect"),
        tg("Bell sound", "bell"),
        tg("Use bright colours for bold text", "brightBold"),
        tg("Use this computer's SSH keys", "localKeys", "Hosts without a key or password of their own try the keys in your .ssh folder, like the ssh command does."),
        tg("Show host usage on host cards", "hostUsage", "CPU, memory and battery of hosts whose saved login works, refreshed every 10 seconds (Linux hosts)."),
        tg("Show Docker containers", "hostContainers", "The Containers screen and a running / stopped count on host cards, for hosts whose saved login works (Docker and Easypanel).")));
      const ka = h("input", { class: "input", style: "width:120px", value: s.keepalive || 0 });
      ka.onchange = () => { s.keepalive = Math.max(0, parseInt(ka.value, 10) || 0); ka.value = s.keepalive; save(); };
      const sb = h("input", { class: "input", style: "width:120px", type: "number", value: s.scrollback });
      sb.onchange = () => { const v = Math.abs(parseInt(sb.value, 10)) || 0; s.scrollback = v === 0 || v > 40000 ? 40000 : v; sb.value = s.scrollback; save(); };
      body.append(h("div", { class: "set-group" },
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Keepalive Interval"), h("div", { class: "desc" }, "How often (in seconds) to send SSH-level keepalive packets to the server. Set to 0 to disable.")), ka),
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Scrollback"), h("div", { class: "desc" }, "Limit number of terminal rows. Set to 0 to maximum limit size.")), sb),
        h("div", { class: "set-row" }, h("div", { class: "lbl" }, "Terminal emulation type"),
          h("div", { style: "width:220px" }, F.select(s, "termType", ["xterm-256color", "xterm", "linux", "vt100"].map((v) => ({ value: v, label: v }))))),
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Local Terminal Path"), h("div", { class: "desc" }, "Empty uses PowerShell on Windows or your login shell elsewhere.")),
          h("div", { style: "width:260px" }, F.input(s, "localShell", { placeholder: "powershell.exe" })))));
      return;
    }

    if (section === "sftp") {
      body.append(h("h2", {}, "SFTP"));
      body.append(h("div", { class: "set-group" }, h("div", { class: "set-row" }, h("div", {},
        h("div", { class: "lbl" }, "File type associations"),
        h("div", { class: "desc" }, "No file type associations yet. Double-clicking a folder opens it; drag files between the two panes to copy them.")))));
      return;
    }

    if (section === "logs") {
      body.append(h("h2", {}, "Logs"));
      const del = h("button", { class: "btn danger" }, "Delete existing logs");
      del.onclick = async () => { if (await App.confirm("Delete existing logs", "Delete the whole connection history?", "Delete")) { App.data.logs = []; save(); App.toast("Logs deleted"); } };
      body.append(h("div", { class: "set-group" },
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Keep connection logs"), h("div", { class: "desc" }, "Control how logs are stored on this computer.")), F.toggle(s, "logsEnabled", { onChange: save })),
        h("div", { class: "set-row" }, h("div", {}, h("div", { class: "lbl" }, "Saved entries"), h("div", { class: "desc" }, String(App.data.logs.length))), del)));
      return;
    }

    body.append(h("h2", {}, "Shortcuts"));
    body.append(h("div", { class: "desc", style: "margin:-8px 0 14px;color:var(--text-2)" }, "PC hotkeys"));
    const g = h("div", { class: "set-group" });
    for (const [name, keys] of App.SHORTCUTS) g.append(h("div", { class: "set-row" }, h("div", { class: "lbl" }, name), h("div", {}, ...keys.split("+").map((k) => h("span", { class: "kbd" }, k)))));
    body.append(g);
  };
})();
