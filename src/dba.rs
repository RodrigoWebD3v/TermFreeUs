//! Databases screen: PostgreSQL, MySQL / MariaDB and Redis running as Docker containers on a host.
//!
//! Read over the same quiet SSH connection the usage line keeps open (see `stats`). Nothing is installed
//! and no database port is opened: the clients that ship inside each database image (`psql`, `mysql`,
//! `redis-cli`) run through `docker exec`, signed in with the container's own environment (the same
//! variables its image uses to create the first user). Every query is fixed in the script below and
//! only reads; nothing the person types ever reaches the shell.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::ssh::Target;
use crate::stats::{self, Stats};

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Database {
    pub name: String,
    /// Bytes on disk (PostgreSQL, MySQL); 0 for Redis.
    pub size: u64,
    /// Open connections (PostgreSQL), tables (MySQL) or keys (Redis).
    pub count: u64,
}

/// One statement running right now (PostgreSQL, MySQL).
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Activity {
    pub id: String,
    pub db: String,
    pub user: String,
    pub state: String,
    pub secs: u64,
    pub query: String,
}

/// One entry of the Redis slow log.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Slow {
    pub at: u64,
    pub micros: u64,
    pub command: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Instance {
    /// postgres, mysql or redis
    pub kind: String,
    pub id: String,
    pub name: String,
    pub image: String,
    pub version: String,
    /// "CODE|text" when this database couldn't be read.
    pub error: Option<String>,
    /// Numbers for the tiles. Counters (queries, commits) are raw: the screen turns them into rates.
    pub metrics: BTreeMap<String, f64>,
    /// Redis role (master or replica).
    pub role: String,
    pub databases: Vec<Database>,
    pub activity: Vec<Activity>,
    pub slow: Vec<Slow>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct HostDatabases {
    pub instances: Vec<Instance>,
}

/// For every running container whose image is a database, one `docker exec` that runs a fixed script of
/// read-only queries. Section markers (`@@Q name`) split the answers.
const SCRIPT: &str = r#"LC_ALL=C
command -v docker >/dev/null 2>&1 || { echo '@@NODOCKER'; exit 0; }
docker ps --format '{{.ID}}|{{.Names}}|{{.Image}}' 2>&1 </dev/null | while IFS='|' read -r id name img; do
  case "$id" in ''|*[!0-9a-f]*) echo "@@DOCKERERR $id"; continue;; esac
  r=${img##*/}; r=${r%%@*}; r=${r%%:*}
  case "$r" in
    postgres|postgresql|postgis|timescaledb|timescaledb-ha|pgvector) k=postgres;;
    mysql|mariadb|mysql-server|percona-server) k=mysql;;
    redis|redis-stack|redis-stack-server|valkey|keydb) k=redis;;
    *) continue;;
  esac
  echo "@@I|$k|$id|$name|$img"
  case "$k" in
  postgres)
    docker exec -i "$id" sh -c 'PGPASSWORD="${POSTGRES_PASSWORD:-$POSTGRESQL_PASSWORD}" exec psql -U "${POSTGRES_USER:-${POSTGRESQL_USERNAME:-postgres}}" -d "${POSTGRES_DB:-${POSTGRESQL_DATABASE:-postgres}}" -X -q -A -t -F "|"' 2>&1 <<'SQL'
\echo @@Q info
select split_part(version(),' ',2), extract(epoch from now()-pg_postmaster_start_time())::bigint, current_setting('max_connections'), (select count(*) from pg_stat_activity where datname is not null), (select count(*) from pg_stat_activity where state='active' and pid<>pg_backend_pid()), (select count(*) from pg_stat_activity where state like 'idle in transaction%'), (select count(*) from pg_locks where not granted), (select coalesce(sum(xact_commit),0) from pg_stat_database), (select coalesce(sum(xact_rollback),0) from pg_stat_database), (select coalesce(sum(deadlocks),0) from pg_stat_database), (select case when sum(blks_hit+blks_read)=0 then 100 else round(100.0*sum(blks_hit)/sum(blks_hit+blks_read),2) end from pg_stat_database), (select coalesce(sum(pg_database_size(oid)),0) from pg_database where not datistemplate);
\echo @@Q dbs
select datname, pg_database_size(datname), numbackends from pg_stat_database where datname is not null and datname not in ('template0','template1') order by 2 desc limit 20;
\echo @@Q act
select pid, coalesce(datname,''), coalesce(usename,''), state, coalesce(extract(epoch from now()-query_start)::bigint,0), left(regexp_replace(coalesce(query,''),'\s+',' ','g'),200) from pg_stat_activity where state is not null and state<>'idle' and pid<>pg_backend_pid() order by query_start asc nulls last limit 15;
SQL
    ;;
  mysql)
    docker exec -i "$id" sh -c 'u=root; p="${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}"; if [ -z "$p" ] && [ -n "$MYSQL_USER" ]; then u="$MYSQL_USER"; p="$MYSQL_PASSWORD"; fi; b=$(command -v mysql || command -v mariadb); MYSQL_PWD="$p" exec "$b" -u"$u" -N -B' 2>&1 <<'SQL'
