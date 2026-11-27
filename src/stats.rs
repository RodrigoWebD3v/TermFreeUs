//! Host resource usage for the host cards: CPU, memory and battery, read over a quiet SSH connection.
//!
//! One connection per host is kept open between polls so a refresh every few seconds doesn't log in
//! again each time. It never asks for anything: unknown host keys and failed logins come back as errors.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;

use crate::ssh::{self, Link, Target};

#[derive(Default)]
pub struct Stats {
    links: tokio::sync::Mutex<HashMap<String, Arc<Link>>>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct HostStats {
    /// Share of CPU time busy over the sampling second, 0..100.
    pub cpu: Option<f32>,
    pub mem_used: u64,
    pub mem_total: u64,
    /// Battery charge 0..100, only for hosts that have one.
    pub battery: Option<u8>,
    /// Charging, Discharging, Full, Not charging...
    pub battery_status: Option<String>,
}

/// Two CPU samples a second apart, memory, then every battery's capacity and status.
/// Linux reads /proc and /sys; other systems answer with nothing and get no numbers.
const SCRIPT: &str = "LC_ALL=C; head -n1 /proc/stat; sleep 1; head -n1 /proc/stat; \
grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached):' /proc/meminfo; \
for b in /sys/class/power_supply/BAT*; do [ -r \"$b/capacity\" ] && echo \"BAT $(cat \"$b/capacity\") $(cat \"$b/status\" 2>/dev/null)\"; done; true";

pub async fn poll(s: &Stats, id: String, target: Target) -> Result<HostStats, String> {
    let out = exec(s, &id, &target, SCRIPT, 10).await?;
    parse(&out.stdout)
}

/// What a command printed and how it ended.
#[derive(Debug, Default)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<u32>,
}

/// Runs one command over the host's kept connection (the containers screen shares it with the usage line),
/// logging in again once when the kept connection has gone away.
pub async fn exec(s: &Stats, id: &str, target: &Target, script: &str, secs: u64) -> Result<Output, String> {
    let cached = s.links.lock().await.get(id).cloned();
    if let Some(link) = cached {
        match run(&link, script, secs).await {
            Ok(out) => return Ok(out),
            Err(e) if e.starts_with("TIMEOUT|") => return Err(e),
            Err(_) => {
                // The kept connection went away (host slept, network changed): log in again below.
                s.links.lock().await.remove(id);
            }
        }
    }
    let link = tokio::time::timeout(Duration::from_secs(20), ssh::connect(target, Arc::new(Mutex::new(HashMap::new()))))
        .await
        .map_err(|_| "OFFLINE|Timed out".to_string())??;
    let link = Arc::new(link);
    let out = run(&link, script, secs).await?;
    s.links.lock().await.insert(id.to_string(), link);
    Ok(out)
}

pub async fn forget(s: &Stats, id: &str) {
    if let Some(link) = s.links.lock().await.remove(id) {
        link.close().await;
    }
}

pub async fn forget_all(s: &Stats) {
    let all: Vec<Arc<Link>> = s.links.lock().await.drain().map(|(_, l)| l).collect();
    for link in all {
        link.close().await;
    }
}

async fn run(link: &Link, script: &str, secs: u64) -> Result<Output, String> {
    let mut ch = link.conn.channel_open_session().await.map_err(|e| e.to_string())?;
    ch.exec(true, script).await.map_err(|e| e.to_string())?;
    let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), None);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        match tokio::time::timeout_at(deadline, ch.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => out.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => err.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => code = Some(exit_status),
            Ok(Some(ChannelMsg::Eof)) if code.is_some() => break,
            Ok(Some(ChannelMsg::Close)) | Ok(None) => break,
            Ok(Some(_)) => {}
            Err(_) => {
                let _ = ch.close().await;
                return Err("TIMEOUT|The server took too long to answer".into());
            }
        }
    }
    let _ = ch.close().await;
    Ok(Output {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        code,
    })
}

