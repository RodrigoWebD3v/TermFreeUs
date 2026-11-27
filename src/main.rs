// Shellbox: a free SSH client laid out like the one the person is used to.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod containers;
mod dba;
mod forward;
mod keys;
mod live;
mod monitor;
mod sftp;
mod shot;
mod ssh;
mod stats;
mod term;
mod traefik;
#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

type Terms = Arc<term::Terms>;
type Sftps = Arc<sftp::Sftps>;
type Forwards = Arc<forward::Forwards>;
type Usage = Arc<stats::Stats>;
type Proxies = Arc<traefik::Traefik>;

static UI_READY: AtomicBool = AtomicBool::new(false);

fn data_file() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("Shellbox").join("vault.json")
}

// ---------- saved data ----------

#[tauri::command]
fn data_load() -> String {
    // Hosts live in the user's data folder, not next to the program, so they survive moving or
    // replacing the .exe. If the file is missing or unreadable, the backup of the previous save is used.
    let path = data_file();
    let valid = |t: &String| serde_json::from_str::<serde_json::Value>(t).is_ok();
    match std::fs::read_to_string(&path) {
        Ok(t) if valid(&t) => t,
        _ => std::fs::read_to_string(path.with_extension("json.bak")).ok().filter(valid).unwrap_or_default(),
    }
}

#[tauri::command]
fn data_save(json: String) -> Result<(), String> {
    let path = data_file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn data_location() -> String {
    data_file().display().to_string()
}

// ---------- terminals ----------

#[tauri::command]
async fn term_open_ssh(
    app: AppHandle,
    terms: State<'_, Terms>,
    id: String,
    target: ssh::Target,
    cols: u32,
    rows: u32,
    term_type: String,
    env: Vec<(String, String)>,
) -> Result<(), String> {
    term::open_ssh(app, terms.inner().clone(), id, target, cols, rows, term_type, env).await
}

#[tauri::command]
fn term_open_local(app: AppHandle, terms: State<'_, Terms>, id: String, shell: String, cols: u16, rows: u16) -> Result<(), String> {
    term::open_local(app, terms.inner().clone(), id, shell, cols, rows)
}

#[tauri::command]
fn term_open_serial(app: AppHandle, terms: State<'_, Terms>, id: String, path: String, baud: u32) -> Result<(), String> {
    term::open_serial(app, terms.inner().clone(), id, path, baud)
}

#[tauri::command]
fn term_write(terms: State<'_, Terms>, id: String, data: String) -> Result<(), String> {
    term::write(&terms, &id, data.into_bytes())
}

#[tauri::command]
fn term_resize(terms: State<'_, Terms>, id: String, cols: u32, rows: u32) {
    term::resize(&terms, &id, cols, rows)
}

#[tauri::command]
fn term_close(terms: State<'_, Terms>, id: String) {
    term::close(&terms, &id)
}

#[tauri::command]
fn serial_ports() -> Vec<String> {
    serialport::available_ports().map(|v| v.into_iter().map(|p| p.port_name).collect()).unwrap_or_default()
}

#[tauri::command]
fn default_shell() -> String {
    term::default_shell()
}

// ---------- SFTP ----------

#[tauri::command]
async fn sftp_connect(s: State<'_, Sftps>, id: String, target: ssh::Target) -> Result<String, String> {
    sftp::connect(&s, id, target).await
}

#[tauri::command]
async fn sftp_list(s: State<'_, Sftps>, id: String, path: String) -> Result<Vec<sftp::Entry>, String> {
    sftp::list(&s, &id, &path).await
}

#[tauri::command]
async fn sftp_mkdir(s: State<'_, Sftps>, id: String, path: String) -> Result<(), String> {
    sftp::mkdir(&s, &id, &path).await
}

#[tauri::command]
async fn sftp_rename(s: State<'_, Sftps>, id: String, from: String, to: String) -> Result<(), String> {
    sftp::rename(&s, &id, &from, &to).await
}

#[tauri::command]
async fn sftp_remove(s: State<'_, Sftps>, id: String, path: String) -> Result<(), String> {
    sftp::remove(&s, &id, &path).await
}

#[tauri::command]
async fn sftp_download(app: AppHandle, s: State<'_, Sftps>, id: String, remote: String, local_dir: String) -> Result<(), String> {
    sftp::download(&app, &s, &id, &remote, &local_dir).await
}

#[tauri::command]
async fn sftp_upload(app: AppHandle, s: State<'_, Sftps>, id: String, local: String, remote_dir: String) -> Result<(), String> {
    sftp::upload(&app, &s, &id, &local, &remote_dir).await
}

#[tauri::command]
fn sftp_close(s: State<'_, Sftps>, id: String) {
    sftp::close(&s, &id)
}

#[tauri::command]
fn local_home() -> String {
    dirs::home_dir().map(|p| p.display().to_string()).unwrap_or_else(|| "/".into())
}

#[tauri::command]
fn local_list(path: String) -> Result<Vec<sftp::Entry>, String> {
    sftp::local_list(&path)
}

#[tauri::command]
fn local_mkdir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn local_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| e.to_string())
}