SELECT '@@Q info';
SELECT VERSION();
SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries','Aborted_connects','Aborted_clients','Bytes_received','Bytes_sent','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Max_used_connections','Innodb_row_lock_current_waits','Created_tmp_disk_tables');
SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections','innodb_buffer_pool_size');
SELECT '@@Q dbs';
SELECT table_schema, COALESCE(SUM(data_length+index_length),0), COUNT(*) FROM information_schema.tables GROUP BY table_schema ORDER BY 2 DESC LIMIT 20;
SELECT '@@Q act';
SELECT id, COALESCE(user,''), COALESCE(db,''), CONCAT(command, IF(COALESCE(state,'')='','',CONCAT(' / ',state))), time, REPLACE(REPLACE(LEFT(COALESCE(info,''),200),CHAR(10),' '),CHAR(9),' ') FROM information_schema.processlist WHERE command<>'Sleep' AND id<>CONNECTION_ID() ORDER BY time DESC LIMIT 15;
SQL
    ;;
  redis)
    pw=$(docker inspect -f '{{join .Config.Cmd " "}} {{join .Args " "}}' "$id" 2>/dev/null </dev/null | sed -n 's/.*--requirepass[ =][ =]*\([^ ]*\).*/\1/p')
    pw=$(printf %s "$pw" | tr -d "\"'")
    case "$pw" in *\$*|*\\*) pw="";; esac
    ea=""; [ -n "$pw" ] && ea="-e REDISCLI_AUTH=$pw"
    docker exec $ea "$id" sh -c '[ -n "$REDISCLI_AUTH" ] || REDISCLI_AUTH="$REDIS_PASSWORD"; if [ -n "$REDISCLI_AUTH" ]; then export REDISCLI_AUTH; else unset REDISCLI_AUTH; fi; redis-cli INFO; echo "@@Q slow"; redis-cli --no-raw SLOWLOG GET 10' 2>&1 </dev/null
    ;;
  esac
done
echo '@@END'
"#;

pub async fn poll(s: &Stats, id: String, target: Target) -> Result<HostDatabases, String> {
    let out = stats::exec(s, &id, &target, SCRIPT, 60).await?;
    parse(&out.stdout)
}

/// The only write this screen can make: empty a Redis server. It takes the container's ID (hex only),
/// checks that the container really runs Redis, then runs `FLUSHALL ASYNC` and asks the allocator to give
/// the freed memory back (`MEMORY PURGE`), which is what actually lowers the RAM the server holds.
pub fn flush_script(container: &str) -> Result<String, String> {
    if container.is_empty() || container.len() > 64 || !container.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("BAD_NAME|That isn't a container ID".into());
    }
    Ok(format!(
        r#"id={container}
img=$(docker inspect -f '{{{{.Config.Image}}}}' "$id" 2>/dev/null </dev/null) || {{ echo 'No such container' >&2; exit 1; }}
r=${{img##*/}}; r=${{r%%@*}}; r=${{r%%:*}}
case "$r" in redis|redis-stack|redis-stack-server|valkey|keydb) ;; *) echo 'That container is not a Redis server' >&2; exit 1;; esac
pw=$(docker inspect -f '{{{{join .Config.Cmd " "}}}} {{{{join .Args " "}}}}' "$id" 2>/dev/null </dev/null | sed -n 's/.*--requirepass[ =][ =]*\([^ ]*\).*/\1/p')
pw=$(printf %s "$pw" | tr -d "\"'")
case "$pw" in *\$*|*\*) pw="";; esac
ea=""; [ -n "$pw" ] && ea="-e REDISCLI_AUTH=$pw"
docker exec $ea "$id" sh -c '[ -n "$REDISCLI_AUTH" ] || REDISCLI_AUTH="$REDIS_PASSWORD"; if [ -n "$REDISCLI_AUTH" ]; then export REDISCLI_AUTH; else unset REDISCLI_AUTH; fi; redis-cli FLUSHALL ASYNC; redis-cli MEMORY PURGE >/dev/null 2>&1; true' 2>&1 </dev/null
"#
    ))
}

