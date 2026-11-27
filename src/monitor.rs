//! Live numbers of a host for the Servers screen: uptime, load, CPU, memory, swap, disks and network rate.
//!
//! One command over the connection the usage line already keeps open. CPU and network are sampled twice
//! one second apart, so the screen can ask every few seconds and show what is happening right now.

use std::collections::HashMap;

use serde::Serialize;

use crate::ssh::Target;
use crate::stats::{self, cpu_times, Stats};

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Disk {
    pub mount: String,
    pub size: u64,
    pub used: u64,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct HostMonitor {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub uptime_secs: u64,
    pub load: [f32; 3],
    pub cpus: u32,
    /// Share of CPU time busy over the sampling second, 0..100.
    pub cpu: Option<f32>,
    /// Share of CPU time waiting on disks over the sampling second, 0..100.
    pub iowait: Option<f32>,
    pub mem_used: u64,
    pub mem_total: u64,
    pub swap_used: u64,
    pub swap_total: u64,
    /// Bytes per second over the sampling second, all interfaces but loopback and container bridges.
    pub net_rx: u64,
    pub net_tx: u64,
    pub disks: Vec<Disk>,
}

const SCRIPT: &str = r##"LC_ALL=C
echo "#UP $(cat /proc/uptime 2>/dev/null)"
echo "#LOAD $(cat /proc/loadavg 2>/dev/null)"
echo "#CPUS $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
echo "#HOST $(hostname 2>/dev/null)"
echo "#KERNEL $(uname -r 2>/dev/null)"
( . /etc/os-release 2>/dev/null; echo "#OS $PRETTY_NAME" )
head -n1 /proc/stat; tail -n +3 /proc/net/dev 2>/dev/null | sed 's/^/#NET0 /'
sleep 1
head -n1 /proc/stat; tail -n +3 /proc/net/dev 2>/dev/null | sed 's/^/#NET1 /'
grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
df -P -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs -x nsfs 2>/dev/null | tail -n +2 | sed 's/^/#DF /'
true
"##;

pub async fn poll(s: &Stats, id: String, target: Target) -> Result<HostMonitor, String> {
    let out = stats::exec(s, &id, &target, SCRIPT, 15).await?;
    parse(&out.stdout)
}

/// Interfaces that only carry traffic already counted on the real one (loopback, Docker and VM bridges).
fn virtual_iface(name: &str) -> bool {
    name == "lo"
        || ["veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "vxlan", "tunl", "kube-", "weave"]
            .iter()
            .any(|p| name.starts_with(p))
}

/// Received and sent bytes summed over the real interfaces of `/proc/net/dev` lines.
fn net_totals(lines: &[&str]) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in lines {
        let Some((name, rest)) = line.split_once(':') else { continue };
        if virtual_iface(name.trim()) {
            continue;
        }
        let v: Vec<u64> = rest.split_whitespace().filter_map(|x| x.parse().ok()).collect();
        if v.len() >= 9 {
            rx += v[0];
            tx += v[8];
        }
    }
    (rx, tx)
}

/// Busy and iowait jiffies from a `cpu ...` line, with the total.
fn iowait_times(line: &str) -> Option<(u64, u64)> {
    let v: Vec<u64> = line.split_whitespace().skip(1).take(8).filter_map(|x| x.parse().ok()).collect();
    (v.len() >= 5).then(|| (v[4], v.iter().sum()))
}

pub fn parse(text: &str) -> Result<HostMonitor, String> {
    let mut m = HostMonitor::default();
    let mut cpu = Vec::new();
    let mut io = Vec::new();
    let mut net0 = Vec::new();
    let mut net1 = Vec::new();
    let mut mem: HashMap<&str, u64> = HashMap::new();
    for line in text.lines() {
        if let Some(t) = cpu_times(line) {
            cpu.push(t);
            if let Some(w) = iowait_times(line) {
                io.push(w);
            }
        } else if let Some(r) = line.strip_prefix("#UP ") {
            m.uptime_secs = r.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0) as u64;
        } else if let Some(r) = line.strip_prefix("#LOAD ") {
            let v: Vec<f32> = r.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
            if v.len() == 3 {
                m.load = [v[0], v[1], v[2]];
            }
        } else if let Some(r) = line.strip_prefix("#CPUS ") {
            m.cpus = r.trim().parse().unwrap_or(0);
        } else if let Some(r) = line.strip_prefix("#HOST ") {
            m.hostname = r.trim().to_string();
        } else if let Some(r) = line.strip_prefix("#KERNEL ") {
            m.kernel = r.trim().to_string();
        } else if let Some(r) = line.strip_prefix("#OS ") {
            m.os = r.trim().trim_matches('"').to_string();
        } else if let Some(r) = line.strip_prefix("#NET0 ") {
            net0.push(r);
        } else if let Some(r) = line.strip_prefix("#NET1 ") {
            net1.push(r);
        } else if let Some(r) = line.strip_prefix("#DF ") {
            let f: Vec<&str> = r.split_whitespace().collect();
            if f.len() >= 6 {
                let size: u64 = f[1].parse().unwrap_or(0);
                let used: u64 = f[2].parse().unwrap_or(0);
                let mount = f[5..].join(" ");
                // The same device mounted twice (bind mounts) shows once, at its shortest path.
                if size > 0 && !m.disks.iter().any(|d| d.mount == mount) {
                    m.disks.push(Disk { mount, size, used });
                }
            }
        } else if let Some((k, rest)) = line.split_once(':') {
            if let Some(kb) = rest.split_whitespace().next().and_then(|x| x.parse::<u64>().ok()) {
                mem.insert(k.trim(), kb * 1024);
            }
        }
    }
    if cpu.len() >= 2 {
        let ((b0, t0), (b1, t1)) = (cpu[0], cpu[cpu.len() - 1]);
        if t1 > t0 {
            m.cpu = Some((b1.saturating_sub(b0) as f32 / (t1 - t0) as f32 * 100.0).clamp(0.0, 100.0));
        }
    }
    if io.len() >= 2 {
        let ((w0, t0), (w1, t1)) = (io[0], io[io.len() - 1]);
        if t1 > t0 {
            m.iowait = Some((w1.saturating_sub(w0) as f32 / (t1 - t0) as f32 * 100.0).clamp(0.0, 100.0));
        }
    }
    let (r0, s0) = net_totals(&net0);
    let (r1, s1) = net_totals(&net1);
    m.net_rx = r1.saturating_sub(r0);
    m.net_tx = s1.saturating_sub(s0);
    if let Some(&total) = mem.get("MemTotal") {
        let avail = mem.get("MemAvailable").copied().unwrap_or_else(|| ["MemFree", "Buffers", "Cached"].iter().filter_map(|k| mem.get(k)).sum());
        m.mem_total = total;
        m.mem_used = total.saturating_sub(avail);
    }
    if let Some(&total) = mem.get("SwapTotal") {
        m.swap_total = total;
        m.swap_used = total.saturating_sub(mem.get("SwapFree").copied().unwrap_or(total));
    }
    m.disks.sort_by(|a, b| (a.mount != "/").cmp(&(b.mount != "/")).then(b.size.cmp(&a.size)));
    if m.cpu.is_none() && m.mem_total == 0 {
        return Err("UNSUPPORTED|This host doesn't report usage (Linux only)".into());
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "#UP 356400.52 1200000.10
#LOAD 0.52 0.61 0.70 2/512 12345
#CPUS 4
#HOST srv-01
#KERNEL 6.8.0-45-generic
#OS Ubuntu 24.04.1 LTS
cpu  100 0 100 700 100 0 0 0 0 0
#NET0     lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
#NET0   eth0: 1000000 900 0 0 0 0 0 0 2000000 800 0 0 0 0 0 0
#NET0 veth12ab: 777 1 0 0 0 0 0 0 999 1 0 0 0 0 0 0
cpu  150 0 150 780 120 0 0 0 0 0
#NET1     lo: 9000 20 0 0 0 0 0 0 9000 20 0 0 0 0 0 0
#NET1   eth0: 1250000 950 0 0 0 0 0 0 2100000 850 0 0 0 0 0 0
#NET1 veth12ab: 99777 2 0 0 0 0 0 0 99999 2 0 0 0 0 0 0
MemTotal:        8000000 kB
MemFree:          1000000 kB
MemAvailable:     2000000 kB
SwapTotal:        2000000 kB
SwapFree:         1500000 kB
#DF /dev/sda1 100000000000 40000000000 60000000000 40% /
#DF /dev/sdb1 500000000000 100000000000 400000000000 20% /mnt/data disk
#DF /dev/sda15 100000000 6000000 94000000 6% /boot/efi
";

    #[test]
    fn reads_live_numbers() {
        let m = parse(SAMPLE).unwrap();
        assert_eq!(m.uptime_secs, 356400);
        assert_eq!(m.load, [0.52, 0.61, 0.70]);
        assert_eq!(m.cpus, 4);
        assert_eq!(m.hostname, "srv-01");
        assert_eq!(m.os, "Ubuntu 24.04.1 LTS");
        assert_eq!(m.cpu.map(|c| c.round() as i32), Some(50));
        assert_eq!(m.iowait.map(|c| c.round() as i32), Some(10));
        assert_eq!((m.net_rx, m.net_tx), (250000, 100000));
        assert_eq!(m.mem_used, 6_000_000 * 1024);
        assert_eq!((m.swap_used, m.swap_total), (500_000 * 1024, 2_000_000 * 1024));
        assert_eq!(m.disks.len(), 3);
        assert_eq!(m.disks[0].mount, "/");
        assert_eq!(m.disks[1].mount, "/mnt/data disk");
    }

    #[test]
    fn non_linux_is_unsupported() {
        assert!(parse("#UP \n#LOAD \n").unwrap_err().starts_with("UNSUPPORTED"));
    }
}

/// Reads a saved host's live numbers for real: `SHELLBOX_DIAG="<host label>" cargo test diag_monitor -- --ignored --nocapture`.
#[cfg(test)]
#[tokio::test]
#[ignore]
async fn diag_monitor() {
    let label = std::env::var("SHELLBOX_DIAG").expect("set SHELLBOX_DIAG to a host label");
    let path = dirs::data_dir().unwrap().join("Shellbox").join("vault.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let host = v["hosts"].as_array().unwrap().iter().find(|h| h["label"] == label.as_str()).expect("no such host").clone();
    let addr = host["address"].as_str().unwrap().to_string();
    let port = host["port"].as_u64().unwrap_or(22) as u16;
    let trusted = v["knownHosts"].as_array().unwrap().iter()
        .filter(|k| k["host"] == addr.as_str() && k["port"].as_u64().unwrap_or(22) as u16 == port)
        .filter_map(|k| k["fingerprint"].as_str().map(String::from)).collect();
    let t = Target {
        host: addr, port, trusted,
        username: host["username"].as_str().unwrap_or("").into(),
        password: host["password"].as_str().unwrap_or("").into(),
        ..Default::default()
    };
    let s = Stats::default();
    for i in 0..3 {
        let started = std::time::Instant::now();
        match poll(&s, "diag".into(), t.clone()).await {
            Ok(m) => println!("#{i} {:?}: up {}s load {:?} cpus {} cpu {:?} io {:?} mem {}/{}MB swap {}/{}MB net {}/{} B/s os {:?} disks {:?}",
                started.elapsed(), m.uptime_secs, m.load, m.cpus, m.cpu, m.iowait, m.mem_used >> 20, m.mem_total >> 20,
                m.swap_used >> 20, m.swap_total >> 20, m.net_rx, m.net_tx, m.os,
                m.disks.iter().map(|d| format!("{} {}%", d.mount, d.used * 100 / d.size.max(1))).collect::<Vec<_>>()),
            Err(e) => println!("error: {e}"),
        }
    }
}

/// Runs one read-only command on a saved host and prints what it answered:
/// `SHELLBOX_DIAG="<host label>" SHELLBOX_CMD="..." cargo test diag_exec -- --ignored --nocapture`.
#[cfg(test)]
#[tokio::test]
#[ignore]
async fn diag_exec() {
    let label = std::env::var("SHELLBOX_DIAG").expect("set SHELLBOX_DIAG to a host label");
    let cmd = std::env::var("SHELLBOX_CMD").expect("set SHELLBOX_CMD");
    let path = dirs::data_dir().unwrap().join("Shellbox").join("vault.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let host = v["hosts"].as_array().unwrap().iter().find(|h| h["label"] == label.as_str()).expect("no such host").clone();
    let addr = host["address"].as_str().unwrap().to_string();
    let port = host["port"].as_u64().unwrap_or(22) as u16;
    let trusted = v["knownHosts"].as_array().unwrap().iter()
        .filter(|k| k["host"] == addr.as_str() && k["port"].as_u64().unwrap_or(22) as u16 == port)
        .filter_map(|k| k["fingerprint"].as_str().map(String::from)).collect();
    let t = Target { host: addr, port, trusted, username: host["username"].as_str().unwrap_or("").into(), password: host["password"].as_str().unwrap_or("").into(), ..Default::default() };
    let out = stats::exec(&Stats::default(), "diag", &t, &cmd, 60).await.unwrap();
    println!("---stdout---\n{}\n---stderr---\n{}\n---code {:?}", out.stdout, out.stderr, out.code);
}