#[tauri::command]
fn local_remove(path: String) -> Result<(), String> {
    sftp::local_remove(&path)
}

#[tauri::command]
fn local_copy(from: String, to_dir: String) -> Result<(), String> {
    let src = PathBuf::from(&from);
    let name = src.file_name().ok_or("bad path")?;
    copy_rec(&src, &PathBuf::from(to_dir).join(name))
}

fn copy_rec(src: &PathBuf, dst: &PathBuf) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            copy_rec(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
    }
}

// ---------- port forwarding ----------

#[tauri::command]
async fn pf_start(app: AppHandle, f: State<'_, Forwards>, id: String, target: ssh::Target, rule: forward::Rule) -> Result<(), String> {
    forward::start(app, f.inner().clone(), id, target, rule).await
}

#[tauri::command]
fn pf_stop(f: State<'_, Forwards>, id: String) -> bool {
    forward::stop(&f, &id)
}

// ---------- host usage on the host cards ----------

#[tauri::command]
async fn host_stats(st: State<'_, Usage>, id: String, target: ssh::Target) -> Result<stats::HostStats, String> {
    stats::poll(&st, id, target).await
}

#[tauri::command]
async fn host_stats_forget(st: State<'_, Usage>, id: Option<String>) -> Result<(), String> {
    match id {
        Some(id) => stats::forget(&st, &id).await,
        None => stats::forget_all(&st).await,
    }
    Ok(())
}

// ---------- Servers screen (live numbers) ----------

#[tauri::command]
async fn host_monitor(st: State<'_, Usage>, id: String, target: ssh::Target) -> Result<monitor::HostMonitor, String> {
    monitor::poll(&st, id, target).await
}

#[tauri::command]
async fn host_traefik(st: State<'_, Usage>, tr: State<'_, Proxies>, id: String, target: ssh::Target) -> Result<traefik::Batch, String> {
    traefik::poll(&tr, &st, id, target).await
}

#[tauri::command]
async fn host_traefik_forget(tr: State<'_, Proxies>, id: String) -> Result<(), String> {
    traefik::forget(&tr, &id).await;
    Ok(())
}

// ---------- containers (Docker / Easypanel) ----------

#[tauri::command]
async fn host_containers(st: State<'_, Usage>, id: String, target: ssh::Target) -> Result<containers::HostContainers, String> {
    containers::poll(&st, id, target).await
}

#[tauri::command]
async fn container_action(
    st: State<'_, Usage>,
    id: String,
    target: ssh::Target,
    kind: String,
    name: String,
    action: String,
) -> Result<String, String> {
    containers::action(&st, id, target, kind, name, action).await
}

// ---------- databases (PostgreSQL, MySQL, Redis in Docker) ----------

#[tauri::command]
async fn host_databases(st: State<'_, Usage>, id: String, target: ssh::Target) -> Result<dba::HostDatabases, String> {
    dba::poll(&st, id, target).await
}

#[tauri::command]
async fn redis_flush(st: State<'_, Usage>, id: String, target: ssh::Target, container: String) -> Result<String, String> {
    dba::flush(&st, id, target, container).await
}

// ---------- keychain ----------