pub async fn flush(s: &Stats, id: String, target: Target, container: String) -> Result<String, String> {
    let script = flush_script(&container)?;
    let out = stats::exec(s, &id, &target, &script, 60).await?;
    let first = out.stdout.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if first == "OK" {
        return Ok("OK".into());
    }
    let msg = [first, out.stderr.trim()].into_iter().find(|m| !m.is_empty()).unwrap_or("The command failed");
    Err(format!("ACTION_FAILED|{msg}"))
}

/// What one instance printed, split by `@@Q` markers.
#[derive(Default)]
struct Raw {
    inst: Instance,
    sections: BTreeMap<String, Vec<String>>,
    loose: Vec<String>,
}

impl Raw {
    fn lines(&self, name: &str) -> &[String] {
        self.sections.get(name).map(|v| v.as_slice()).unwrap_or(&[])
    }
}

fn num(s: &str) -> f64 {
    s.trim().parse().unwrap_or(0.0)
}

fn int(s: &str) -> u64 {
    let t = s.trim();
    t.parse::<u64>().unwrap_or_else(|_| t.parse::<f64>().map(|f| f.max(0.0) as u64).unwrap_or(0))
}

/// The first line that says why a database couldn't be read.
fn problem(lines: &[&str]) -> Option<String> {
    for l in lines {
        let low = l.to_ascii_lowercase();
        if low.contains("password authentication failed")
            || low.contains("access denied")
            || low.contains("noauth")
            || low.contains("wrongpass")
            || low.contains("authentication required")
            || low.contains("no password supplied")
        {
            return Some(format!("AUTH|{}", l.trim()));
        }
    }
    for l in lines {
        let low = l.to_ascii_lowercase();
        if low.starts_with("psql:") || low.starts_with("error") || low.starts_with("fatal")
            || low.contains("could not connect") || low.contains("can't connect") || low.contains("connection refused")
            || low.contains("executable file not found") || low.contains("not found") || low.contains("no such")
            || low.contains("oci runtime") || low.contains("is not running")
        {
            return Some(format!("DB_ERROR|{}", l.trim()));
        }
    }
    None
}

fn parse_postgres(raw: &Raw, i: &mut Instance) {
    let Some(info) = raw.lines("info").iter().find(|l| l.contains('|')) else { return };
    let f: Vec<&str> = info.splitn(12, '|').collect();
    if f.len() < 12 {
        return;
    }
    i.version = f[0].trim().to_string();
    for (k, v) in ["uptime", "max_connections", "connections", "active", "idle_in_tx", "blocked", "xact_commit", "xact_rollback", "deadlocks", "cache_hit", "size"]
        .into_iter()
        .zip(&f[1..])
    {
        i.metrics.insert(k.into(), num(v));
    }
    for l in raw.lines("dbs") {
        let f: Vec<&str> = l.splitn(3, '|').collect();
        if f.len() == 3 {
            i.databases.push(Database { name: f[0].into(), size: int(f[1]), count: int(f[2]) });
        }
    }
    for l in raw.lines("act") {
        let f: Vec<&str> = l.splitn(6, '|').collect();
        if f.len() == 6 {
            i.activity.push(Activity { id: f[0].into(), db: f[1].into(), user: f[2].into(), state: f[3].into(), secs: int(f[4]), query: f[5].trim().into() });
        }
    }
}

