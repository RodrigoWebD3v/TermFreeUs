//! Requests passing through a host's Traefik (Easypanel's proxy) for the Servers screen.
//!
//! Easypanel starts Traefik with `TRAEFIK_ACCESSLOG=true`, so every request is a line in the container's own log
//! (Common Log Format plus Traefik's request count, router, backend and duration). Each read takes only the lines
//! newer than the last one seen (`docker logs --since <last> --tail 3000`, which reads from the end of the file),
//! and once a minute the router list from Traefik's API to know which domains each service answers.
//! Query strings are dropped before anything leaves the server side of this module.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::ssh::Target;
use crate::stats::{self, Stats};

#[derive(Default)]
pub struct Traefik {
    hosts: tokio::sync::Mutex<HashMap<String, HostState>>,
}

#[derive(Default)]
struct HostState {
    /// Docker timestamp of the newest line already handed out.
    last: Option<String>,
    routers_at: Option<Instant>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Req {
    /// Seconds since 1970 (with fractions).
    pub t: f64,
    pub status: u16,
    pub bytes: u64,
    pub ms: u32,
    pub method: String,
    /// Path without its query string.
    pub path: String,
    /// Easypanel service (`back_api02`) or the router name when it isn't one of Easypanel's.
    pub service: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Batch {
    pub reqs: Vec<Req>,
    /// More lines arrived since the last read than one read takes: some were skipped.
    pub gap: bool,
    /// Service → domains, only on the reads that refreshed the router list.
    pub domains: HashMap<String, Vec<String>>,
}

const TAIL: usize = 3000;
const ROUTERS_EVERY: Duration = Duration::from_secs(60);

fn script(since: Option<&str>, routers: bool) -> String {
    let since = since.map(|s| format!("--since {s} ")).unwrap_or_default();
    let mut s = format!(
        "c=$(docker ps -q -f name=traefik -f status=running 2>/dev/null | head -n1); \
[ -n \"$c\" ] || {{ echo '#NOTRAEFIK'; exit 0; }}; \
echo '#LOG'; docker logs --timestamps --tail {TAIL} {since}\"$c\" 2>&1; "
    );
    if routers {
        s.push_str("echo; echo '#ROUTERS'; docker exec \"$c\" wget -qO- 'http://127.0.0.1:8080/api/http/routers?per_page=1000' 2>/dev/null; echo; ");
    }
    s.push_str("true");
    s
}

/// A Docker timestamp we produced ourselves; checked anyway before it goes into a command.
fn safe_ts(ts: &str) -> bool {
    !ts.is_empty() && ts.len() < 40 && ts.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | 'T' | 'Z' | '+'))
}

pub async fn poll(tr: &Traefik, s: &Stats, id: String, target: Target) -> Result<Batch, String> {
    let (since, routers) = {
        let hosts = tr.hosts.lock().await;
        let st = hosts.get(&id);
        let since = st.and_then(|h| h.last.clone()).filter(|t| safe_ts(t));
        let routers = st.and_then(|h| h.routers_at).map_or(true, |at| at.elapsed() >= ROUTERS_EVERY);
        (since, routers)
    };
    let out = stats::exec(s, &id, &target, &script(since.as_deref(), routers), 20).await?;
    if out.stdout.lines().any(|l| l.trim() == "#NOTRAEFIK") {
        return Err("NO_TRAEFIK|No Traefik container is running on this host".into());
    }
    let first = since.is_none();
    let (mut batch, newest, oldest, lines) = parse(&out.stdout, since.as_deref());
    if first {
        // The first read only shows the last 2 minutes, so the numbers start out meaningful.
        if let Some(last) = batch.reqs.last().map(|r| r.t) {
            batch.reqs.retain(|r| r.t >= last - 120.0);
        }
    } else if lines >= TAIL && oldest.as_deref().zip(since.as_deref()).is_some_and(|(o, s)| o > s) {
        batch.gap = true;
    }
    let mut hosts = tr.hosts.lock().await;
    let st = hosts.entry(id).or_default();
    if newest.is_some() {
        st.last = newest;
    }
    if routers {
        st.routers_at = Some(Instant::now());
    }
    Ok(batch)
}

pub async fn forget(tr: &Traefik, id: &str) {
    tr.hosts.lock().await.remove(id);
}

/// `https-back_api02-0@file` → `back_api02`; other routers keep their name without the provider.
pub fn service_of(router: &str) -> String {
    let name = router.split('@').next().unwrap_or(router);
    let name = name.strip_prefix("https-").or_else(|| name.strip_prefix("http-")).unwrap_or(name);
    match name.rsplit_once('-') {
        Some((base, n)) if !base.is_empty() && !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) => base.to_string(),
        _ => name.to_string(),
    }
}

/// The quoted string that ends at `end` (the index of its closing quote), and where it starts.
fn quoted_before(line: &str, end: usize) -> Option<(usize, &str)> {
    let open = line[..end].rfind('"')?;
    Some((open, &line[open + 1..end]))
}