#[tauri::command]
async fn key_generate(kind: String, passphrase: String, comment: String) -> Result<keys::KeyPair, String> {
    tauri::async_runtime::spawn_blocking(move || keys::generate(&kind, &passphrase, &comment))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn local_ssh_keys() -> Vec<keys::LocalKey> {
    tauri::async_runtime::spawn_blocking(keys::scan_local).await.unwrap_or_default()
}

#[tauri::command]
fn key_inspect(private_key: String, passphrase: String) -> Result<keys::KeyPair, String> {
    keys::inspect(&private_key, &passphrase)
}

// ---------- files and windows ----------

#[tauri::command]
async fn pick_files(title: String, folder: bool, multiple: bool) -> Vec<String> {
    let dlg = rfd::AsyncFileDialog::new().set_title(&title);
    let picked = if folder {
        dlg.pick_folder().await.map(|f| vec![f])
    } else if multiple {
        dlg.pick_files().await
    } else {
        dlg.pick_file().await.map(|f| vec![f])
    };
    picked.unwrap_or_default().into_iter().map(|f| f.path().display().to_string()).collect()
}

#[tauri::command]
async fn save_text_file(title: String, name: String, contents: String) -> Result<bool, String> {
    let Some(f) = rfd::AsyncFileDialog::new().set_title(&title).set_file_name(&name).save_file().await else {
        return Ok(false);
    };
    std::fs::write(f.path(), contents).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let path = if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir().map(|h| h.join(rest)).unwrap_or_else(|| PathBuf::from(&path))
    } else {
        PathBuf::from(&path)
    };
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_settings(app: AppHandle, section: Option<String>) -> Result<(), String> {
    let hash = section.unwrap_or_else(|| "terminal".into());
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.eval(&format!("window.location.hash = '#settings/{hash}'"));
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(format!("index.html#settings/{hash}").into()))
        .title("Settings")
        .inner_size(1100.0, 680.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// For checks: a `user@host` to quick-connect to while taking a screenshot.
#[tauri::command]
fn shot_quick() -> String {
    std::env::var("SHELLBOX_SHOT_QUICK").unwrap_or_default()
}

#[tauri::command]
fn ui_ready() {
    UI_READY.store(true, Ordering::SeqCst);
}

fn screenshot_arg() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--screenshot")?;
    args.get(i + 1).map(PathBuf::from)
}

/// Closes every connection; the window calls it when it (re)loads.
#[tauri::command]
fn sessions_reset(terms: State<'_, Terms>, s: State<'_, Sftps>, f: State<'_, Forwards>) {
    let ids: Vec<String> = terms.ssh.lock().unwrap().keys().cloned()
        .chain(terms.local.lock().unwrap().keys().cloned())
        .chain(terms.serial.lock().unwrap().keys().cloned())
        .collect();
    for id in ids {
        term::close(&terms, &id);
    }
    s.open.lock().unwrap().clear();
    let pf: Vec<String> = f.running.lock().unwrap().keys().cloned().collect();
    for id in pf {
        forward::stop(&f, &id);
    }
}

fn main() {
    let shot = screenshot_arg();
    if shot.is_none() && live::relaunch_from_copy() {
        return;
    }
    let mut context = tauri::generate_context!();
    let live_dir = live::ui_dir();
    if let Some(dir) = &live_dir {
        let embedded = context.set_assets(Box::new(live::NoAssets));
        context.set_assets(Box::new(live::LiveAssets { dir: dir.clone(), fallback: embedded }));
    }
    let watch_live = live_dir.filter(|_| shot.is_none());
    tauri::Builder::default()
        .manage(Terms::default())
        .manage(Sftps::default())
        .manage(Forwards::default())
        .manage(Usage::default())
        .manage(Proxies::default())
        .invoke_handler(tauri::generate_handler![
            data_load, data_save, data_location,
            term_open_ssh, term_open_local, term_open_serial, term_write, term_resize, term_close,
            serial_ports, default_shell,
            sftp_connect, sftp_list, sftp_mkdir, sftp_rename, sftp_remove, sftp_download, sftp_upload, sftp_close,
            local_home, local_list, local_mkdir, local_rename, local_remove, local_copy,
            pf_start, pf_stop, key_generate, key_inspect, local_ssh_keys, host_stats, host_stats_forget,
            host_containers, container_action, host_databases, redis_flush, host_monitor, host_traefik, host_traefik_forget,
            pick_files, save_text_file, read_text_file, open_settings, ui_ready, shot_quick, sessions_reset
        ])
        .setup(move |app| {
            // SHELLBOX_SHOT_VIEW picks another screen for the picture (keychain, sftp, local, newhost...).
            let view = std::env::var("SHELLBOX_SHOT_VIEW").unwrap_or_default();
            let url = match (&shot, view.is_empty()) {
                (Some(_), true) => "index.html#screenshot".to_string(),
                (Some(_), false) => format!("index.html#screenshot/{view}"),
                (None, _) => "index.html".to_string(),
            };
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.as_str().into()))
                .title("Shellbox")
                .inner_size(1280.0, 800.0)
                .min_inner_size(600.0, 440.0)
                .decorations(false)
                .center();
            if shot.is_some() {
                builder = builder.focused(false);
                #[cfg(windows)]
                {
                    builder = builder.always_on_bottom(true);
                }
            }
            let window = builder.build()?;
            if let Some(dir) = watch_live.clone() {
                live::watch(app.handle().clone(), dir);
            }
            if let Some(out) = shot.clone() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let start = Instant::now();
                    while !UI_READY.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(30) {
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    // About 120 frames at 60 frames per second (checks may ask for longer to drive the page).
                    let hold = std::env::var("SHELLBOX_SHOT_HOLD_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(2000u64);
                    std::thread::sleep(Duration::from_millis(hold.min(120_000)));
                    #[cfg(windows)]
                    let hwnd = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
                    #[cfg(not(windows))]
                    let hwnd = 0isize;
                    let code = match shot::capture(hwnd, &out) {
                        Ok(()) => 0,
                        Err(e) => {
                            eprintln!("screenshot failed: {e}");
                            1
                        }
                    };
                    handle.exit(code);
                });
            }
            Ok(())
        })
        .run(context)
        .expect("error while running the app");
}