fn parse_mysql(raw: &Raw, i: &mut Instance) {
    let info = raw.lines("info");
    let Some(version) = info.iter().find(|l| !l.contains('\t')) else { return };
    i.version = version.trim().to_string();
    for l in info {
        if let Some((k, v)) = l.split_once('\t') {
            if let Ok(n) = v.trim().parse::<f64>() {
                i.metrics.insert(k.trim().to_ascii_lowercase(), n);
            }
        }
    }
    let reads = i.metrics.get("innodb_buffer_pool_reads").copied().unwrap_or(0.0);
    let reqs = i.metrics.get("innodb_buffer_pool_read_requests").copied().unwrap_or(0.0);
    if reqs > 0.0 {
        i.metrics.insert("cache_hit".into(), ((1.0 - reads / reqs) * 100.0).clamp(0.0, 100.0));
    }
    for l in raw.lines("dbs") {
        let f: Vec<&str> = l.split('\t').collect();
        if f.len() == 3 {
            i.databases.push(Database { name: f[0].into(), size: int(f[1]), count: int(f[2]) });
        }
    }
    for l in raw.lines("act") {
        let f: Vec<&str> = l.splitn(6, '\t').collect();
        if f.len() == 6 {
            i.activity.push(Activity { id: f[0].into(), user: f[1].into(), db: f[2].into(), state: f[3].into(), secs: int(f[4]), query: f[5].trim().into() });
        }
    }
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    s.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(s).replace("\\\"", "\"")
}

/// Entries of `redis-cli --no-raw SLOWLOG GET`, a numbered tree:
/// `1) 1) (integer) 14` / `   2) (integer) <unix time>` / `   3) (integer) <microseconds>` / `   4) 1) "get"` ...
fn parse_slowlog(lines: &[String]) -> Vec<Slow> {
    let mut out: Vec<Slow> = Vec::new();
    let mut args_indent: Option<usize> = None;
    let mut args: Vec<String> = Vec::new();
    let flush = |out: &mut Vec<Slow>, args: &mut Vec<String>| {
        if let Some(last) = out.last_mut() {
            if last.command.is_empty() {
                let mut c = args.join(" ");
                c.truncate(c.char_indices().nth(200).map(|(i, _)| i).unwrap_or(c.len()));
                last.command = c;
            }
        }
        args.clear();
    };
    for line in lines {
        let indent = line.len() - line.trim_start().len();
        let t = line.trim();
        if t.split_once(") 1) (integer) ").is_some_and(|(a, _)| !a.is_empty() && a.chars().all(|c| c.is_ascii_digit())) {
            flush(&mut out, &mut args);
            args_indent = None;
            out.push(Slow::default());
        } else if let Some(v) = t.strip_prefix("2) (integer) ") {
            if let Some(s) = out.last_mut() {
                s.at = int(v);
            }
        } else if let Some(v) = t.strip_prefix("3) (integer) ") {
            if let Some(s) = out.last_mut() {
                s.micros = int(v);
            }
        } else if let Some(v) = t.strip_prefix("4) 1) ") {
            args_indent = Some(indent);
            args.push(unquote(v));
        } else if let Some(ai) = args_indent {
            if indent > ai {
                if let Some((_, v)) = t.split_once(") ") {
                    args.push(unquote(v));
                }
            } else {
                flush(&mut out, &mut args);
                args_indent = None;
            }
        }
    }
    flush(&mut out, &mut args);
    out
}

