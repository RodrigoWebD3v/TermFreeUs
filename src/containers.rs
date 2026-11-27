//! Docker containers of a host for the Containers screen and the host card summary.
//!
//! Read over the same quiet SSH connection the usage line keeps open (see `stats`). One command lists
//! every container, its live usage and, on a Swarm node (Easypanel runs on Docker Swarm), its services.
//! Actions only take names that look like Docker names, so nothing typed can reach the shell.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ssh::Target;
use crate::stats::{self, Stats};

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    /// running, exited, restarting, paused, created, dead
    pub state: String,
    /// "Up 2 hours (healthy)", "Exited (1) 3 minutes ago"...
    pub status: String,
    pub created: String,
    pub ports: String,
    /// Swarm service this container is a task of ("" for plain containers).
    pub service: String,
    /// Easypanel project, stack or compose project ("" when it has none).
    pub project: String,
    pub cpu: Option<f32>,
    pub mem_used: u64,
    pub mem_limit: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub pids: Option<u32>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Service {
    pub id: String,
    pub name: String,
    /// replicated or global
    pub mode: String,
    pub running: u32,
    pub wanted: u32,
    pub image: String,
    pub project: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct HostContainers {
    pub containers: Vec<Container>,
    pub services: Vec<Service>,
}

/// Container list, one usage sample of the running ones, then the Swarm services (empty off Swarm).
const SCRIPT: &str = r#"LC_ALL=C
command -v docker >/dev/null 2>&1 || { echo '#NODOCKER'; exit 0; }
echo '#PS'
docker ps -a --no-trunc --format '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},"state":{{json .State}},"status":{{json .Status}},"created":{{json .RunningFor}},"ports":{{json .Ports}},"service":{{json (.Label "com.docker.swarm.service.name")}},"stack":{{json (.Label "com.docker.stack.namespace")}},"compose":{{json (.Label "com.docker.compose.project")}}}' 2>&1
echo '#STATS'
docker stats --no-stream --no-trunc --format '{"id":{{json .ID}},"cpu":{{json .CPUPerc}},"mem":{{json .MemUsage}},"net":{{json .NetIO}},"pids":{{json .PIDs}}}' 2>/dev/null
echo '#SERVICES'
docker service ls --format '{"id":{{json .ID}},"name":{{json .Name}},"mode":{{json .Mode}},"replicas":{{json .Replicas}},"image":{{json .Image}}}' 2>/dev/null
echo '#END'
"#;

pub async fn poll(s: &Stats, id: String, target: Target) -> Result<HostContainers, String> {
    let out = stats::exec(s, &id, &target, SCRIPT, 40).await?;
    parse(&out.stdout)
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PsLine {
    id: String,
    name: String,
    image: String,
    state: String,
    status: String,
    created: String,
    ports: String,
    service: String,
    stack: String,
    compose: String,
}

/// Easypanel names its Swarm services `<project>_<service>`; stacks and compose say so in a label.
fn project_of(stack: &str, compose: &str, service: &str) -> String {
    if !stack.is_empty() {
        return stack.to_string();
    }
    if !compose.is_empty() {
        return compose.to_string();
    }
    match service.split_once('_') {
        Some((p, rest)) if !p.is_empty() && !rest.is_empty() => p.to_string(),
        _ => String::new(),
    }
}

/// "12.5MiB", "1.2kB", "0B" in bytes.
pub fn size(text: &str) -> u64 {
    let t = text.trim();
    let split = t.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(t.len());
    let n: f64 = t[..split].parse().unwrap_or(0.0);
    let mult: f64 = match t[split..].trim().to_ascii_lowercase().as_str() {
        "kib" => 1024.0,
        "mib" => 1024.0 * 1024.0,
        "gib" => 1024.0 * 1024.0 * 1024.0,
        "tib" => 1024f64.powi(4),
        "kb" => 1e3,
        "mb" => 1e6,
        "gb" => 1e9,
        "tb" => 1e12,
        _ => 1.0,
    };
    (n * mult) as u64
}

/// "a / b" in two byte counts.
fn pair(text: &str) -> (u64, u64) {
    match text.split_once('/') {
        Some((a, b)) => (size(a), size(b)),
        None => (size(text), 0),
    }
}

fn text(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

pub fn parse(output: &str) -> Result<HostContainers, String> {
    if output.lines().any(|l| l.trim() == "#NODOCKER") {
        return Err("NO_DOCKER|Docker isn't installed on this host".into());
    }
    if !output.contains("#PS") {
        return Err("UNSUPPORTED|This host didn't answer the container check".into());
    }
    let mut res = HostContainers::default();
    let mut section = "";
    let mut problem: Option<String> = None;
    let mut usage: Vec<Value> = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            section = line;
            continue;
        }
        match section {
            "#PS" => match serde_json::from_str::<PsLine>(line) {
                Ok(p) => res.containers.push(Container {
                    project: project_of(&p.stack, &p.compose, &p.service),
                    id: p.id,
                    name: p.name,
                    image: p.image,
                    state: p.state,
                    status: p.status,
                    created: p.created,
                    ports: p.ports,
                    service: p.service,
                    ..Default::default()
                }),
                Err(_) => {
                    if problem.is_none() {
                        problem = Some(line.to_string());
                    }
                }
            },
            "#STATS" => {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    usage.push(v);
                }
            }
            "#SERVICES" => {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    let replicas = text(&v, "replicas");
                    let first = replicas.split_whitespace().next().unwrap_or("");
                    let (running, wanted) = first.split_once('/').unwrap_or(("0", "0"));
                    let name = text(&v, "name");
                    res.services.push(Service {
                        id: text(&v, "id"),
                        project: project_of("", "", &name),
                        name,
                        mode: text(&v, "mode"),
                        running: running.parse().unwrap_or(0),
                        wanted: wanted.parse().unwrap_or(0),
                        image: text(&v, "image"),
                    });
                }
            }
            _ => {}
        }
    }
    if res.containers.is_empty() {
        if let Some(p) = problem {
            let low = p.to_ascii_lowercase();
            if low.contains("permission denied") {
                return Err("DOCKER_PERMISSION|This login can't use Docker (add it to the docker group)".into());
            }
            if low.contains("cannot connect to the docker daemon") || low.contains("is the docker daemon running") {
                return Err("DOCKER_DOWN|Docker is installed but not running".into());
            }
            return Err(format!("DOCKER_ERROR|{p}"));
        }
    }
    for v in usage {
        let id = text(&v, "id");
        if id.is_empty() {
            continue;
        }
        let Some(c) = res.containers.iter_mut().find(|c| c.id.starts_with(&id) || id.starts_with(&c.id)) else {
            continue;
        };
        c.cpu = text(&v, "cpu").trim_end_matches('%').trim().parse().ok();
        (c.mem_used, c.mem_limit) = pair(&text(&v, "mem"));
        (c.net_rx, c.net_tx) = pair(&text(&v, "net"));
        c.pids = text(&v, "pids").trim().parse().ok();
    }
    Ok(res)
}

