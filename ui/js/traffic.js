// Traefik traffic on the Servers screen: the requests Easypanel's proxy answered, read from its access log
// every 2 seconds while the screen is open. Kept per host: 2-second buckets for 10 minutes (the chart) and
// the requests of the last 5 minutes (the per-service table and the recent errors).
(function () {
  const T = (App.traffic = { data: {}, state: {}, open: {}, showAll: {} });
  const KEEP_MS = 10 * 60 * 1000;
  const TABLE_MS = 5 * 60 * 1000;
  const RAW_CAP = 30000;
  const RETRY = 30000;

  const loginKey = (t) => JSON.stringify([t.host, t.port, t.username, t.password, t.key, t.passphrase, t.trusted, t.chain]);

  T.poll = async (host, onDone) => {
    const t = App.usage.eligible(host);
    if (!t) return;
    const st = (T.state[host.id] = T.state[host.id] || {});
    const key = loginKey(t);
    if (st.key !== key) { st.blockedKey = null; st.retryAt = 0; }
    if (st.busy || st.blockedKey === key || (st.retryAt && Date.now() < st.retryAt)) return;
    st.busy = true; st.key = key;
    try {
      const b = await App.invoke("host_traefik", { id: host.id, target: t });
      const d = (T.data[host.id] = T.data[host.id] || { buckets: new Map(), raw: [], domains: {}, gaps: 0 });
      for (const r of b.reqs) {
        const k = Math.floor(r.t / 2) * 2000;
        const bk = d.buckets.get(k) || { n: 0, e5: 0, e4: 0, bytes: 0 };
        bk.n++; bk.bytes += r.bytes;
        if (r.status >= 500) bk.e5++; else if (r.status >= 400) bk.e4++;
        d.buckets.set(k, bk);
        d.raw.push(r);
      }
      if (b.gap) d.gaps++;
      if (Object.keys(b.domains).length) d.domains = b.domains;
      const now = Date.now();
      for (const k of d.buckets.keys()) if (now - k > KEEP_MS) d.buckets.delete(k);
      const cut = now / 1000 - TABLE_MS / 1000;
      let i = 0;
      while (i < d.raw.length && d.raw[i].t < cut) i++;
      if (i) d.raw.splice(0, i);
      if (d.raw.length > RAW_CAP) d.raw.splice(0, d.raw.length - RAW_CAP);
      d.at = now;
      st.err = null;
    } catch (e) {
      const msg = String(e);
      st.err = msg;
      if (/^(AUTH_|HOSTKEY_|KEY_|NO_TRAEFIK)/.test(msg)) st.blockedKey = key;
      else st.retryAt = Date.now() + RETRY;
    } finally {
      st.busy = false;
      onDone && onDone();
    }
  };

  T.has = (hostId) => !!T.data[hostId];

  // Chart points: one per 2 seconds, empty slots counted as zero, up to the last full slot.
  T.series = (hostId) => {
    const d = T.data[hostId];
    if (!d || !d.buckets.size) return [];
    const keys = [...d.buckets.keys()].sort((a, b) => a - b);
    const last = Math.max(keys[keys.length - 1], Math.floor((Date.now() - 2000) / 2000) * 2000);
    const out = [];
    for (let k = keys[0]; k <= last; k += 2000) {
      const b = d.buckets.get(k);
      out.push({ t: k, rps: b ? b.n / 2 : 0, e5: b ? b.e5 / 2 : 0 });
    }
    return out;
  };

  const pctl = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  // Totals and per-service rows over the last 5 minutes.
  T.summary = (hostId) => {
    const d = T.data[hostId];
    if (!d) return null;
    const now = Date.now() / 1000;
    const recent = d.raw.filter((r) => now - r.t <= 10);
    const span = Math.min(TABLE_MS / 1000, Math.max(10, d.raw.length ? now - d.raw[0].t : 10));
    const per = {};
    for (const r of d.raw) {
      const p = (per[r.service] = per[r.service] || { service: r.service, n: 0, e4: 0, e5: 0, bytes: 0, ms: [] });
      p.n++; p.bytes += r.bytes; p.ms.push(r.ms);
      if (r.status >= 500) p.e5++; else if (r.status >= 400) p.e4++;
    }
    const rows = Object.values(per).map((p) => ({
      service: p.service, domains: d.domains[p.service] || [], perMin: (p.n / span) * 60, n: p.n, e4: p.e4, e5: p.e5,
      avg: p.ms.reduce((a, b) => a + b, 0) / p.ms.length, p95: pctl(p.ms, 0.95), bytes: p.bytes,
    })).sort((a, b) => b.n - a.n);
    const all = d.raw.length;
    const e5 = d.raw.filter((r) => r.status >= 500).length;
    return {
      rps: recent.length / 10,
      outRate: recent.reduce((a, r) => a + r.bytes, 0) / 10,
      e5, e5Pct: all ? (e5 / all) * 100 : 0,
      avg: all ? d.raw.reduce((a, r) => a + r.ms, 0) / all : null,
      p95: pctl(d.raw.map((r) => r.ms), 0.95),
      minutes: span / 60, total: all, rows, gaps: d.gaps,
      errors: d.raw.filter((r) => r.status >= 500).slice(-8).reverse(),
    };
  };

  T.forget = (hostId) => {
    delete T.data[hostId]; delete T.state[hostId];
    App.invoke("host_traefik_forget", { id: hostId }).catch(() => {});
  };
})();