/// One access log line, with Docker's timestamp in front:
/// `<ts> <ip> - <user> [<time>] "<method> <path> <proto>" <status> <size> "<referer>" "<agent>" <n> "<router>" "<backend>" <ms>ms`
pub fn parse_line(line: &str) -> Option<(String, Req)> {
    let line = line.trim_end();
    let (ts, rest) = line.split_once(' ')?;
    if !ts.ends_with('Z') || !rest.contains("] \"") {
        return None;
    }
    let t = chrono::DateTime::parse_from_rfc3339(ts).ok()?;
    let t = t.timestamp() as f64 + t.timestamp_subsec_nanos() as f64 / 1e9;
    // From the end: duration, backend, router.
    let (head, dur) = line.rsplit_once(' ')?;
    let ms: u32 = dur.strip_suffix("ms")?.parse().ok()?;
    let backend_end = head.len().checked_sub(1).filter(|&i| head.as_bytes()[i] == b'"')?;
    let (backend_open, _) = quoted_before(head, backend_end)?;
    let router_end = head[..backend_open].trim_end().len().checked_sub(1)?;
    let (_, router) = quoted_before(head, router_end)?;
    // From the front: request, status, size.
    let req_open = rest.find("] \"")? + 3;
    let req_close = req_open + rest[req_open..].find('"')?;
    let mut req = rest[req_open..req_close].split(' ');
    let method = req.next()?.to_string();
    let path = req.next().unwrap_or("").split('?').next().unwrap_or("").to_string();
    let mut after = rest[req_close + 1..].split_whitespace();
    let status: u16 = after.next()?.parse().ok()?;
    let bytes: u64 = after.next().and_then(|b| b.parse().ok()).unwrap_or(0);
    Some((ts.to_string(), Req { t, status, bytes, ms, method, path, service: service_of(router) }))
}

/// `Host(`a.com`) || Host(`b.com`) && PathPrefix(`/`)` → a.com, b.com
fn hosts_in_rule(rule: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = rule;
    while let Some(i) = rest.find("Host(") {
        rest = &rest[i + 5..];
        let end = rest.find(')').unwrap_or(rest.len());
        for part in rest[..end].split(',') {
            let d = part.trim().trim_matches(|c| c == '`' || c == '"' || c == '\'');
            if !d.is_empty() {
                out.push(d.to_string());
            }
        }
        rest = &rest[end..];
    }
    out
}