/// Docker container, service and ID names: letters, digits, `_`, `.` and `-`, starting with a letter or digit.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && name.len() <= 200
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// The command for one action. Swarm services (Easypanel) are stopped by scaling to 0, keeping the
/// replica count in a service label so starting brings the same number back; restarting redeploys them.
pub fn action_script(kind: &str, name: &str, action: &str) -> Result<String, String> {
    if !valid_name(name) {
        return Err("BAD_NAME|That isn't a container or service name".into());
    }
    Ok(match (kind, action) {
        ("container", "start" | "stop" | "restart") => format!("docker {action} {name}"),
        ("service", "restart") => format!("docker service update --detach --force {name}"),
        ("service", "stop") => format!(
            "n=$(docker service inspect -f '{{{{.Spec.Mode.Replicated.Replicas}}}}' {name}) || exit 1; \
case \"$n\" in ''|*[!0-9]*) echo 'Only replicated services can be stopped' >&2; exit 1;; esac; \
if [ \"$n\" -gt 0 ]; then docker service update --detach --label-add shellbox.replicas=$n --replicas 0 {name}; \
else echo 'Already stopped'; fi"
        ),
        ("service", "start") => format!(
            "n=$(docker service inspect -f '{{{{index .Spec.Labels \"shellbox.replicas\"}}}}' {name} 2>/dev/null); \
case \"$n\" in ''|*[!0-9]*|0) n=1;; esac; docker service update --detach --replicas \"$n\" {name}"
        ),
        _ => return Err("BAD_ACTION|Unknown action".into()),
    })
}

