// Hosts screen: search bar, "New host" toolbar, groups and host cards, host and group edit panels.
(function () {
  const F = App.forms;
  const H = (App.hosts = { groupId: null, query: "", selected: null });

  H.render = (page) => {
    page.innerHTML = "";
    const d = App.data;

    // search / quick connect
    const input = h("input", { tabindex: "1", placeholder: "Find a host or ssh user@hostname...", value: H.query, spellcheck: "false" });
    const connectBtn = h("button", { class: "btn green", disabled: !App.parseSsh(H.query) }, "Connect");
    input.oninput = () => { H.query = input.value; connectBtn.disabled = !App.parseSsh(H.query); drawContent(); };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        const list = filteredHosts();
        if (list.length === 1 && !/[@\s]/.test(H.query)) App.terminal.connectHost(list[0]);
        else H.quickConnect(H.query);
      }
      if (e.key === "Escape") { H.query = ""; input.value = ""; drawContent(); }
    };
    connectBtn.onclick = () => H.quickConnect(H.query);
    page.append(h("div", { class: "searchbar" }, h("div", { class: "search" }, App.icon("search", 16), input), connectBtn));

    // toolbar: New host (split button), Terminal, Serial | layout and sort
    const newHost = h("button", { class: "btn" }, App.icon("plus", 14), " New host");
    newHost.onclick = () => H.editHost(null);
    const chev = h("button", { class: "btn chev", title: "More", html: Icon("chevron", 12) });
    chev.onclick = (e) =>
      App.menu(e, [
        { name: "New Group", icon: "group", handler: () => H.editGroup(null) },
        { name: "Import", icon: "import", handler: H.importDialog },
      ]);
    const termBtn = h("button", { class: "btn ghost" }, App.icon("terminal", 14), "Terminal");
    termBtn.onclick = () => App.terminal.openLocal();
    const serialBtn = h("button", { class: "btn ghost" }, App.icon("serial", 14), "Serial");
    serialBtn.onclick = () => App.terminal.serialDialog();
    // One button showing the current layout; Grid and List are chosen from its menu, like the original.
    const isList = d.settings.layout === "list";
    const layoutBtn = h("button", { class: "icon-btn", title: "View", html: Icon(isList ? "list" : "grid") });
    const setLayout = (v) => { if (d.settings.layout !== v) H.relayout = true; d.settings.layout = v; App.save(); H.render(page); };
    layoutBtn.onclick = (e) => App.menu(e, [
      { name: "Grid", icon: "grid", checked: !isList, handler: () => setLayout("grid") },
      { name: "List", icon: "list", checked: isList, handler: () => setLayout("list") },
    ]);
    const sortBtn = h("button", { class: "icon-btn", title: "Sort", html: Icon("sort") });
    sortBtn.onclick = (e) => App.sortMenu(e, () => H.render(page));
    page.append(h("div", { class: "toolbar" }, h("div", { class: "split" }, newHost, chev), termBtn, serialBtn, h("div", { class: "grow" }), layoutBtn, sortBtn));

    const content = h("div", { class: "content" });
    page.append(content);

    const filteredHosts = () => {
      const q = H.query.trim().toLowerCase();
      if (q) {
        return d.hosts.filter((x) =>
          [x.label, x.address, App.resolveHost(x).username, ...(x.tags || [])].some((v) => (v || "").toLowerCase().includes(q.replace(/^ssh\s+/, ""))));
      }
      return d.hosts.filter((x) => (x.groupId || null) === H.groupId);
    };

    const drawContent = () => {
      content.innerHTML = "";
      const q = H.query.trim();
      if (!d.hosts.length && !d.groups.length && !q) { content.append(H.emptyState()); return; }

      if (H.groupId && !q) {
        const crumbs = h("div", { class: "breadcrumbs" });
        const all = h("a", {}, "All hosts");
        all.onclick = () => { H.groupId = null; drawContent(); };
        crumbs.append(all);
        for (const g of App.groupPath(H.groupId)) {
          crumbs.append(App.icon("right", 12));
          const a = h("a", {}, g.label || "Group");
          a.onclick = () => { H.groupId = g.id; drawContent(); };
          if (g.id === H.groupId) a.style.color = "var(--text)";
          crumbs.append(a);
        }
        content.append(crumbs);
      }

      const groups = q ? d.groups.filter((g) => (g.label || "").toLowerCase().includes(q.toLowerCase()))
        : d.groups.filter((g) => (g.parentId || null) === H.groupId);
      // Switching between Grid and List eases the cards into their new places.
      const layoutCls = "grid" + (d.settings.layout === "list" ? " list" : "") + (H.relayout ? " relayout" : "");
      if (groups.length) {
        content.append(h("div", { class: "section-title" }, "Groups"));
        const grid = h("div", { class: layoutCls });
        for (const g of App.sortItems(groups, (x) => x.label || "")) grid.append(groupCard(g));
        content.append(grid);
      }
      const hosts = App.sortItems(filteredHosts(), App.hostLabel);
      content.append(h("div", { class: "section-title" }, "Hosts", h("span", { class: "count" }, String(hosts.length))));
      if (!hosts.length) {
        content.append(h("div", { class: "hint", style: "color:var(--text-2);padding:6px 0" },
          q ? "No hosts match. Press Enter to connect to it directly." : "No hosts in this group yet."));
      }
      const grid = h("div", { class: layoutCls });
      for (const x of hosts) grid.append(hostCard(x));
      content.append(grid);
    };

    const groupCard = (g) => {
      const n = d.hosts.filter((x) => x.groupId === g.id).length;
      const sub = d.groups.filter((x) => x.parentId === g.id).length;
      const c = h("div", { class: "card" },
        h("div", { class: "avatar", style: "background:var(--blueberry)", html: Icon("group", 20) }),
        h("div", { class: "info" }, h("div", { class: "title" }, g.label || "Group"),
          h("div", { class: "subtitle" }, `${n} host${n === 1 ? "" : "s"}` + (sub ? `, ${sub} group${sub === 1 ? "" : "s"}` : ""))));
      const edit = h("button", { class: "icon-btn", title: "Edit", html: Icon("edit", 14) });
      edit.onclick = (e) => { e.stopPropagation(); H.editGroup(g); };
      c.append(h("div", { class: "card-actions" }, edit));
      c.ondblclick = () => { H.groupId = g.id; H.query = ""; H.render(page); };
      c.onclick = () => { H.groupId = g.id; H.query = ""; H.render(page); };
      c.oncontextmenu = (e) => {
        e.preventDefault();
        App.menu(e, [
          { name: "Open", icon: "right", handler: () => { H.groupId = g.id; H.render(page); } },
          { name: "Edit", icon: "edit", handler: () => H.editGroup(g) },
          { name: "New host in group", icon: "plus", handler: () => H.editHost(null, g.id) },
          "-",
          { name: "Remove", icon: "trash", danger: true, handler: () => H.removeGroup(g) },
        ]);
      };
      return c;
    };

    const hostCard = (x) => {
      const c = App.resolveHost(x);
      const live = App.terminal.isConnected(x.id);
      const usage = App.usage.badge(x.id);
      const cbadge = App.containers.badge(x.id);
      const card = h("div", { class: "card" + (H.selected === x.id ? " selected" : "") + (usage.classList.contains("on") ? " has-usage" : "") + (cbadge.classList.contains("on") ? " has-cbadge" : ""), "data-host": x.id },
        App.avatar(x.os, App.hostLabel(x)),
        h("div", { class: "info" },
          h("div", { class: "title" }, App.hostLabel(x)),
          h("div", { class: "subtitle" }, "ssh" + (c.username ? ", " + c.username : "") + (x.label && x.label !== x.address ? "" : "")),
          (x.tags || []).length ? h("div", { class: "tagline" }, ...(x.tags || []).slice(0, 3).map((t) => h("span", { class: "tag" }, t))) : null,
          usage,
          cbadge));
      if (live) card.append(h("span", { class: "dot", style: "width:8px;height:8px;border-radius:50%;background:var(--green);position:absolute;left:46px;top:12px" }));
      const edit = h("button", { class: "icon-btn", title: "Edit", html: Icon("edit", 14) });
      edit.onclick = (e) => { e.stopPropagation(); H.editHost(x); };
      card.append(h("div", { class: "card-actions" }, edit));
      card.onclick = () => {
        H.selected = x.id;
        content.querySelectorAll(".card.selected").forEach((e) => e.classList.remove("selected"));
        card.classList.add("selected");
        if (App.slider.isOpen()) H.editHost(x);
      };
      card.ondblclick = () => App.terminal.connectHost(x);
      card.oncontextmenu = (e) => { e.preventDefault(); App.menu(e, H.hostMenu(x)); };
      return card;
    };

    drawContent();
    H.relayout = false;
    setTimeout(() => { if (!App.slider.isOpen()) input.focus(); App.usage.tick(); }, 0);
  };

  H.hostMenu = (x) => [
    { name: "Connect", icon: "terminal", handler: () => App.terminal.connectHost(x) },
    { name: "Open in SFTP", icon: "sftp", handler: () => App.sftp.openHost(x) },
    "-",
    { name: "Edit", icon: "edit", handler: () => H.editHost(x) },
    { name: "Duplicate", icon: "copy", handler: () => H.duplicate(x) },
    { name: "Copy address", icon: "copy", handler: () => navigator.clipboard.writeText(x.address || "") },
    "-",
    { name: "Remove", icon: "trash", danger: true, handler: () => H.removeHost(x) },
  ];

  H.emptyState = () => {
    const inp = h("input", { class: "input", placeholder: "Type IP or Hostname" });
    const go = h("button", { class: "btn primary" }, "Continue");
    const create = () => {
      const p = App.parseSsh(inp.value);
      if (!p) return;
      const x = H.newHost({ address: p.address, port: p.port, username: p.username });
      H.editHost(x);
      App.refresh();
    };
    go.onclick = create;
    inp.onkeydown = (e) => { if (e.key === "Enter") create(); };
    return h("div", { class: "empty" },
      h("div", { class: "empty-art", html: Icon("hosts", 48) }),
      h("h2", {}, "Create host"),
      h("p", {}, "Save a server to connect with one click. Type its IP address or name to start."),
      h("div", { class: "row" }, inp, go));
  };

  H.newHost = (fields = {}) => {
    const x = Object.assign({ id: App.uid(), label: "", address: "", port: 22, groupId: H.groupId, tags: [], username: "", password: "",
      keyId: null, identityId: null, chain: [], env: [], startupSnippetId: null, agentForwarding: false, createdAt: Date.now() }, fields);
    App.data.hosts.push(x);
    App.save();
    return x;
  };

  H.quickConnect = (text) => {
    const p = App.parseSsh(text);
    if (!p) return;
    const temp = { id: "quick-" + App.uid(), label: (p.username ? p.username + "@" : "") + p.address, address: p.address, port: p.port, username: p.username, tags: [], quick: true };
    App.terminal.connectHost(temp);
  };

  H.duplicate = (x) => {
    const copy = JSON.parse(JSON.stringify(x));
    copy.id = App.uid();
    copy.label = (x.label || x.address) + " copy";
    copy.createdAt = Date.now();
    App.data.hosts.push(copy);
    App.save();
    App.refresh();
  };

  H.removeHost = async (x) => {
    if (!(await App.confirm("Remove host", `Remove "${App.hostLabel(x)}"? This cannot be undone.`, "Remove"))) return;
    App.data.hosts = App.data.hosts.filter((y) => y.id !== x.id);
    App.save();
    if (App.slider.isOpen()) App.slider.close();
    App.refresh();
  };

  H.removeGroup = async (g) => {
    if (!(await App.confirm("Remove group", `Remove "${g.label || "Group"}"? Its hosts move to the parent group.`, "Remove"))) return;
    for (const x of App.data.hosts) if (x.groupId === g.id) x.groupId = g.parentId || null;
    for (const y of App.data.groups) if (y.parentId === g.id) y.parentId = g.parentId || null;
    App.data.groups = App.data.groups.filter((y) => y.id !== g.id);
    if (H.groupId === g.id) H.groupId = g.parentId || null;
    App.save();
    App.slider.close();
    App.refresh();
  };

  // Host edit panel: Address, General, SSH on port, credentials, more options, Connect.
  H.editHost = (x, groupId) => {
    const isNew = !x;
    if (isNew) x = H.newHost({ groupId: groupId !== undefined ? groupId : H.groupId });
    if (!Array.isArray(x.env)) x.env = [];
    if (!Array.isArray(x.chain)) x.chain = [];
    const refreshList = () => App.refreshSoft();

    const body = h("div", {});
    body.append(F.card("Address", F.input(x, "address", { placeholder: "IP or Hostname", lead: "globe", onChange: refreshList })));
    body.append(F.card("General",
      F.field(null, F.input(x, "label", { placeholder: "Label", lead: "edit", onChange: refreshList })),
      F.field("Parent Group", F.select(x, "groupId", F.groupOptions(), { placeholder: "No group", onChange: refreshList })),
      F.field("Icon", F.select(x, "os", Object.entries(App.OS_NAMES).sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })),
        { placeholder: "Detect automatically", onChange: (v) => { x.osManual = !!v; App.save(); refreshList(); } })),
      F.field(null, F.tags(x))));

    const port = F.input(x, "port", { type: "number", cls: "small" });
    body.append(F.card(null,
      h("h4", { class: "port-inline" }, "SSH on", port, "port"),
      F.credentials(x)));

    // Host chaining
    const chainBox = h("div", {});
    const drawChain = () => {
      chainBox.innerHTML = "";
      const chips = h("div", { class: "chips" });
      x.chain.forEach((id, i) => {
        const hh = App.byId("hosts", id);
        const rm = h("button", { html: Icon("close", 10) });
        rm.onclick = () => { x.chain.splice(i, 1); App.save(); drawChain(); };
        chips.append(h("span", { class: "chip" }, App.icon("link", 12), hh ? App.hostLabel(hh) : "Missing host", rm));
      });
      const add = h("button", { class: "btn ghost lower", type: "button" }, App.icon("plus", 14), x.chain.length ? "Add hop" : "Add host chain");
      add.onclick = (e) => App.menu(e, F.hostOptions(x.id).map((o) => ({ name: o.label, icon: "hosts", handler: () => { x.chain.push(o.value); App.save(); drawChain(); } })));
      chips.append(add);
      chainBox.append(chips);
    };
    drawChain();

    const snippetOptions = App.data.snippets.map((s) => ({ value: s.id, label: s.label || "Snippet" }));
    const envBox = h("div", {});
    const drawEnv = () => {
      envBox.innerHTML = "";
      x.env.forEach((pair, i) => {
        const rm = h("button", { class: "icon-btn", html: Icon("close", 12) });
        rm.onclick = () => { x.env.splice(i, 1); App.save(); drawEnv(); };
        envBox.append(h("div", { style: "display:flex;gap:6px;margin-bottom:6px" },
          F.input(pair, "k", { placeholder: "Variable" }), F.input(pair, "v", { placeholder: "Value" }), rm));
      });
      const add = h("button", { class: "btn ghost lower", type: "button" }, App.icon("plus", 14), "Add variable");
      add.onclick = () => { x.env.push({ k: "", v: "" }); App.save(); drawEnv(); };
      envBox.append(add);
    };
    drawEnv();

    body.append(F.card(null,
      F.row("Host Chaining", h("span"), "Connect through other hosts first (jump hosts)."), chainBox,
      h("div", { style: "height:10px" }),
      F.row("Agent Forwarding", F.toggle(x, "agentForwarding"), "Not available in this version; the setting is kept."),
      F.field("Startup Snippet", F.select(x, "startupSnippetId", snippetOptions, { placeholder: "None" })),
      F.field("Terminal theme", F.select(x, "theme", (window.THEMES || []).map((t) => ({ value: t.name.toLowerCase(), label: t.name })), { placeholder: "Default (from settings)" })),
      h("div", { class: "field" }, h("label", {}, "Environment Variables"), envBox)));

    const connect = h("button", { class: "btn green big" }, "Connect");
    connect.onclick = () => { if (!x.address) { App.toast("Type an address first", true); return; } App.terminal.connectHost(x); };
    App.slider.open(isNew ? "New Host" : "Host Details", body, {
      foot: connect,
      menu: [
        { name: "Open in SFTP", icon: "sftp", handler: () => App.sftp.openHost(x) },
        { name: "Duplicate", icon: "copy", handler: () => H.duplicate(x) },
        { name: "Remove", icon: "trash", danger: true, handler: () => H.removeHost(x) },
      ],
      onClose: () => {
        // A new host left without an address is thrown away.
        if (!x.address && !x.label) { App.data.hosts = App.data.hosts.filter((y) => y.id !== x.id); App.save(); }
        App.refreshSoft();
      },
    });
    App.refreshSoft();
    setTimeout(() => { const f = App.slider.el().querySelector("input"); if (f && isNew) f.focus(); }, 220);
  };

  H.editGroup = (g) => {
    const isNew = !g;
    if (isNew) {
      g = { id: App.uid(), label: "", parentId: H.groupId, username: "", password: "", keyId: null, identityId: null, createdAt: Date.now() };
      App.data.groups.push(g);
      App.save();
    }
    const body = h("div", {},
      F.card("General",
        F.field(null, F.input(g, "label", { placeholder: "Label", lead: "edit", onChange: App.refreshSoft })),
        F.field("Parent Group", F.select(g, "parentId", F.groupOptions(g.id), { placeholder: "No group", onChange: App.refreshSoft }))),
      F.card("SSH defaults for hosts in this group",
        h("div", { class: "hint", style: "margin-bottom:10px" }, "Hosts in this group use these when their own fields are empty."),
        F.credentials(g)));
    App.slider.open(isNew ? "New Group" : "Group Details", body, {
      menu: [{ name: "Remove", icon: "trash", danger: true, handler: () => H.removeGroup(g) }],
      onClose: () => {
        if (!g.label) { App.data.groups = App.data.groups.filter((y) => y.id !== g.id); App.save(); }
        App.refreshSoft();
      },
    });
    App.refreshSoft();
  };

  // Import hosts from an OpenSSH config file.
  H.importDialog = () => {
    const body = h("div", {},
      h("p", {}, "Read the hosts saved in an OpenSSH config file (Host, HostName, User, Port, IdentityFile)."));
    App.dialog({
      title: "Import",
      body,
      actions: [
        { name: "Cancel", kind: "ghost" },
        { name: "Choose file", kind: "ghost", handler: async () => {
          const files = await App.invoke("pick_files", { title: "OpenSSH config file", folder: false, multiple: false });
          if (files[0]) H.importSshConfig(files[0]);
        } },
        { name: "Import ~/.ssh/config", kind: "primary", handler: () => H.importSshConfig("~/.ssh/config") },
      ],
    });
  };

  H.importSshConfig = async (path) => {
    let text;
    try { text = await App.invoke("read_text_file", { path }); } catch (e) { App.toast("Could not read " + path + ": " + e, true); return; }
    const blocks = [];
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^(\S+)\s*=?\s*(.*)$/);
      if (!m || line.trim().startsWith("#")) continue;
      const k = m[1].toLowerCase(), v = m[2].trim();
      if (k === "host") { cur = { host: v, opts: {} }; blocks.push(cur); }
      else if (cur) cur.opts[k] = v;
    }
    const keysBefore = App.data.keys.length;
    // Like the original's "Import from SSH", the keys in ~/.ssh come along with ~/.ssh/config.
    const local = path === "~/.ssh/config" ? await App.invoke("local_ssh_keys").catch(() => []) : [];
    for (const x of local) if (!x.unsupported) App.keychain.importLocal(x);
    let added = 0;
    for (const b of blocks) {
      if (/[*?]/.test(b.host)) continue;
      const address = b.opts.hostname || b.host.split(/\s+/)[0];
      if (App.data.hosts.some((x) => x.address === address && (x.label === b.host || !x.label))) continue;
      let keyId = null;
      if (b.opts.identityfile) {
        const file = b.opts.identityfile.replace(/^"|"$/g, "").replace(/^~[\\/]/, "~/");
        try {
          const pem = await App.invoke("read_text_file", { path: file });
          const info = await App.invoke("key_inspect", { privateKey: pem, passphrase: "" }).catch(() => null);
          keyId = App.keychain.importLocal({ name: file.split(/[\\/]/).pop(), path: file, private_key: pem, public_key: info ? info.public_key : "",
            fingerprint: info ? info.fingerprint : "", key_type: info ? info.key_type : "" }).id;
        } catch (e) { /* key file not readable: skip it */ }
      }
      H.newHost({ label: b.host.split(/\s+/)[0], address, port: Number(b.opts.port) || 22, username: b.opts.user || "", keyId, groupId: null });
      added++;
    }
    const keys = App.data.keys.length - keysBefore;
    App.save();
    App.refresh();
    App.toast(`Imported ${added} host${added === 1 ? "" : "s"}` + (keys ? ` and ${keys} key${keys === 1 ? "" : "s"}` : ""));
  };
})();