fn parse_redis(raw: &Raw, i: &mut Instance) {
    let mut info: BTreeMap<&str, &str> = BTreeMap::new();
    for l in raw.lines("info") {
        if let Some((k, v)) = l.split_once(':') {
            info.insert(k.trim(), v.trim());
        }
    }
    let Some(version) = info.get("redis_version").or(info.get("valkey_version")) else { return };
    i.version = version.to_string();
    i.role = info.get("role").map(|s| s.to_string()).unwrap_or_default();
    for (key, name) in [
        ("uptime_in_seconds", "uptime"),
        ("connected_clients", "clients"),
        ("blocked_clients", "blocked"),
        ("used_memory", "memory"),
        ("maxmemory", "maxmemory"),
        ("mem_fragmentation_ratio", "fragmentation"),
        ("instantaneous_ops_per_sec", "ops"),
        ("keyspace_hits", "hits"),
        ("keyspace_misses", "misses"),
        ("evicted_keys", "evicted"),
        ("expired_keys", "expired"),
        ("connected_slaves", "replicas"),
        ("rdb_changes_since_last_save", "unsaved"),
        ("total_commands_processed", "commands"),
    ] {
        if let Some(v) = info.get(key).and_then(|v| v.parse::<f64>().ok()) {
            i.metrics.insert(name.into(), v);
        }
    }
    let (hits, misses) = (i.metrics.get("hits").copied().unwrap_or(0.0), i.metrics.get("misses").copied().unwrap_or(0.0));
    if hits + misses > 0.0 {
        i.metrics.insert("hit_rate".into(), hits / (hits + misses) * 100.0);
    }
    if let Some(s) = info.get("rdb_last_bgsave_status") {
        i.metrics.insert("save_failed".into(), if *s == "ok" { 0.0 } else { 1.0 });
    }
    let mut keys_total = 0u64;
    for (k, v) in &info {
        if k.starts_with("db") && k[2..].chars().all(|c| c.is_ascii_digit()) && k.len() > 2 {
            let n = v.split(',').find_map(|p| p.strip_prefix("keys=")).map(int).unwrap_or(0);
            keys_total += n;
            i.databases.push(Database { name: k.to_string(), size: 0, count: n });
        }
    }
    i.databases.sort_by(|a, b| a.name.len().cmp(&b.name.len()).then(a.name.cmp(&b.name)));
    i.metrics.insert("keys".into(), keys_total as f64);
    i.slow = parse_slowlog(raw.lines("slow"));
}

fn finish(raw: Raw) -> Instance {
    let mut i = raw.inst.clone();
    match i.kind.as_str() {
        "postgres" => parse_postgres(&raw, &mut i),
        "mysql" => parse_mysql(&raw, &mut i),
        "redis" => parse_redis(&raw, &mut i),
        _ => {}
    }
    if i.version.is_empty() {
        let all: Vec<&str> = raw.loose.iter().map(|s| s.as_str())
            .chain(raw.sections.values().flat_map(|v| v.iter().map(|s| s.as_str())))
            .filter(|l| !l.trim().is_empty())
            .collect();
        i.error = Some(problem(&all).unwrap_or_else(|| {
            all.first().map(|l| format!("DB_ERROR|{}", l.trim())).unwrap_or_else(|| "DB_ERROR|No answer from the database".into())
        }));
    }
    i
}