pub async fn action(s: &Stats, id: String, target: Target, kind: String, name: String, action: String) -> Result<String, String> {
    let script = action_script(&kind, &name, &action)?;
    let out = stats::exec(s, &id, &target, &script, 90).await?;
    if out.code.unwrap_or(0) != 0 {
        let msg = [out.stderr.trim(), out.stdout.trim()].into_iter().find(|m| !m.is_empty()).unwrap_or("The command failed");
        return Err(format!("ACTION_FAILED|{msg}"));
    }
    Ok(out.stdout.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const EASYPANEL: &str = r##"#PS
{"id":"a1b2c3d4e5f6a7b8","name":"goopedir_api.1.xyz","image":"easypanel/goopedir/api:latest","state":"running","status":"Up 3 hours","created":"3 hours ago","ports":"","service":"goopedir_api","stack":"","compose":""}
{"id":"ffee00112233","name":"goopedir_api.1.old","image":"easypanel/goopedir/api:latest","state":"exited","status":"Exited (0) 3 hours ago","created":"4 hours ago","ports":"","service":"goopedir_api","stack":"","compose":""}
{"id":"0099887766554433","name":"easypanel.1.abc","image":"easypanel/easypanel:latest","state":"running","status":"Up 2 days","created":"2 days ago","ports":"","service":"easypanel","stack":"","compose":""}
{"id":"5555aaaa","name":"redis-local","image":"redis:7","state":"running","status":"Up 5 minutes (healthy)","created":"5 minutes ago","ports":"0.0.0.0:6379->6379/tcp","service":"","stack":"","compose":"cache"}
#STATS
{"id":"a1b2c3d4e5f6a7b8","cpu":"12.50%","mem":"256MiB / 1.5GiB","net":"1.2kB / 3.4MB","pids":"17"}
{"id":"0099887766554433","cpu":"0.30%","mem":"80MiB / 7.6GiB","net":"0B / 0B","pids":"9"}
{"id":"5555aaaa","cpu":"--","mem":"-- / --","net":"-- / --","pids":"--"}
#SERVICES
{"id":"s1","name":"goopedir_api","mode":"replicated","replicas":"1/1","image":"easypanel/goopedir/api:latest"}
{"id":"s2","name":"goopedir_worker","mode":"replicated","replicas":"0/0","image":"easypanel/goopedir/worker:latest"}
{"id":"s3","name":"easypanel","mode":"replicated","replicas":"1/1 (max 1 per node)","image":"easypanel/easypanel:latest"}
#END
"##;

    #[test]
    fn reads_easypanel_swarm() {
        let r = parse(EASYPANEL).unwrap();
        assert_eq!(r.containers.len(), 4);
        let api = &r.containers[0];
        assert_eq!(api.service, "goopedir_api");
        assert_eq!(api.project, "goopedir");
        assert_eq!(api.cpu, Some(12.5));
        assert_eq!(api.mem_used, 256 * 1024 * 1024);
        assert_eq!(api.mem_limit, (1.5 * 1024.0 * 1024.0 * 1024.0) as u64);
        assert_eq!((api.net_rx, api.net_tx), (1200, 3_400_000));
        assert_eq!(api.pids, Some(17));
        assert_eq!(r.containers[1].cpu, None);
        assert_eq!(r.containers[2].project, "");
        let redis = &r.containers[3];
        assert_eq!(redis.project, "cache");
        assert_eq!(redis.cpu, None);
        assert_eq!(redis.mem_used, 0);
        assert_eq!(r.services.len(), 3);
        assert_eq!((r.services[1].running, r.services[1].wanted), (0, 0));
        assert_eq!(r.services[1].project, "goopedir");
        assert_eq!((r.services[2].running, r.services[2].wanted), (1, 1));
    }

    #[test]
    fn plain_docker_without_swarm() {
        let r = parse("#PS\n#STATS\n#SERVICES\n#END\n").unwrap();
        assert!(r.containers.is_empty() && r.services.is_empty());
    }

    #[test]
    fn docker_problems() {
        assert!(parse("#NODOCKER\n").unwrap_err().starts_with("NO_DOCKER|"));
        let denied = "#PS\npermission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n#STATS\n#SERVICES\n#END\n";
        assert!(parse(denied).unwrap_err().starts_with("DOCKER_PERMISSION|"));
        let down = "#PS\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n#STATS\n#SERVICES\n#END\n";
        assert!(parse(down).unwrap_err().starts_with("DOCKER_DOWN|"));
        assert!(parse("").unwrap_err().starts_with("UNSUPPORTED|"));
    }

    #[test]
    fn sizes() {
        assert_eq!(size("0B"), 0);
        assert_eq!(size("1.5kB"), 1500);
        assert_eq!(size("2KiB"), 2048);
        assert_eq!(size(" 1GiB "), 1 << 30);
        assert_eq!(size("--"), 0);
    }

    #[test]
    fn names_and_actions() {
        assert!(valid_name("goopedir_api.1.xyz"));
        assert!(valid_name("a1b2c3"));
        assert!(!valid_name("x; rm -rf /"));
        assert!(!valid_name("-flag"));
        assert!(!valid_name("$(id)"));
        assert!(!valid_name(""));
        assert_eq!(action_script("container", "web", "restart").unwrap(), "docker restart web");
        assert!(action_script("service", "goopedir_api", "stop").unwrap().contains("--replicas 0 goopedir_api"));
        assert!(action_script("service", "goopedir_api", "stop").unwrap().contains("'{{.Spec.Mode.Replicated.Replicas}}'"));
        assert!(action_script("service", "goopedir_api", "start").unwrap().contains("--replicas \"$n\" goopedir_api"));
        assert_eq!(action_script("service", "goopedir_api", "restart").unwrap(), "docker service update --detach --force goopedir_api");
        assert!(action_script("container", "web", "rm").is_err());
        assert!(action_script("container", "a b", "stop").is_err());
    }
}

/// Reads the containers of a saved host for real: `SHELLBOX_DIAG="<host label>" cargo test diag_containers -- --ignored --nocapture`.
/// Uses the saved password and the host keys already in Known Hosts; prints names and numbers only.
#[cfg(test)]
#[tokio::test]
#[ignore]
async fn diag_containers() {
    let label = std::env::var("SHELLBOX_DIAG").expect("set SHELLBOX_DIAG to a host label");
    let path = dirs::data_dir().unwrap().join("Shellbox").join("vault.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
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
    let started = std::time::Instant::now();
    match poll(&s, "diag".into(), t).await {
        Ok(r) => {
            println!("read in {:?}: {} containers, {} services", started.elapsed(), r.containers.len(), r.services.len());
            for sv in &r.services {
                println!("  service {:40} {}/{} project={:?}", sv.name, sv.running, sv.wanted, sv.project);
            }
            for c in &r.containers {
                println!("  {:9} {:45} cpu={:?} mem={}MB svc={:?}", c.state, c.name, c.cpu, c.mem_used / 1048576, c.service);
            }
        }
        Err(e) => println!("error: {e}"),
    }
}