/// The requests newer than `since`, the newest and oldest timestamps read, how many log lines came back,
/// and the service → domains map when the router list was asked for.
pub fn parse(output: &str, since: Option<&str>) -> (Batch, Option<String>, Option<String>, usize) {
    let mut batch = Batch::default();
    let (mut newest, mut oldest, mut lines) = (None::<String>, None::<String>, 0usize);
    let mut section = "";
    for line in output.lines() {
        let tl = line.trim();
        if tl == "#LOG" || tl == "#ROUTERS" {
            section = tl;
            continue;
        }
        match section {
            "#LOG" => {
                let Some(ts) = line.split(' ').next().filter(|t| t.ends_with('Z')) else { continue };
                lines += 1;
                if oldest.is_none() {
                    oldest = Some(ts.to_string());
                }
                if since.is_some_and(|s| ts <= s) {
                    continue;
                }
                if newest.as_deref().map_or(true, |n| ts > n) {
                    newest = Some(ts.to_string());
                }
                if let Some((_, r)) = parse_line(line) {
                    batch.reqs.push(r);
                }
            }
            "#ROUTERS" if !tl.is_empty() => {
                if let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(tl) {
                    for r in list {
                        let (Some(name), Some(rule)) = (r["name"].as_str(), r["rule"].as_str()) else { continue };
                        if name.ends_with("@internal") {
                            continue;
                        }
                        let doms = hosts_in_rule(rule);
                        if doms.is_empty() {
                            continue;
                        }
                        let e = batch.domains.entry(service_of(name)).or_default();
                        for d in doms {
                            if !e.contains(&d) {
                                e.push(d);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    (batch, newest, oldest, lines)
}

/// Reads a saved host's Traefik twice, 3 s apart, for real:
/// `SHELLBOX_DIAG="<host label>" cargo test diag_traefik -- --ignored --nocapture`.
#[cfg(test)]
#[tokio::test]
#[ignore]
async fn diag_traefik() {
    let label = std::env::var("SHELLBOX_DIAG").expect("set SHELLBOX_DIAG to a host label");
    let path = dirs::data_dir().unwrap().join("Shellbox").join("vault.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let host = v["hosts"].as_array().unwrap().iter().find(|h| h["label"] == label.as_str()).expect("no such host").clone();
    let addr = host["address"].as_str().unwrap().to_string();
    let port = host["port"].as_u64().unwrap_or(22) as u16;
    let trusted = v["knownHosts"].as_array().unwrap().iter()
        .filter(|k| k["host"] == addr.as_str() && k["port"].as_u64().unwrap_or(22) as u16 == port)
        .filter_map(|k| k["fingerprint"].as_str().map(String::from)).collect();
    let t = Target { host: addr, port, trusted, username: host["username"].as_str().unwrap_or("").into(), password: host["password"].as_str().unwrap_or("").into(), ..Default::default() };
    let (tr, s) = (Traefik::default(), Stats::default());
    for i in 0..3 {
        let started = Instant::now();
        match poll(&tr, &s, "diag".into(), t.clone()).await {
            Ok(b) => {
                let mut per: HashMap<&str, (u32, u32)> = HashMap::new();
                for r in &b.reqs {
                    let e = per.entry(&r.service).or_default();
                    e.0 += 1;
                    if r.status >= 500 { e.1 += 1; }
                }
                println!("#{i} {:?}: {} requests, gap {}, {} services with domains, per service {:?}", started.elapsed(), b.reqs.len(), b.gap, b.domains.len(), per);
                for (svc, d) in b.domains.iter().take(5) {
                    println!("   {svc} -> {d:?}");
                }
            }
            Err(e) => println!("error: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = r#"2026-11-25T02:45:40.774277248Z 203.0.113.9 - - [25/Nov/2026:02:45:40 +0000] "POST /api/interno/adicional/categoria?token=abc HTTP/2.0" 500 78 "-" "Mozilla/5.0 (X11; \"odd\" agent)" 2319571 "https-back_api02-0@file" "http://back_api02:9002/" 12ms"#;

    #[test]
    fn reads_an_access_line() {
        let (ts, r) = parse_line(LINE).unwrap();
        assert_eq!(ts, "2026-11-25T02:45:40.774277248Z");
        assert_eq!(r.status, 500);
        assert_eq!(r.bytes, 78);
        assert_eq!(r.ms, 12);
        assert_eq!(r.method, "POST");
        assert_eq!(r.path, "/api/interno/adicional/categoria");
        assert_eq!(r.service, "back_api02");
        assert!((r.t - 1795574740.774).abs() < 0.01);
    }

    #[test]
    fn skips_other_lines() {
        assert!(parse_line(r#"2026-11-25T02:45:40.1Z time="2026-11-25T02:45:40Z" level=error msg="boom""#).is_none());
        assert!(parse_line("").is_none());
        let no_size = r#"2026-11-25T02:45:40.1Z 1.2.3.4 - - [25/Nov/2026:02:45:40 +0000] "GET / HTTP/1.1" 404 - "-" "-" 5 "-" "-" 0ms"#;
        let (_, r) = parse_line(no_size).unwrap();
        assert_eq!((r.status, r.bytes, r.service.as_str()), (404, 0, "-"));
    }

    #[test]
    fn service_names() {
        assert_eq!(service_of("https-back_api02-0@file"), "back_api02");
        assert_eq!(service_of("https-front_goopedir-next-10@file"), "front_goopedir-next");
        assert_eq!(service_of("https-easypanel-domain@file"), "easypanel-domain");
        assert_eq!(service_of("http-easypanel@docker"), "easypanel");
        assert_eq!(service_of("websecure-myapp@docker"), "websecure-myapp");
    }

    #[test]
    fn batches_and_domains() {
        let out = format!(
            "#LOG\n{}\n2026-11-25T02:45:41.000000000Z time=\"x\" level=info msg=\"y\"\n{}\n\n#ROUTERS\n{}\n",
            LINE.replace("02:45:40.774277248Z", "02:45:39.000000000Z"),
            LINE,
            r#"[{"name":"api@internal","rule":"PathPrefix(`/api`)"},{"name":"https-back_api02-0@file","rule":"Host(`api.example.com`) && PathPrefix(`/`)"},{"name":"https-back_api02-1@file","rule":"Host(`api2.example.com`, `api.example.com`)"}]"#
        );
        let (b, newest, oldest, lines) = parse(&out, Some("2026-11-25T02:45:39.500000000Z"));
        assert_eq!(lines, 3);
        assert_eq!(oldest.as_deref(), Some("2026-11-25T02:45:39.000000000Z"));
        assert_eq!(newest.as_deref(), Some("2026-11-25T02:45:41.000000000Z"));
        assert_eq!(b.reqs.len(), 1);
        assert_eq!(b.domains["back_api02"], vec!["api.example.com".to_string(), "api2.example.com".to_string()]);
        assert!(!b.domains.contains_key("api"));
    }

    #[test]
    fn timestamps_in_commands() {
        assert!(safe_ts("2026-11-25T02:45:40.774277248Z"));
        assert!(!safe_ts("1; rm -rf /"));
        assert!(script(Some("2026-11-25T02:45:40.1Z"), false).contains("--since 2026-11-25T02:45:40.1Z \"$c\""));
        assert!(script(None, true).contains("#ROUTERS"));
    }
}