/// Busy and total jiffies from a `cpu  user nice system idle iowait irq softirq steal ...` line.
pub(crate) fn cpu_times(line: &str) -> Option<(u64, u64)> {
    let mut it = line.split_whitespace();
    if it.next()? != "cpu" {
        return None;
    }
    let v: Vec<u64> = it.take(8).filter_map(|x| x.parse().ok()).collect();
    if v.len() < 4 {
        return None;
    }
    let total: u64 = v.iter().sum();
    let idle = v[3] + v.get(4).copied().unwrap_or(0);
    Some((total - idle, total))
}

pub fn parse(text: &str) -> Result<HostStats, String> {
    let mut st = HostStats::default();
    let mut cpu = Vec::new();
    let mut mem: HashMap<&str, u64> = HashMap::new();
    let mut batteries: Vec<(u8, String)> = Vec::new();
    for line in text.lines() {
        if let Some(t) = cpu_times(line) {
            cpu.push(t);
        } else if let Some((k, rest)) = line.split_once(':') {
            if let Some(kb) = rest.split_whitespace().next().and_then(|x| x.parse::<u64>().ok()) {
                mem.insert(k.trim(), kb * 1024);
            }
        } else if let Some(rest) = line.strip_prefix("BAT ") {
            let mut parts = rest.splitn(2, ' ');
            if let Some(cap) = parts.next().and_then(|x| x.trim().parse::<u8>().ok()) {
                batteries.push((cap.min(100), parts.next().unwrap_or("").trim().to_string()));
            }
        }
    }
    if cpu.len() >= 2 {
        let (b0, t0) = cpu[0];
        let (b1, t1) = cpu[cpu.len() - 1];
        if t1 > t0 {
            st.cpu = Some(((b1.saturating_sub(b0)) as f32 / (t1 - t0) as f32 * 100.0).clamp(0.0, 100.0));
        }
    }
    if let Some(&total) = mem.get("MemTotal") {
        let avail = mem.get("MemAvailable").copied().unwrap_or_else(|| {
            ["MemFree", "Buffers", "Cached"].iter().filter_map(|k| mem.get(k)).sum()
        });
        st.mem_total = total;
        st.mem_used = total.saturating_sub(avail);
    }
    if !batteries.is_empty() {
        // Laptops with two batteries show their average charge.
        let avg = batteries.iter().map(|b| b.0 as u32).sum::<u32>() / batteries.len() as u32;
        st.battery = Some(avg as u8);
        let status = batteries.iter().map(|b| b.1.clone()).find(|s| !s.is_empty());
        st.battery_status = status;
    }
    if st.cpu.is_none() && st.mem_total == 0 {
        return Err("UNSUPPORTED|This host doesn't report usage (Linux only)".into());
    }
    Ok(st)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_linux_output() {
        let text = "cpu  100 0 100 800 0 0 0 0 0 0\n\
cpu  150 0 150 900 0 0 0 0 0 0\n\
MemTotal:        8000000 kB\nMemFree:          1000000 kB\nMemAvailable:     2000000 kB\n\
BAT 85 Discharging\n";
        let s = parse(text).unwrap();
        assert_eq!(s.cpu.map(|c| c.round() as i32), Some(50));
        assert_eq!(s.mem_total, 8_000_000 * 1024);
        assert_eq!(s.mem_used, 6_000_000 * 1024);
        assert_eq!(s.battery, Some(85));
        assert_eq!(s.battery_status.as_deref(), Some("Discharging"));
    }

    #[test]
    fn no_battery_and_old_kernel() {
        let text = "cpu  1 0 1 8\ncpu  1 0 1 18\nMemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 100 kB\nCached: 100 kB\n";
        let s = parse(text).unwrap();
        assert_eq!(s.cpu, Some(0.0));
        assert_eq!(s.mem_used, 600 * 1024);
        assert_eq!(s.battery, None);
    }

    #[test]
    fn non_linux_is_unsupported() {
        assert!(parse("").unwrap_err().starts_with("UNSUPPORTED"));
    }
}