pub fn parse(output: &str) -> Result<HostDatabases, String> {
    if output.lines().any(|l| l.trim() == "@@NODOCKER") {
        return Err("NO_DOCKER|Docker isn't installed on this host".into());
    }
    if !output.contains("@@END") {
        return Err("UNSUPPORTED|This host didn't answer the database check".into());
    }
    let mut done: Vec<Raw> = Vec::new();
    let mut cur: Option<Raw> = None;
    let mut section = String::new();
    let mut docker_problem: Option<String> = None;
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix("@@I|") {
            if let Some(r) = cur.take() {
                done.push(r);
            }
            let f: Vec<&str> = rest.splitn(4, '|').collect();
            let kind = f.first().copied().unwrap_or("");
            section = if kind == "redis" { "info".into() } else { String::new() };
            cur = Some(Raw {
                inst: Instance {
                    kind: kind.into(),
                    id: f.get(1).copied().unwrap_or("").into(),
                    name: f.get(2).copied().unwrap_or("").into(),
                    image: f.get(3).copied().unwrap_or("").into(),
                    ..Default::default()
                },
                ..Default::default()
            });
        } else if let Some(name) = line.strip_prefix("@@Q ") {
            section = name.trim().to_string();
        } else if let Some(msg) = line.strip_prefix("@@DOCKERERR") {
            docker_problem.get_or_insert(msg.trim().to_string());
        } else if line.starts_with("@@END") {
            break;
        } else if let Some(r) = cur.as_mut() {
            if line.trim().is_empty() {
                continue;
            }
            if section.is_empty() {
                r.loose.push(line.to_string());
            } else {
                r.sections.entry(section.clone()).or_default().push(line.to_string());
            }
        }
    }
    if let Some(r) = cur.take() {
        done.push(r);
    }
    if done.is_empty() {
        if let Some(p) = docker_problem {
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
    Ok(HostDatabases { instances: done.into_iter().map(finish).collect() })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PG: &str = "@@I|postgres|aa11bb22cc33|shop_db.1.x|postgres:16\n\
@@Q info\n\
16.3|86400|100|12|2|1|0|5000|20|1|99.4|123456789\n\
@@Q dbs\n\
shop|100000000|9\n\
postgres|8000000|1\n\
@@Q act\n\
4242|shop|app|active|7|select * from orders | join items where a = 1\n\
4243|shop|app|idle in transaction|120|update stock set n = n - 1\n";

    const MYSQL: &str = "@@I|mysql|bb22cc33dd44|shop_mysql.1.y|mariadb:11\n\
@@Q info\n\
11.4.2-MariaDB\n\
Aborted_clients\t3\n\
Innodb_buffer_pool_read_requests\t1000\n\
Innodb_buffer_pool_reads\t10\n\
Questions\t55000\n\
Threads_connected\t8\n\
Uptime\t3600\n\
max_connections\t151\n\
@@Q dbs\n\
shop\t5242880\t14\n\
@@Q act\n\
77\tapp\tshop\tQuery / Sending data\t9\tselect count(*) from orders\n";

    const REDIS: &str = "@@I|redis|cc33dd44ee55|cache.1.z|redis:7\r\n\
# Server\r\n\
redis_version:7.2.4\r\n\
uptime_in_seconds:7200\r\n\
# Clients\r\n\
connected_clients:5\r\n\
blocked_clients:0\r\n\
# Memory\r\n\
used_memory:1048576\r\n\
maxmemory:0\r\n\
mem_fragmentation_ratio:1.10\r\n\
# Replication\r\n\
role:master\r\n\
connected_slaves:0\r\n\
# Stats\r\n\
instantaneous_ops_per_sec:42\r\n\
keyspace_hits:90\r\n\
keyspace_misses:10\r\n\
evicted_keys:0\r\n\
# Persistence\r\n\
rdb_last_bgsave_status:ok\r\n\
# Keyspace\r\n\
db0:keys=120,expires=4,avg_ttl=1000\r\n\
db1:keys=3,expires=0,avg_ttl=0\r\n\
@@Q slow\r\n";

    const SLOWLOG: &str = r#"1) 1) (integer) 14
   2) (integer) 1700000000
   3) (integer) 15000
   4) 1) "keys"
      2) "*"
   5) "127.0.0.1:58217"
   6) ""
2) 1) (integer) 13
   2) (integer) 1699999000
   3) (integer) 9000
   4) 1) "get"
      2) "k"
   5) "127.0.0.1:58218"
   6) ""
"#;

    #[test]
    fn reads_postgres() {
        let r = parse(&format!("{PG}@@END\n")).unwrap();
        let i = &r.instances[0];
        assert_eq!((i.kind.as_str(), i.version.as_str(), i.error.clone()), ("postgres", "16.3", None));
        assert_eq!(i.metrics["connections"], 12.0);
        assert_eq!(i.metrics["max_connections"], 100.0);
        assert_eq!(i.metrics["cache_hit"], 99.4);
        assert_eq!(i.databases.len(), 2);
        assert_eq!((i.databases[0].name.as_str(), i.databases[0].size, i.databases[0].count), ("shop", 100_000_000, 9));
        assert_eq!(i.activity.len(), 2);
        // The query is last, so a `|` inside it stays in the text.
        assert_eq!(i.activity[0].query, "select * from orders | join items where a = 1");
        assert_eq!(i.activity[1].secs, 120);
    }

    #[test]
    fn reads_mysql() {
        let r = parse(&format!("{MYSQL}@@END\n")).unwrap();
        let i = &r.instances[0];
        assert_eq!(i.version, "11.4.2-MariaDB");
        assert_eq!(i.metrics["questions"], 55000.0);
        assert_eq!(i.metrics["max_connections"], 151.0);
        assert!((i.metrics["cache_hit"] - 99.0).abs() < 1e-9);
        assert_eq!(i.databases[0].count, 14);
        assert_eq!(i.activity[0].state, "Query / Sending data");
        assert_eq!(i.activity[0].secs, 9);
    }

    #[test]
    fn reads_redis_and_slowlog() {
        let r = parse(&format!("{REDIS}{SLOWLOG}@@END\n")).unwrap();
        let i = &r.instances[0];
        assert_eq!((i.version.as_str(), i.role.as_str()), ("7.2.4", "master"));
        assert_eq!(i.metrics["ops"], 42.0);
        assert_eq!(i.metrics["hit_rate"], 90.0);
        assert_eq!(i.metrics["keys"], 123.0);
        assert_eq!(i.metrics["save_failed"], 0.0);
        assert_eq!(i.databases.len(), 2);
        assert_eq!(i.databases[0].name, "db0");
        assert_eq!(i.slow.len(), 2);
        assert_eq!((i.slow[0].micros, i.slow[0].at, i.slow[0].command.as_str()), (15000, 1_700_000_000, "keys *"));
        assert_eq!(i.slow[1].command, "get k");
    }

    #[test]
    fn several_instances_and_failures() {
        let text = format!(
            "{PG}@@I|redis|dd44ee55ff66|locked.1.q|redis:7\nNOAUTH Authentication required.\n\
@@Q slow\nNOAUTH Authentication required.\n\
@@I|mysql|ee55ff66aa77|bad.1.r|mysql:8\nERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)\n@@END\n"
        );
        let r = parse(&text).unwrap();
        assert_eq!(r.instances.len(), 3);
        assert!(r.instances[0].error.is_none());
        assert!(r.instances[1].error.as_deref().unwrap().starts_with("AUTH|"));
        assert!(r.instances[2].error.as_deref().unwrap().starts_with("AUTH|"));
    }

    #[test]
    fn host_problems() {
        assert!(parse("@@NODOCKER\n").unwrap_err().starts_with("NO_DOCKER|"));
        assert!(parse("").unwrap_err().starts_with("UNSUPPORTED|"));
        assert!(parse("@@END\n").unwrap().instances.is_empty());
        let denied = "@@DOCKERERR permission denied while trying to connect to the Docker daemon socket\n@@END\n";
        assert!(parse(denied).unwrap_err().starts_with("DOCKER_PERMISSION|"));
    }

    #[test]
    fn flush_only_takes_a_container_id() {
        assert!(flush_script("a1b2c3d4e5f6").unwrap().contains("redis-cli FLUSHALL ASYNC"));
        for bad in ["", "web; rm -rf /", "$(id)", "a b", "../x", &"a".repeat(65)] {
            assert!(flush_script(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn scripts_are_valid_shell() {
        // `sh -n` only parses; nothing runs. Skipped where there is no sh.
        for script in [SCRIPT.to_string(), flush_script("a1b2c3").unwrap()] {
            let Ok(mut child) = std::process::Command::new("sh").arg("-n").stdin(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn() else { return };
            std::io::Write::write_all(child.stdin.as_mut().unwrap(), script.as_bytes()).unwrap();
            let out = child.wait_with_output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        }
    }

    #[test]
    fn script_only_reads() {
        // Nothing that changes data may ever be added to the fixed queries.
        let low = SCRIPT.to_ascii_lowercase();
        for bad in ["insert ", "update ", "delete ", "drop ", "alter ", "truncate ", "flushall", "flushdb", "config set", "shutdown", "kill "] {
            assert!(!low.contains(bad), "script contains {bad:?}");
        }
    }
}

/// Reads the databases of a saved host for real: `SHELLBOX_DIAG="<host label>" cargo test diag_databases -- --ignored --nocapture`.
/// Uses the saved password and the host keys already in Known Hosts; prints names and numbers only.
#[cfg(test)]
#[tokio::test]
#[ignore]
async fn diag_databases() {
    use serde_json::Value;
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
    let started = std::time::Instant::now();
    match poll(&Stats::default(), "diag".into(), t).await {
        Ok(r) => {
            println!("read in {:?}: {} databases", started.elapsed(), r.instances.len());
            for i in &r.instances {
                println!("  {:8} {:45} v={} err={:?} dbs={} act={} slow={}", i.kind, i.name, i.version, i.error, i.databases.len(), i.activity.len(), i.slow.len());
                println!("           {:?}", i.metrics);
            }
        }
        Err(e) => println!("error: {e}"),
    }
}
