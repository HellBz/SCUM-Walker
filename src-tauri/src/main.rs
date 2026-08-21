#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use arboard::Clipboard;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::io::{Read, Write};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use tauri::webview::WebviewWindowBuilder;

use crate::http_server::ws_broadcast;

mod http_server;

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    HDC, SRCCOPY,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
#[cfg(windows)]
#[cfg(windows)]
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_CONTROL, VK_C,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClientRect, GetForegroundWindow,
    GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible, SetForegroundWindow,
};

const DEFAULT_INTERVAL_SECONDS: u64 = 10;
const SCUM_WINDOW_TITLES: &[&str] = &["SCUM", "SCUM ", "SCUM Early Access", "SCUM  "];
const SCUM_PROCESS_NAMES: &[&str] = &["scum.exe", "scum-win64-shipping.exe"];

// Erkennt SCUM-Binaries robust (z.B. auch "SCUM_Experimental.exe" oder ähnliche
// Steam-Beta-Branch-Varianten), schließt dabei aber explizit SCUM Walker selbst
// aus ("walker" im Dateinamen) - auch als zusätzliche Absicherung, falls sich
// die exakte Namensliste oben mal nicht deckt.
#[cfg(windows)]
fn is_scum_process_filename(filename_lower: &str) -> bool {
    if filename_lower.contains("walker") {
        return false;
    }
    SCUM_PROCESS_NAMES.iter().any(|n| filename_lower == *n) || filename_lower.starts_with("scum")
}

// SCUM map sector grid: rows north->south D,C,B,A,Z; cols west->east 4,3,2,1,0
const SECTOR_ROWS: &[char] = &['D', 'C', 'B', 'A', 'Z'];
const SECTOR_COLS: &[char] = &['4', '3', '2', '1', '0'];
const SECTOR_WORLD_MIN_X: f64 = -904800.0;
const SECTOR_WORLD_MAX_X: f64 = 619318.0;
const SECTOR_WORLD_MIN_Y: f64 = -904800.0;
const SECTOR_WORLD_MAX_Y: f64 = 618818.0;

fn compute_sector(x: f64, y: f64) -> String {
    let width = SECTOR_WORLD_MAX_X - SECTOR_WORLD_MIN_X;
    let height = SECTOR_WORLD_MAX_Y - SECTOR_WORLD_MIN_Y;
    // SCUM X axis is inverted: X max = west/left (col 4), X min = east/right (col 0)
    let col_idx = ((SECTOR_WORLD_MAX_X - x) / width * SECTOR_COLS.len() as f64)
        .floor()
        .clamp(0.0, (SECTOR_COLS.len() - 1) as f64) as usize;
    let row_idx = ((SECTOR_WORLD_MAX_Y - y) / height * SECTOR_ROWS.len() as f64)
        .floor()
        .clamp(0.0, (SECTOR_ROWS.len() - 1) as f64) as usize;
    format!("{}{}", SECTOR_ROWS[row_idx], SECTOR_COLS[col_idx])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CoordRecord {
    time: DateTime<Utc>,
    x: f64,
    y: f64,
    z: f64,
    pitch: f64,
    yaw: f64,
    roll: f64,
}

const ROUTE_COLORS: &[&str] = &["#00ffcc", "#ff8800", "#4488ff", "#ff44d3", "#ffee00", "#44cc44", "#ff4444", "#ffffff"];

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Route {
    id: String,
    name: String,
    color: String,
    #[serde(default = "default_true")]
    visible: bool,
    records: Vec<CoordRecord>,
}

impl Route {
    fn new(name: String, color: String) -> Self {
        Self {
            id: format!("{}", Utc::now().timestamp_millis()),
            name,
            color,
            visible: true,
            records: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Poi {
    id: String,
    label: String,
    x: f64,
    y: f64,
    #[serde(rename = "type")]
    poi_type: String,
    color: String,
    #[serde(default)]
    image_path: Option<String>,
    #[serde(default = "default_poi_category")]
    category: String,
}

fn default_poi_category() -> String { "Unkategorisiert".to_string() }

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
struct AppData {
    routes: Vec<Route>,
    current_route_id: Option<String>,
    pois: Vec<Poi>,
    #[serde(default = "default_interval")]
    tracking_interval: u64,
    #[serde(default = "default_hidden_categories")]
    hidden_categories: Vec<String>,
    #[serde(default)]
    poi_connections: Vec<String>,
    #[serde(default)]
    player_position: Option<CoordRecord>,
    #[serde(default)]
    auto_start_live_tracking: bool,
    #[serde(default)]
    auto_open_overlay: bool,
    #[serde(default)]
    auto_lock_overlay: bool,
    #[serde(default = "default_poi_hotkey")]
    poi_hotkey: String,
    #[serde(default = "default_bigmap_hotkey")]
    bigmap_hotkey: String,
    #[serde(default = "default_nav_route_color")]
    nav_route_color: String,
    #[serde(default = "default_auto_poi_color")]
    auto_poi_color: String,
    #[serde(default)]
    auto_poi_use_sector_category: bool,
    #[serde(default)]
    auto_poi_category: String,
    #[serde(default = "default_auto_poi_name_prefix")]
    auto_poi_name_prefix: String,
}

fn default_interval() -> u64 {
    DEFAULT_INTERVAL_SECONDS
}

fn default_hidden_categories() -> Vec<String> {
    Vec::new()
}

fn default_poi_hotkey() -> String {
    "F9".to_string()
}

fn default_bigmap_hotkey() -> String {
    "AltGr+M".to_string()
}

fn default_nav_route_color() -> String {
    "#00ffcc".to_string()
}

fn default_auto_poi_color() -> String {
    "#ff8800".to_string()
}

fn default_auto_poi_name_prefix() -> String {
    "POI".to_string()
}

pub(crate) struct AppState {
    data: Mutex<AppData>,
    pub(crate) data_path: PathBuf,
    recording: Mutex<bool>,
    live_tracking: Mutex<bool>,
    current_position: Mutex<Option<CoordRecord>>,
    poi_connections: Mutex<Vec<String>>,
    big_map_active: Mutex<bool>,
    bigmap_modal_open: Mutex<bool>,
    app_handle: Mutex<Option<tauri::AppHandle>>,
    nav_target: Mutex<Option<CoordRecord>>,
    pub(crate) nav_target_path: PathBuf,
    nav_route_color: Mutex<String>,
    pub(crate) nav_route_color_path: PathBuf,
}

impl AppState {
    pub(crate) fn current_position(&self) -> Option<CoordRecord> {
        self.current_position.lock().unwrap().clone()
    }
}

fn parse_clipboard(text: &str) -> Option<CoordRecord> {
    let re = Regex::new(
        r"\{X=([-\d.]+)\s+Y=([-\d.]+)\s+Z=([-\d.]+)\|P=([-\d.]+)\s+Y=([-\d.]+)\s+R=([-\d.]+)\}"
    ).ok()?;
    let caps = re.captures(text)?;
    Some(CoordRecord {
        time: Utc::now(),
        x: caps[1].parse().ok()?,
        y: caps[2].parse().ok()?,
        z: caps[3].parse().ok()?,
        pitch: caps[4].parse().ok()?,
        yaw: caps[5].parse().ok()?,
        roll: caps[6].parse().ok()?,
    })
}

fn load_data(path: &PathBuf) -> AppData {
    if let Ok(text) = fs::read_to_string(path) {
        if let Ok(mut data) = serde_json::from_str::<AppData>(&text) {
            // Assign default colors to old routes without a color
            for (i, route) in data.routes.iter_mut().enumerate() {
                if route.color.is_empty() {
                    route.color = ROUTE_COLORS[i % ROUTE_COLORS.len()].to_string();
                }
            }
            // Assign sector category to old POIs without a category
            for poi in data.pois.iter_mut() {
                if poi.category.is_empty() || poi.category == "Unkategorisiert" {
                    poi.category = compute_sector(poi.x, poi.y);
                }
            }
            return data;
        }
    }
    AppData::default()
}

pub(crate) fn save_data(path: &PathBuf, data: &AppData) {
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let _ = fs::write(path, json);
    }
}

pub(crate) fn save_nav_target(path: &PathBuf, target: &Option<CoordRecord>) {
    if let Ok(json) = serde_json::to_string_pretty(target) {
        let _ = fs::write(path, json);
    }
}

pub(crate) fn load_nav_target(path: &PathBuf) -> Option<CoordRecord> {
    if let Ok(json) = fs::read_to_string(path) {
        serde_json::from_str(&json).ok()
    } else {
        None
    }
}

pub(crate) fn save_nav_route_color(path: &PathBuf, color: &str) {
    if let Ok(json) = serde_json::to_string_pretty(&serde_json::json!({ "color": color })) {
        let _ = fs::write(path, json);
    }
}

pub(crate) fn load_nav_route_color(path: &PathBuf) -> String {
    if let Ok(json) = fs::read_to_string(path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
            if let Some(color) = value.get("color").and_then(|v| v.as_str()) {
                if color.starts_with('#') && color.len() == 7 {
                    return color.to_string();
                }
            }
        }
    }
    "#00ffcc".to_string()
}

#[cfg(windows)]
fn find_scum_window_by_title() -> Option<HWND> {
    for title in SCUM_WINDOW_TITLES {
        let wide: Vec<u16> = OsStr::new(title).encode_wide().chain(Some(0)).collect();
        let hwnd = unsafe { FindWindowW(None, windows::core::PCWSTR(wide.as_ptr())) };
        if hwnd.0 != 0 {
            return Some(hwnd);
        }
    }
    // Fallback: enumerate windows and check if title contains "SCUM"
    let mut result: HWND = HWND(0);
    unsafe {
        let _ = EnumWindows(Some(enum_window_title_callback), LPARAM(&mut result as *mut _ as isize));
    }
    if result.0 != 0 { Some(result) } else { None }
}

#[cfg(windows)]
unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 || pid == std::process::id() {
        return true.into();
    }
    // Use PROCESS_QUERY_LIMITED_INFORMATION instead of PROCESS_VM_READ -
    // this works even when SCUM runs as admin and our app does not.
    let Ok(hproc) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
        return true.into();
    };
    let mut buf = [0u16; 1024];
    let mut len: u32 = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(hproc, windows::Win32::System::Threading::PROCESS_NAME_FORMAT(0), windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(hproc);
    if ok.is_err() || len == 0 {
        return true.into();
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let lower = path.to_lowercase();
    let filename = lower.rsplit('\\').next().unwrap_or(&lower);
    if is_scum_process_filename(filename) {
        let out = lparam.0 as *mut HWND;
        *out = hwnd;
        return false.into();
    }
    true.into()
}

#[cfg(windows)]
unsafe extern "system" fn enum_window_title_callback(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut buf = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len == 0 {
        return true.into();
    }
    let title = String::from_utf16_lossy(&buf[..len as usize]);
    if !title.to_uppercase().contains("SCUM") {
        return true.into();
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == std::process::id() {
        return true.into();
    }
    // Titel allein reicht nicht (false positives z.B. durch Browser-Tabs/Chats,
    // die "SCUM" im Titel enthalten, ohne das Spiel zu sein) -> Prozessname prüfen.
    let (_, process_name, _) = window_process_info(hwnd);
    if is_scum_process_filename(&process_name) {
        let out = lparam.0 as *mut HWND;
        *out = hwnd;
        return false.into();
    }
    true.into()
}

#[cfg(windows)]
fn find_scum_window_by_process() -> Option<HWND> {
    let mut result: HWND = HWND(0);
    unsafe {
        let _ = EnumWindows(Some(enum_window_callback), LPARAM(&mut result as *mut _ as isize));
    }
    if result.0 == 0 { None } else { Some(result) }
}

#[derive(Debug, Clone, Serialize)]
struct WindowInfo {
    hwnd: isize,
    title: String,
    pid: u32,
    process_name: String,
}

#[cfg(windows)]
unsafe extern "system" fn enum_all_windows_callback(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut buf = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut buf);
    if len == 0 {
        return true.into();
    }
    let title = String::from_utf16_lossy(&buf[..len as usize]);
    let (pid, process_name, _) = window_process_info(hwnd);
    let list = &mut *(lparam.0 as *mut Vec<WindowInfo>);
    list.push(WindowInfo { hwnd: hwnd.0, title, pid, process_name });
    true.into()
}

// Listet alle sichtbaren Top-Level-Fenster mit Titel/PID/Prozessname auf.
// Dient als manueller Fallback, falls die automatische SCUM-Erkennung fehlschlägt.
#[cfg(windows)]
#[tauri::command]
fn list_visible_windows() -> Vec<WindowInfo> {
    let mut result: Vec<WindowInfo> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(enum_all_windows_callback), LPARAM(&mut result as *mut _ as isize));
    }
    result
}

#[cfg(not(windows))]
#[tauri::command]
fn list_visible_windows() -> Vec<WindowInfo> {
    Vec::new()
}

#[cfg(windows)]
#[tauri::command]
fn set_manual_scum_window(hwnd: isize) -> Result<(), String> {
    *MANUAL_SCUM_HWND.lock().unwrap() = Some(hwnd);
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn set_manual_scum_window(_hwnd: isize) -> Result<(), String> {
    Err("Nicht unterstützt auf dieser Plattform".to_string())
}

#[cfg(windows)]
#[tauri::command]
fn clear_manual_scum_window() -> Result<(), String> {
    *MANUAL_SCUM_HWND.lock().unwrap() = None;
    Ok(())
}

#[cfg(not(windows))]
#[tauri::command]
fn clear_manual_scum_window() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
#[tauri::command]
fn get_manual_scum_window() -> Option<isize> {
    *MANUAL_SCUM_HWND.lock().unwrap()
}

#[cfg(not(windows))]
#[tauri::command]
fn get_manual_scum_window() -> Option<isize> {
    None
}

#[cfg(windows)]
static MANUAL_SCUM_HWND: Mutex<Option<isize>> = Mutex::new(None);

#[cfg(windows)]
fn find_scum_window() -> Option<HWND> {
    {
        let mut manual = MANUAL_SCUM_HWND.lock().unwrap();
        if let Some(h) = *manual {
            let hwnd = HWND(h);
            if unsafe { IsWindow(hwnd) }.as_bool() {
                return Some(hwnd);
            }
            // Manuell gewähltes Fenster existiert nicht mehr -> Override verwerfen.
            *manual = None;
        }
    }
    find_scum_window_by_title().or_else(find_scum_window_by_process)
}

#[cfg(not(windows))]
fn find_scum_window() -> Option<()> { None }

#[cfg(windows)]
const VK_ESCAPE: u16 = 0x1B;
#[cfg(windows)]
const VK_RMENU: u16 = 0xA5; // right Alt / AltGr
#[cfg(windows)]
const VK_LMENU: u16 = 0xA4;
#[cfg(windows)]
const VK_MENU: u16 = 0x12;  // generic Alt (left or right)
#[cfg(windows)]
const VK_SHIFT: u16 = 0x10;
#[cfg(windows)]
const VK_LSHIFT: u16 = 0xA0;
#[cfg(windows)]
const VK_RSHIFT: u16 = 0xA1;
#[cfg(windows)]
const VK_LCONTROL: u16 = 0xA2;
#[cfg(windows)]
const VK_RCONTROL: u16 = 0xA3;

/// Wandelt eine Hotkey-Angabe wie "F9", "AltGr+M", "Ctrl+Shift+P" in eine
/// Liste von Virtual-Key-Codes um, die dann mit `is_key_pressed` geprüft werden
/// können. Reihenfolge ist egal; Modifier und Haupttaste werden einzeln geprüft.
/// Gibt `None` zurück, wenn ein unbekannter Teil im Hotkey enthalten ist.
/// Auf Nicht-Windows-Plattformen ist das nur ein Stub, damit der Code überall
/// kompiliert (die echten Hotkeys funktionieren nur unter Windows).
#[cfg(windows)]
fn parse_hotkey(combo: &str) -> Option<Vec<u16>> {
    let mut vks = Vec::new();
    for s in combo.split('+').map(|s| s.trim().to_ascii_uppercase()).filter(|s| !s.is_empty()) {
        let vk = match s.as_str() {
            "ALTGR" | "RALT" => VK_RMENU,
            "ALT" => VK_MENU,
            "LALT" => VK_LMENU,
            "CTRL" | "CONTROL" => VK_CONTROL.0,
            "LCTRL" => VK_LCONTROL,
            "RCTRL" => VK_RCONTROL,
            "SHIFT" => VK_SHIFT,
            "LSHIFT" => VK_LSHIFT,
            "RSHIFT" => VK_RSHIFT,
            _ => {
                if s.starts_with('F') {
                    if let Ok(n) = s[1..].parse::<u32>() {
                        if (1..=24).contains(&n) {
                            0x6F + n as u16
                        } else {
                            return None;
                        }
                    } else {
                        return None;
                    }
                } else if s.len() == 1 {
                    let c = s.chars().next().unwrap();
                    if ('A'..='Z').contains(&c) {
                        (c as u16) - ('A' as u16) + 0x41
                    } else if ('0'..='9').contains(&c) {
                        (c as u16) - ('0' as u16) + 0x30
                    } else if c == ' ' {
                        0x20
                    } else {
                        return None;
                    }
                } else {
                    return None;
                }
            }
        };
        vks.push(vk);
    }
    if vks.is_empty() { None } else { Some(vks) }
}

#[cfg(not(windows))]
fn parse_hotkey(_combo: &str) -> Option<Vec<u16>> {
    Some(Vec::new())
}

#[cfg(windows)]
fn is_hotkey_pressed(vks: &[u16]) -> bool {
    !vks.is_empty() && vks.iter().all(|&vk| is_key_pressed(vk))
}

#[cfg(windows)]
fn is_key_pressed(vk: u16) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe { (GetAsyncKeyState(vk as i32) as u16) & 0x8000 != 0 }
}

#[cfg(windows)]
fn is_scum_foreground() -> bool {
    let fg = unsafe { GetForegroundWindow() };
    if fg.0 == 0 {
        return false;
    }
    find_scum_window().map_or(false, |scum_hwnd| scum_hwnd == fg)
}

#[cfg(not(windows))]
fn is_scum_foreground() -> bool { false }

#[cfg(windows)]
fn start_hotkey_watcher(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut clipboard = Clipboard::new().expect("clipboard");
        let processing = Arc::new(std::sync::atomic::AtomicBool::new(false));
        loop {
            let hotkey = parse_hotkey(&state.data.lock().unwrap().poi_hotkey).unwrap_or_default();
            if is_hotkey_pressed(&hotkey) && is_scum_foreground() {
                // Block if already processing
                if processing.load(std::sync::atomic::Ordering::SeqCst) {
                    while is_hotkey_pressed(&hotkey) {
                        thread::sleep(Duration::from_millis(50));
                    }
                    continue;
                }
                processing.store(true, std::sync::atomic::Ordering::SeqCst);
                eprintln!("[hotkey] {} gedrückt - erstelle POI + Screenshot", state.data.lock().unwrap().poi_hotkey);
                ws_broadcast(serde_json::json!(["poi-creating", null]).to_string());

                // 1. Ctrl+C an SCUM senden und Koordinaten robust aus der Zwischenablage lesen
                let record = match capture_scum_coord(&mut clipboard, 300, true) {
                    Ok((r, _)) => r,
                    Err(e) => {
                        eprintln!("[hotkey] Positionsabfrage fehlgeschlagen: {}", e);
                        processing.store(false, std::sync::atomic::Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(500));
                        continue;
                    }
                };

                // 3. POI erstellen
                let data = state.data.lock().unwrap();
                let settings = data.clone();
                drop(data);

                let prefix = if settings.auto_poi_name_prefix.is_empty() {
                    "POI".to_string()
                } else {
                    settings.auto_poi_name_prefix.clone()
                };
                let poi_id = format!("{}", Utc::now().timestamp_millis());
                let poi_label = format!("{} {}", prefix, poi_id);
                let category = if settings.auto_poi_use_sector_category || settings.auto_poi_category.is_empty() {
                    compute_sector(record.x, record.y)
                } else {
                    settings.auto_poi_category.clone()
                };
                let poi = Poi {
                    id: poi_id.clone(),
                    label: poi_label.clone(),
                    x: record.x,
                    y: record.y,
                    poi_type: "auto".to_string(),
                    color: settings.auto_poi_color.clone(),
                    image_path: None,
                    category,
                };

                // 4. Screenshot in separatem Thread (blockiert nicht HTTP-Server)
                let img = {
                    let hwnd = find_scum_window();
                    if let Some(hwnd) = hwnd {
                        let handle = std::thread::spawn(move || capture_window(hwnd));
                        match handle.join() {
                            Ok(img) => img,
                            Err(_) => None,
                        }
                    } else {
                        None
                    }
                };

                let image_dir = state.data_path.parent().unwrap_or(&state.data_path).join("poi_images");
                let _ = std::fs::create_dir_all(&image_dir);

                let mut poi_with_image = poi.clone();
                if let Some(img) = img {
                    let filename = format!("poi_{}.png", poi_id);
                    let path = image_dir.join(&filename);
                    if img.save_with_format(&path, image::ImageFormat::Png).is_ok() {
                        poi_with_image.image_path = Some(filename);
                    }
                }

                // 5. POI in Daten speichern (kurzer Lock)
                {
                    let mut data = state.data.lock().unwrap();
                    data.pois.push(poi_with_image);
                    save_data(&state.data_path, &data);
                    let data_clone = data.clone();
                    let _ = app_handle.emit("data-updated", data_clone.clone());
                    ws_broadcast(serde_json::json!(["data-updated", data_clone]).to_string());
                }

                eprintln!("[hotkey] POI erstellt: {} bei X={} Y={}", poi_label, record.x, record.y);
                let _ = app_handle.emit("hotkey-poi-created", &poi_label);
                ws_broadcast(serde_json::json!(["poi-created", {"label": poi_label}]).to_string());

                processing.store(false, std::sync::atomic::Ordering::SeqCst);

                // Verhindern, dass der Hotkey mehrfach triggert
                while is_hotkey_pressed(&hotkey) {
                    thread::sleep(Duration::from_millis(50));
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    });
}

#[cfg(windows)]
fn get_scum_client_rect_screen() -> Option<(i32, i32, i32, i32)> {
    let hwnd = find_scum_window()?;
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    unsafe {
        GetClientRect(hwnd, &mut rect).ok()?;
    }
    let mut top_left = POINT { x: 0, y: 0 };
    unsafe {
        let _ = ClientToScreen(hwnd, &mut top_left);
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some((top_left.x, top_left.y, width, height))
}

#[cfg(windows)]
fn create_bigmap_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    // Load through the real HTTP server (like the small overlay's iframe does) so the
    // {{WS_PORT}} template placeholder is substituted correctly - loading via Tauri's
    // internal asset protocol (WebviewUrl::App) leaves it unreplaced and the websocket
    // ends up connecting to the wrong (internal asset) port.
    let url = tauri::Url::parse(&format!("{}&bigmap=1", livemap_url())).map_err(|e| e.to_string())?;
    let mut builder = WebviewWindowBuilder::new(app, "bigmap", tauri::WebviewUrl::External(url))
        .title("SCUM Walker Big Map")
        .inner_size(800.0, 800.0)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false);
    #[cfg(windows)]
    {
        builder = builder.transparent(true);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    disable_window_rounded_corners(&window);
    Ok(window)
}

// Windows 11 automatically rounds the corners of top-level windows, which shows up as a
// thin visible edge/artifact around an undecorated, fully transparent window. Explicitly
// opt this window out via DWM so it renders perfectly square/borderless.
#[cfg(windows)]
fn disable_window_rounded_corners(window: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND};
    if let Ok(raw_hwnd) = window.hwnd() {
        // window.hwnd() returns HWND from tauri's (newer) version of the `windows` crate;
        // convert the raw handle value into our own dependency's HWND type for the call below.
        let hwnd = HWND(raw_hwnd.0 as isize);
        let pref = DWMWCP_DONOTROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const _,
                std::mem::size_of_val(&pref) as u32,
            );
        }
    }
}

#[cfg(windows)]
fn toggle_big_map(app: &tauri::AppHandle, state: &Arc<AppState>) {
    let mut active = state.big_map_active.lock().unwrap();

    if *active {
        if let Some(window) = app.get_webview_window("bigmap") {
            ws_broadcast(serde_json::json!(["bigmap-closing", null]).to_string());
            let _ = window.hide();
        }
        *active = false;
        *state.bigmap_modal_open.lock().unwrap() = false;
        eprintln!("[bigmap] Geschlossen");
        return;
    }

    let window = match app.get_webview_window("bigmap") {
        Some(w) => w,
        None => match create_bigmap_window(app) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[bigmap] Fenster konnte nicht erstellt werden: {}", e);
                return;
            }
        },
    };

    sync_bigmap_geometry(&window, true);
    let _ = window.show();
    let _ = window.set_focus();
    *active = true;
    eprintln!("[bigmap] Geöffnet");
}

// Resizes/repositions the bigmap window to match SCUM's current client area (square,
// side = SCUM window height, horizontally centered over it). Called once on open and
// then polled periodically while the bigmap is active so resizing/moving/toggling
// fullscreen on SCUM keeps the overlay in sync without requiring a re-toggle.
// Extra transparent margin added to each side of the bigmap window beyond the square
// map area, so the (square) map is centered within a slightly wider overlay window.
const BIGMAP_SIDE_MARGIN: i32 = 0;

#[cfg(windows)]
fn sync_bigmap_geometry(window: &tauri::WebviewWindow, log: bool) {
    if let Some((sx, sy, sw, sh)) = get_scum_client_rect_screen() {
        let side = sh.max(1) as i32;
        let width = (side + BIGMAP_SIDE_MARGIN * 2).max(1) as u32;
        let x = sx + (sw - width as i32) / 2;
        let y = sy;
        if log {
            eprintln!(
                "[bigmap] SCUM-Rect: pos=({},{}) size={}x{} -> Bigmap: pos=({},{}) size={}x{}",
                sx, sy, sw, sh, x, y, width, side
            );
        }
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height: side as u32 }));
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    } else if let Ok(Some(monitor)) = window.current_monitor() {
        let msize = monitor.size();
        let mpos = monitor.position();
        let side = msize.height as i32;
        let width = (side + BIGMAP_SIDE_MARGIN * 2).max(1) as u32;
        let x = mpos.x + (msize.width as i32 - width as i32) / 2;
        let y = mpos.y;
        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height: side as u32 }));
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }
}

#[cfg(windows)]
fn is_bigmap_foreground(app: &tauri::AppHandle) -> bool {
    let fg = unsafe { GetForegroundWindow() };
    if fg.0 == 0 {
        return false;
    }
    app.get_webview_window("bigmap")
        .and_then(|w| w.hwnd().ok())
        .map_or(false, |h| h.0 as isize == fg.0 as isize)
}

#[cfg(windows)]
fn start_bigmap_hotkey_watcher(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut combo_down = false;
        let mut sync_tick: u32 = 0;
        loop {
            let scum_fg = is_scum_foreground();
            let bigmap_fg = is_bigmap_foreground(&app_handle);
            // Opening requires SCUM foreground; closing also works while the bigmap
            // window itself has focus (e.g. right after clicking on it).
            let bigmap_hotkey = parse_hotkey(&state.data.lock().unwrap().bigmap_hotkey).unwrap_or_default();
            let combo_pressed = (scum_fg || bigmap_fg) && is_hotkey_pressed(&bigmap_hotkey);

            if combo_pressed && !combo_down {
                combo_down = true;
                let was_active = *state.big_map_active.lock().unwrap();
                toggle_big_map(&app_handle, &state);
                if was_active {
                    let _ = send_esc_to_scum();
                }
            } else if !combo_pressed {
                combo_down = false;
            }

            // Auto-hide: only show the big map while SCUM (or the map itself) has focus.
            // If the user switches to some other app, hide it automatically.
            if *state.big_map_active.lock().unwrap() && !scum_fg && !bigmap_fg {
                toggle_big_map(&app_handle, &state);
            }

            // ESC closes the big map and forwards the ESC press to SCUM, never opens anything.
            // But not if the POI modal is open - in that case ESC should only close the modal (handled in JS).
            if *state.big_map_active.lock().unwrap() && is_key_pressed(VK_ESCAPE) {
                if *state.bigmap_modal_open.lock().unwrap() {
                    // Modal is open: let JS handle ESC to close the modal.
                    // Wait for ESC to be released so we don't re-check and close the bigmap
                    // in the same key press after JS has cleared the modal flag.
                    while is_key_pressed(VK_ESCAPE) {
                        thread::sleep(Duration::from_millis(50));
                    }
                } else {
                    toggle_big_map(&app_handle, &state);
                    let _ = send_esc_to_scum();
                    while is_key_pressed(VK_ESCAPE) {
                        thread::sleep(Duration::from_millis(50));
                    }
                }
            }

            // Keep the overlay's size/position in sync with SCUM's window while it's
            // open (e.g. user resizes SCUM, moves it, or toggles fullscreen).
            sync_tick += 1;
            if *state.big_map_active.lock().unwrap() && sync_tick % 10 == 0 {
                if let Some(window) = app_handle.get_webview_window("bigmap") {
                    sync_bigmap_geometry(&window, false);
                }
            }

            thread::sleep(Duration::from_millis(50));
        }
    });
}

#[cfg(windows)]
fn is_process_handle_elevated(hproc: windows::Win32::Foundation::HANDLE) -> Option<bool> {
    let mut token = windows::Win32::Foundation::HANDLE::default();
    unsafe { OpenProcessToken(hproc, TOKEN_QUERY, &mut token).ok()? };
    let mut elevation = TOKEN_ELEVATION::default();
    let mut ret_len: u32 = 0;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut std::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut ret_len,
        )
    };
    unsafe { let _ = CloseHandle(token); };
    if ok.is_err() {
        return None;
    }
    Some(elevation.TokenIsElevated != 0)
}

// Liefert (pid, process_name, window_title) für ein Fenster-Handle.
#[cfg(windows)]
fn window_process_info(hwnd: HWND) -> (u32, String, String) {
    let mut buf = [0u16; 256];
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    let title = if len > 0 {
        String::from_utf16_lossy(&buf[..len as usize])
    } else {
        String::from("<kein Titel>")
    };
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
    let mut process_name = String::from("unbekannt");
    if pid != 0 {
        if let Ok(hproc) = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            let mut pbuf = [0u16; 1024];
            let mut plen: u32 = pbuf.len() as u32;
            let ok = unsafe {
                QueryFullProcessImageNameW(
                    hproc,
                    windows::Win32::System::Threading::PROCESS_NAME_FORMAT(0),
                    windows::core::PWSTR(pbuf.as_mut_ptr()),
                    &mut plen,
                )
            };
            if ok.is_ok() {
                let path = String::from_utf16_lossy(&pbuf[..plen as usize]).to_lowercase();
                process_name = path.rsplit('\\').next().unwrap_or(&path).to_string();
            }
            unsafe { let _ = CloseHandle(hproc); };
        }
    }
    (pid, process_name, title)
}

#[cfg(windows)]
static LAST_LOGGED_SCUM_TARGET: Mutex<Option<(u32, String)>> = Mutex::new(None);

// Debug: loggt, welches Fenster/Prozess aktuell als "SCUM" angesteuert wird.
// Hilft bei Support-Fällen, in denen die Auto-Erkennung das falsche/kein Fenster trifft.
#[cfg(windows)]
fn log_scum_target(hwnd: HWND) {
    let (pid, process_name, title) = window_process_info(hwnd);
    let key = (pid, process_name.clone());
    let mut last = LAST_LOGGED_SCUM_TARGET.lock().unwrap();
    if *last != Some(key.clone()) {
        eprintln!(
            "[scum-target] Nutze Fenster hwnd={} pid={} process=\"{}\" title=\"{}\"",
            hwnd.0, pid, process_name, title
        );
        *last = Some(key);
    }
}

// Prüft, ob SCUM mit höheren Rechten läuft als SCUM Walker selbst.
// Falls ja, blockiert Windows UIPI unser SendInput() lautlos (kein Fehlercode!),
// wodurch nie Koordinaten ankommen, obwohl SCUM erkannt wird und im Vordergrund ist.
#[cfg(windows)]
fn scum_elevation_mismatch(hwnd: HWND) -> bool {
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
    if pid == 0 {
        return false;
    }
    let Ok(hproc) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return false;
    };
    let scum_elevated = is_process_handle_elevated(hproc);
    unsafe { let _ = CloseHandle(hproc); };
    let self_elevated = is_process_handle_elevated(unsafe { GetCurrentProcess() });
    matches!((scum_elevated, self_elevated), (Some(true), Some(false)))
}

#[cfg(windows)]
fn send_ctrl_c_to_scum() -> Result<(), String> {
    let hwnd = find_scum_window().ok_or("SCUM-Fenster nicht gefunden".to_string())?;
    log_scum_target(hwnd);
    let fg = unsafe { GetForegroundWindow() };
    if fg.0 == 0 || fg != hwnd {
        return Err("SCUM ist nicht im Vordergrund".to_string());
    }
    if scum_elevation_mismatch(hwnd) {
        return Err("SCUM läuft mit Administratorrechten, SCUM Walker nicht. Windows blockiert dadurch die Tastatureingabe. Bitte starte SCUM Walker ebenfalls als Administrator.".to_string());
    }

    // Falls der Nutzer gerade physisch Alt (oder Shift) hält, würde unser injiziertes
    // Strg+C von SCUM je nach Keybinding als andere Kombination interpretiert werden
    // (z. B. Alt+C = Bauelement neu bauen/reparieren). Kurz warten, bis Alt/Shift
    // losgelassen wird, bevor wir Strg+C senden - sonst überspringen.
    let mut waited_ms = 0;
    while (is_key_pressed(VK_MENU) || is_key_pressed(VK_SHIFT)) && waited_ms < 500 {
        thread::sleep(Duration::from_millis(20));
        waited_ms += 20;
    }
    if is_key_pressed(VK_MENU) || is_key_pressed(VK_SHIFT) {
        return Err("Alt/Shift ist aktuell gedrückt, Positionsabfrage übersprungen".to_string());
    }

    fn kbd_input(scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    let ctrl_scan = unsafe { MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC) as u16 };
    let c_scan = unsafe { MapVirtualKeyW(VK_C.0 as u32, MAPVK_VK_TO_VSC) as u16 };
    let scan_down = KEYBD_EVENT_FLAGS(KEYEVENTF_SCANCODE.0);
    let scan_up = KEYBD_EVENT_FLAGS(KEYEVENTF_SCANCODE.0 | KEYEVENTF_KEYUP.0);

    unsafe {
        SendInput(
            &[kbd_input(ctrl_scan, scan_down), kbd_input(c_scan, scan_down)],
            std::mem::size_of::<INPUT>() as i32,
        );
    }
    std::thread::sleep(Duration::from_millis(60));
    unsafe {
        SendInput(
            &[kbd_input(c_scan, scan_up), kbd_input(ctrl_scan, scan_up)],
            std::mem::size_of::<INPUT>() as i32,
        );
    }
    std::thread::sleep(Duration::from_millis(50));

    // Sicherheitsnetz: Falls durch einen Lag das Up-Event nicht verarbeitet wurde
    // und eine der beiden Tasten laut GetAsyncKeyState noch als gedrückt gilt
    // (z. B. Ctrl bliebe als Dauer-Ducken hängen), erneut Up nachsenden.
    if is_key_pressed(VK_CONTROL.0) || is_key_pressed(VK_C.0) {
        unsafe {
            SendInput(
                &[kbd_input(c_scan, scan_up), kbd_input(ctrl_scan, scan_up)],
                std::mem::size_of::<INPUT>() as i32,
            );
        }
        std::thread::sleep(Duration::from_millis(30));
    }

    Ok(())
}

#[cfg(not(windows))]
fn send_ctrl_c_to_scum() -> Result<(), String> {
    Err("Nicht unterstützt auf dieser Plattform".to_string())
}

/// Sendet Strg+C an SCUM und liest die kopierten Koordinaten aus der
/// Zwischenablage aus.
///
/// Bei `preserve_clipboard = true` wird der bisherige Inhalt gesichert, die
/// Zwischenablage vor dem Senden geleert und der alte Inhalt danach wieder
/// hergestellt. Nur wenn danach wirklich neuer, gültiger Text ankommt, gilt
/// der Vorgang als erfolgreich. Das ist sicher, verursacht aber bei sehr
/// kurzen Tracking-Intervallen Overhead.
///
/// Bei `preserve_clipboard = false` wird die Zwischenablage nicht geleert und
/// nicht wiederhergestellt. Der Aufrufer muss selbst prüfen, ob der Wert
/// tatsächlich neu ist (z. B. durch Vergleich mit dem vorherigen Text).
fn capture_scum_coord(clipboard: &mut Clipboard, wait_ms: u64, preserve_clipboard: bool) -> Result<(CoordRecord, String), String> {
    let previous = if preserve_clipboard { clipboard.get_text().ok() } else { None };
    if preserve_clipboard {
        let _ = clipboard.clear();
    }

    let result = (|| {
        send_ctrl_c_to_scum()?;
        thread::sleep(Duration::from_millis(wait_ms));
        let text = clipboard.get_text().map_err(|_| {
            "Zwischenablage blieb leer (Strg+C wurde vom Spiel vermutlich nicht verarbeitet, z.B. durch Lag)".to_string()
        })?;
        let record = parse_clipboard(&text).ok_or_else(|| "Keine gültigen Koordinaten in der Zwischenablage".to_string())?;
        Ok((record, text))
    })();

    if preserve_clipboard {
        if let Some(prev) = previous {
            let _ = clipboard.set_text(prev);
        } else {
            let _ = clipboard.clear();
        }
    }

    result
}

#[cfg(windows)]
fn send_esc_to_scum() -> Result<(), String> {
    let hwnd = find_scum_window().ok_or("SCUM-Fenster nicht gefunden".to_string())?;

    // The bigmap window currently has focus (it's interactive), so bring SCUM back
    // to the foreground first, then forward the ESC key press to it.
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }
    std::thread::sleep(Duration::from_millis(60));

    fn kbd_input(scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    let esc_scan = unsafe { MapVirtualKeyW(VK_ESCAPE as u32, MAPVK_VK_TO_VSC) as u16 };
    let scan_down = KEYBD_EVENT_FLAGS(KEYEVENTF_SCANCODE.0);
    let scan_up = KEYBD_EVENT_FLAGS(KEYEVENTF_SCANCODE.0 | KEYEVENTF_KEYUP.0);

    unsafe {
        SendInput(&[kbd_input(esc_scan, scan_down)], std::mem::size_of::<INPUT>() as i32);
    }
    std::thread::sleep(Duration::from_millis(50));
    unsafe {
        SendInput(&[kbd_input(esc_scan, scan_up)], std::mem::size_of::<INPUT>() as i32);
    }

    Ok(())
}

#[cfg(not(windows))]
fn send_esc_to_scum() -> Result<(), String> {
    Err("Nicht unterstützt auf dieser Plattform".to_string())
}

#[cfg(windows)]
fn capture_window(hwnd: HWND) -> Option<image::RgbaImage> {
    // PrintWindow is in Win32_Storage_Xps which we don't have as feature.
    // Use direct FFI call instead.
    extern "system" {
        fn PrintWindow(hwnd: HWND, hdcblt: HDC, nflags: u32) -> i32;
    }
    const PW_RENDERFULLCONTENT: u32 = 0x00000002;

    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect).is_err() {
            return None;
        }

        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;
        if width == 0 || height == 0 {
            return None;
        }

        let hdc_window = GetDC(hwnd);
        if hdc_window.0 == 0 {
            return None;
        }

        let hdc_mem = CreateCompatibleDC(hdc_window);
        if hdc_mem.0 == 0 {
            let _ = ReleaseDC(hwnd, hdc_window);
            return None;
        }

        let hbm = CreateCompatibleBitmap(hdc_window, width as i32, height as i32);
        if hbm.0 == 0 {
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(hwnd, hdc_window);
            return None;
        }

        let _ = SelectObject(hdc_mem, hbm);

        // PrintWindow with PW_RENDERFULLCONTENT forces rendering of current frame
        // even for hardware-accelerated apps like Unreal Engine
        let result = PrintWindow(hwnd, hdc_mem, PW_RENDERFULLCONTENT);

        if result == 0 {
            // Fallback to BitBlt if PrintWindow fails
            let _ = BitBlt(
                hdc_mem,
                0, 0,
                width as i32, height as i32,
                hdc_window,
                0, 0,
                SRCCOPY,
            );
        }

        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width as i32;
        bmi.bmiHeader.biHeight = -(height as i32);
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = DIB_RGB_COLORS.0;

        let mut buf: Vec<u8> = vec![0; (width * height * 4) as usize];
        let _ = GetDIBits(
            hdc_mem,
            hbm,
            0,
            height,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        let _ = DeleteObject(hbm);
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(hwnd, hdc_window);

        // Convert BGRA -> RGBA
        let mut img = image::RgbaImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                let idx = ((y * width + x) * 4) as usize;
                let b = buf[idx];
                let g = buf[idx + 1];
                let r = buf[idx + 2];
                let a = buf[idx + 3];
                img.put_pixel(x, y, image::Rgba([r, g, b, a]));
            }
        }

        Some(img)
    }
}

#[cfg(windows)]
fn capture_scum_window() -> Option<image::RgbaImage> {
    find_scum_window().and_then(capture_window)
}

#[cfg(not(windows))]
fn capture_scum_window() -> Option<image::RgbaImage> { None }

#[tauri::command]
fn get_current_location(state: State<Arc<AppState>>) -> Result<CoordRecord, String> {
    if let Ok(mut clipboard) = Clipboard::new() {
        if let Ok((record, _)) = capture_scum_coord(&mut clipboard, 300, true) {
            return Ok(record);
        }
    }
    state
        .current_position()
        .ok_or_else(|| "Keine Koordinaten verfügbar: SCUM ist nicht im Vordergrund und es liegt keine zuletzt bekannte Position vor".to_string())
}

fn scum_is_running() -> bool {
    find_scum_window().is_some()
}

fn start_recorder(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut clipboard = Clipboard::new().expect("clipboard");
        let mut last_scum_status = true;
        let mut last_tracking_error: Option<String> = None;
        let mut last_scum_text: Option<String> = None;
        loop {
            let tracking = *state.live_tracking.lock().unwrap();
            if tracking {
                let scum_running = scum_is_running();
                if scum_running != last_scum_status {
                    let _ = app_handle.emit("scum-status", scum_running);
                    ws_broadcast(serde_json::json!(["scum-status", scum_running]).to_string());
                    last_scum_status = scum_running;
                }
                if !scum_running {
                    let interval = state.data.lock().unwrap().tracking_interval;
                    thread::sleep(Duration::from_secs(interval));
                    continue;
                }
                let interval = state.data.lock().unwrap().tracking_interval;
                // Ab 10 Sekunden Intervall ist das ständige Leeren/Wiederherstellen
                // der Zwischenablage vertretbar; bei kürzeren Intervallen lassen wir
                // die Zwischenablage unberührt und erkennen fehlgeschlagene Kopien
                // daran, dass sich der Inhalt nicht geändert hat.
                let preserve_clipboard = interval >= 10;
                match capture_scum_coord(&mut clipboard, 500, preserve_clipboard) {
                    Err(err) => {
                        if last_tracking_error.as_deref() != Some(err.as_str()) {
                            eprintln!("[recorder] Positionsabfrage fehlgeschlagen: {}", err);
                            let _ = app_handle.emit("tracking-error", err.clone());
                            ws_broadcast(serde_json::json!(["tracking-error", err]).to_string());
                            last_tracking_error = Some(err);
                        }
                        let interval = state.data.lock().unwrap().tracking_interval;
                        thread::sleep(Duration::from_secs(interval));
                        continue;
                    }
                    Ok((record, text)) => {
                        last_tracking_error = None;
                        if last_scum_text.as_ref() == Some(&text) {
                            let interval = state.data.lock().unwrap().tracking_interval;
                            thread::sleep(Duration::from_secs(interval));
                            continue;
                        }
                        last_scum_text = Some(text);
                        let should_emit = {
                            let mut pos = state.current_position.lock().unwrap();
                            let changed = pos.as_ref().map_or(true, |last| {
                                (last.x - record.x).abs() > 0.1 || (last.y - record.y).abs() > 0.1
                            });
                            *pos = Some(record.clone());
                            changed
                        };

                        if should_emit {
                            let is_recording = *state.recording.lock().unwrap();
                            {
                                let mut data = state.data.lock().unwrap();
                                if is_recording {
                                    if let Some(current_id) = data.current_route_id.clone() {
                                        if let Some(route) = data.routes.iter_mut().find(|r| r.id == current_id) {
                                            route.records.push(record.clone());
                                        }
                                    }
                                }
                                data.player_position = Some(record.clone());
                                let data_clone = data.clone();
                                save_data(&state.data_path, &data_clone);
                                drop(data);
                                if is_recording {
                                    ws_broadcast(serde_json::json!(["data-updated", data_clone]).to_string());
                                }
                            }
                            let _ = app_handle.emit("coord-update", record.clone());
                            ws_broadcast(serde_json::json!(["coord-update", record]).to_string());
                        }
                    }
                }
                let interval = state.data.lock().unwrap().tracking_interval;
                thread::sleep(Duration::from_secs(interval));
            } else {
                thread::sleep(Duration::from_millis(500));
            }
        }
    });
}

#[tauri::command]
fn get_data(state: State<Arc<AppState>>) -> AppData {
    state.data.lock().unwrap().clone()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppSettings {
    tracking_interval: u64,
    auto_start_live_tracking: bool,
    auto_open_overlay: bool,
    auto_lock_overlay: bool,
    poi_hotkey: String,
    bigmap_hotkey: String,
    nav_route_color: String,
    auto_poi_color: String,
    auto_poi_use_sector_category: bool,
    auto_poi_category: String,
    auto_poi_name_prefix: String,
}

fn settings_from_data(data: &AppData) -> AppSettings {
    AppSettings {
        tracking_interval: data.tracking_interval.max(1),
        auto_start_live_tracking: data.auto_start_live_tracking,
        auto_open_overlay: data.auto_open_overlay,
        auto_lock_overlay: data.auto_lock_overlay,
        poi_hotkey: data.poi_hotkey.clone(),
        bigmap_hotkey: data.bigmap_hotkey.clone(),
        nav_route_color: data.nav_route_color.clone(),
        auto_poi_color: data.auto_poi_color.clone(),
        auto_poi_use_sector_category: data.auto_poi_use_sector_category,
        auto_poi_category: data.auto_poi_category.clone(),
        auto_poi_name_prefix: data.auto_poi_name_prefix.clone(),
    }
}

#[tauri::command]
fn get_settings(state: State<Arc<AppState>>) -> AppSettings {
    settings_from_data(&state.data.lock().unwrap())
}

fn apply_settings_to_data(data: &mut AppData, settings: &AppSettings) -> Result<(), String> {
    let hotkeys = [
        ("POI-Hotkey", &settings.poi_hotkey),
        ("Bigmap-Hotkey", &settings.bigmap_hotkey),
    ];
    for (name, combo) in hotkeys {
        if parse_hotkey(combo.trim()).is_none() {
            return Err(format!("{} ist ungültig: '{}'", name, combo));
        }
    }

    data.tracking_interval = settings.tracking_interval.max(1);
    data.auto_start_live_tracking = settings.auto_start_live_tracking;
    data.auto_open_overlay = settings.auto_open_overlay;
    data.auto_lock_overlay = settings.auto_lock_overlay;
    data.poi_hotkey = settings.poi_hotkey.trim().to_string();
    data.bigmap_hotkey = settings.bigmap_hotkey.trim().to_string();
    data.nav_route_color = validate_hex_color(&settings.nav_route_color).unwrap_or_else(default_nav_route_color);
    data.auto_poi_color = validate_hex_color(&settings.auto_poi_color).unwrap_or_else(default_auto_poi_color);
    data.auto_poi_use_sector_category = settings.auto_poi_use_sector_category;
    data.auto_poi_category = settings.auto_poi_category.trim().to_string();
    data.auto_poi_name_prefix = settings.auto_poi_name_prefix.trim().to_string();
    Ok(())
}

#[tauri::command]
fn save_settings(state: State<Arc<AppState>>, settings: AppSettings) -> Result<AppSettings, String> {
    let mut data = state.data.lock().unwrap();
    apply_settings_to_data(&mut data, &settings)?;
    save_data(&state.data_path, &data);

    // Keep the runtime nav route color state in sync so overlays pick it up immediately.
    apply_nav_route_color(&state, &data.nav_route_color);

    Ok(settings_from_data(&data))
}

fn validate_hex_color(color: &str) -> Option<String> {
    let color = color.trim().to_lowercase();
    if color.starts_with('#') && color.len() == 7 && color.chars().skip(1).all(|c| c.is_ascii_hexdigit()) {
        Some(color)
    } else {
        None
    }
}

fn escape_csv(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[tauri::command]
fn export_data(state: State<Arc<AppState>>, format: String) -> Result<String, String> {
    let data = state.data.lock().unwrap().clone();
    let (filename, filter, content) = match format.as_str() {
        "json" => {
            let content = serde_json::to_string_pretty(&serde_json::json!({
                "exportedAt": Utc::now().to_rfc3339(),
                "routes": data.routes,
                "pois": data.pois,
            })).map_err(|e| e.to_string())?;
            ("scum-walker-export.json", "JSON-Datei", content)
        }
        "csv" => {
            let mut csv = String::from("type,route_id,route_name,record_index,time,x,y,z,pitch,yaw,roll\n");
            for route in data.routes {
                for (index, record) in route.records.iter().enumerate() {
                    csv.push_str(&format!(
                        "record,{},{},{},{},{},{},{},{},{},{}\n",
                        route.id,
                        escape_csv(&route.name),
                        index,
                        record.time.to_rfc3339(),
                        record.x,
                        record.y,
                        record.z,
                        record.pitch,
                        record.yaw,
                        record.roll,
                    ));
                }
            }
            for poi in data.pois {
                csv.push_str(&format!(
                    "poi,{},{},,,{},{},,,,\n",
                    poi.id,
                    escape_csv(&poi.label),
                    poi.x,
                    poi.y,
                ));
            }
            ("scum-walker-export.csv", "CSV-Datei", csv)
        }
        _ => return Err("Unbekanntes Exportformat".to_string()),
    };
    let path = rfd::FileDialog::new()
        .set_title("SCUM Walker exportieren")
        .set_file_name(filename)
        .add_filter(filter, &[format.as_str()])
        .save_file()
        .ok_or("Export abgebrochen")?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

fn save_backup_file(title: &str, filename: &str, content: &str) -> Result<String, String> {
    let path = rfd::FileDialog::new()
        .set_title(title)
        .set_file_name(filename)
        .add_filter("JSON-Datei", &["json"])
        .save_file()
        .ok_or("Export abgebrochen")?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

fn pick_backup_file(title: &str) -> Result<PathBuf, String> {
    rfd::FileDialog::new()
        .set_title(title)
        .add_filter("JSON-Datei", &["json"])
        .pick_file()
        .ok_or_else(|| "Import abgebrochen".to_string())
}

fn fresh_id(offset: usize) -> String {
    format!("{}-{}", Utc::now().timestamp_millis(), offset)
}

#[tauri::command]
fn export_routes_backup(state: State<Arc<AppState>>, route_id: Option<String>) -> Result<String, String> {
    let data = state.data.lock().unwrap().clone();
    let route_id = route_id.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    let routes: Vec<Route> = match &route_id {
        Some(id) => data.routes.into_iter().filter(|r| &r.id == id).collect(),
        None => data.routes,
    };
    if routes.is_empty() {
        return Err("Keine Routen für diese Auswahl vorhanden".to_string());
    }
    let filename = match &route_id {
        Some(_) => format!("scum-walker-route-backup-{}.json", chrono::Utc::now().format("%Y%m%d-%H%M%S")),
        None => "scum-walker-routes-backup.json".to_string(),
    };
    let content = serde_json::to_string_pretty(&serde_json::json!({
        "type": "scum-walker-routes-backup",
        "exportedAt": Utc::now().to_rfc3339(),
        "routes": routes,
    })).map_err(|e| e.to_string())?;
    save_backup_file("Routen-Backup exportieren", &filename, &content)
}

fn slugify_category(category: &str) -> String {
    let slug: String = category
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() { "kategorie".to_string() } else { slug }
}

fn is_zip_file(path: &Path) -> bool {
    if let Some(ext) = path.extension() {
        ext.to_ascii_lowercase().to_string_lossy() == "zip"
    } else {
        false
    }
}

#[tauri::command]
fn export_pois_backup(state: State<Arc<AppState>>, category: Option<String>, include_images: bool) -> Result<String, String> {
    let data = state.data.lock().unwrap().clone();
    let app_data_dir = app_data_dir(&state)?;
    let category = category.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    let pois: Vec<Poi> = match &category {
        Some(cat) => data.pois.clone().into_iter().filter(|p| &p.category == cat).collect(),
        None => data.pois.clone(),
    };
    if pois.is_empty() {
        return Err("Keine POIs für diese Kategorie vorhanden".to_string());
    }

    if !include_images {
        let content = serde_json::to_string_pretty(&serde_json::json!({
            "type": "scum-walker-pois-backup",
            "exportedAt": Utc::now().to_rfc3339(),
            "category": category,
            "pois": pois,
        })).map_err(|e| e.to_string())?;
        let filename = match &category {
            Some(cat) => format!("scum-walker-pois-{}-backup.json", slugify_category(cat)),
            None => "scum-walker-pois-backup.json".to_string(),
        };
        return save_backup_file("POI-Backup exportieren", &filename, &content);
    }

    // ZIP export with images
    let filename = match &category {
        Some(cat) => format!("scum-walker-pois-{}-backup.zip", slugify_category(cat)),
        None => format!("scum-walker-pois-backup-{}.zip", chrono::Utc::now().format("%Y%m%d-%H%M%S")),
    };
    let path = rfd::FileDialog::new()
        .set_title("POI-Backup mit Bildern exportieren")
        .set_file_name(&filename)
        .add_filter("ZIP-Datei", &["zip"])
        .save_file()
        .ok_or("Export abgebrochen")?;

    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::<zip::write::ExtendedFileOptions>::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let manifest = serde_json::to_string_pretty(&serde_json::json!({
        "type": "scum-walker-pois-backup",
        "exportedAt": Utc::now().to_rfc3339(),
        "category": category,
        "pois": pois,
    })).map_err(|e| e.to_string())?;
    zip.start_file("pois.json", options.clone()).map_err(|e| e.to_string())?;
    zip.write_all(manifest.as_bytes()).map_err(|e| e.to_string())?;

    let image_dir = app_data_dir.join("poi_images");
    for poi in &pois {
        if let Some(filename) = poi.image_path.as_ref() {
            let img_path = image_dir.join(filename);
            if img_path.exists() {
                let bytes = std::fs::read(&img_path).map_err(|e| e.to_string())?;
                zip.start_file(format!("poi_images/{}", filename), options.clone()).map_err(|e| e.to_string())?;
                zip.write_all(&bytes).map_err(|e| e.to_string())?;
            }
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn export_settings_backup(state: State<Arc<AppState>>) -> Result<String, String> {
    let settings = settings_from_data(&state.data.lock().unwrap());
    let content = serde_json::to_string_pretty(&serde_json::json!({
        "type": "scum-walker-settings-backup",
        "exportedAt": Utc::now().to_rfc3339(),
        "settings": settings,
    })).map_err(|e| e.to_string())?;
    save_backup_file("Einstellungen-Backup exportieren", "scum-walker-settings-backup.json", &content)
}

#[tauri::command]
fn export_full_backup(state: State<Arc<AppState>>) -> Result<String, String> {
    let data = state.data.lock().unwrap().clone();
    let settings = settings_from_data(&data);
    let content = serde_json::to_string_pretty(&serde_json::json!({
        "type": "scum-walker-full-backup",
        "exportedAt": Utc::now().to_rfc3339(),
        "routes": data.routes,
        "pois": data.pois,
        "settings": settings,
    })).map_err(|e| e.to_string())?;
    save_backup_file("Komplett-Backup exportieren", "scum-walker-full-backup.json", &content)
}

#[tauri::command]
fn import_full_backup(state: State<Arc<AppState>>) -> Result<AppData, String> {
    let path = pick_backup_file("Komplett-Backup importieren")?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let routes: Vec<Route> = serde_json::from_value(value.get("routes").cloned().unwrap_or(serde_json::json!([])))
        .map_err(|e| format!("Ungültiges Backup (Routen): {}", e))?;
    let pois: Vec<Poi> = serde_json::from_value(value.get("pois").cloned().unwrap_or(serde_json::json!([])))
        .map_err(|e| format!("Ungültiges Backup (POIs): {}", e))?;
    let settings: Option<AppSettings> = value.get("settings").and_then(|s| serde_json::from_value(s.clone()).ok());

    let mut data = state.data.lock().unwrap();
    data.routes = routes;
    data.pois = pois;
    data.current_route_id = data.routes.last().map(|r| r.id.clone());
    if let Some(settings) = settings {
        apply_settings_to_data(&mut data, &settings)?;
    }
    save_data(&state.data_path, &data);
    apply_nav_route_color(&state, &data.nav_route_color);
    let clone = data.clone();
    if let Some(app_handle) = state.app_handle.lock().unwrap().as_ref() {
        let _ = app_handle.emit("data-updated", &clone);
    }
    Ok(clone)
}

#[tauri::command]
fn import_routes_backup(state: State<Arc<AppState>>) -> Result<AppData, String> {
    let path = pick_backup_file("Routen-Backup importieren")?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let mut imported: Vec<Route> = serde_json::from_value(
        value.get("routes").cloned().unwrap_or(value),
    ).map_err(|e| format!("Ungültiges Routen-Backup: {}", e))?;
    for (offset, route) in imported.iter_mut().enumerate() {
        route.id = fresh_id(offset);
    }

    let mut data = state.data.lock().unwrap();
    data.routes.extend(imported);
    save_data(&state.data_path, &data);
    let clone = data.clone();
    if let Some(app_handle) = state.app_handle.lock().unwrap().as_ref() {
        let _ = app_handle.emit("data-updated", &clone);
    }
    Ok(clone)
}

#[tauri::command]
fn import_pois_backup(state: State<Arc<AppState>>) -> Result<AppData, String> {
    let path = pick_backup_file("POI-Backup importieren")?;
    let app_data_dir = app_data_dir(&state)?;

    let mut imported: Vec<Poi>;
    let mut images_to_restore: Vec<(String, Vec<u8>)> = Vec::new();

    if is_zip_file(&path) {
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let mut zip = zip::read::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut manifest_bytes: Option<Vec<u8>> = None;

        for i in 0..zip.len() {
            let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = file.name().to_string();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;

            if name == "pois.json" {
                manifest_bytes = Some(bytes);
            } else if name.starts_with("poi_images/") {
                if let Some(filename) = Path::new(&name).file_name().and_then(|n| n.to_str()) {
                    images_to_restore.push((filename.to_string(), bytes));
                }
            }
        }

        let manifest = manifest_bytes.ok_or("ZIP enthält keine pois.json")?;
        let value: serde_json::Value = serde_json::from_slice(&manifest).map_err(|e| e.to_string())?;
        imported = serde_json::from_value(
            value.get("pois").cloned().unwrap_or(value),
        ).map_err(|e| format!("Ungültiges POI-Backup: {}", e))?;
    } else {
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        imported = serde_json::from_value(
            value.get("pois").cloned().unwrap_or(value),
        ).map_err(|e| format!("Ungültiges POI-Backup: {}", e))?;
    }

    for (offset, poi) in imported.iter_mut().enumerate() {
        poi.id = fresh_id(offset);
        if poi.category.is_empty() {
            poi.category = compute_sector(poi.x, poi.y);
        }
    }

    if !images_to_restore.is_empty() {
        let image_dir = app_data_dir.join("poi_images");
        let _ = std::fs::create_dir_all(&image_dir);
        for (filename, bytes) in images_to_restore {
            let _ = std::fs::write(image_dir.join(&filename), bytes);
        }
    }

    let mut data = state.data.lock().unwrap();
    data.pois.extend(imported);
    save_data(&state.data_path, &data);
    let clone = data.clone();
    if let Some(app_handle) = state.app_handle.lock().unwrap().as_ref() {
        let _ = app_handle.emit("data-updated", &clone);
    }
    Ok(clone)
}

#[tauri::command]
fn import_settings_backup(state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    let path = pick_backup_file("Einstellungen-Backup importieren")?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let settings: AppSettings = serde_json::from_value(
        value.get("settings").cloned().unwrap_or(value),
    ).map_err(|e| format!("Ungültiges Einstellungen-Backup: {}", e))?;

    let mut data = state.data.lock().unwrap();
    apply_settings_to_data(&mut data, &settings)?;
    save_data(&state.data_path, &data);
    apply_nav_route_color(&state, &data.nav_route_color);
    Ok(settings_from_data(&data))
}

fn app_data_dir(state: &State<Arc<AppState>>) -> Result<PathBuf, String> {
    state.data_path.parent()
        .ok_or_else(|| "Konnte AppData-Verzeichnis nicht ermitteln".to_string())
        .map(|p| p.to_path_buf())
}

#[tauri::command]
fn export_full_zip_backup(state: State<Arc<AppState>>, include_images: bool) -> Result<String, String> {
    let data = state.data.lock().unwrap().clone();
    let settings = settings_from_data(&data);
    let nav_target = state.nav_target.lock().unwrap().clone();
    let nav_route_color = state.nav_route_color.lock().unwrap().clone();
    let app_data_dir = app_data_dir(&state)?;

    let filename = format!("scum-walker-full-backup-{}.zip", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    let path = rfd::FileDialog::new()
        .set_title("Komplett-ZIP-Backup exportieren")
        .set_file_name(&filename)
        .add_filter("ZIP-Datei", &["zip"])
        .save_file()
        .ok_or("Export abgebrochen")?;

    let file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::<zip::write::ExtendedFileOptions>::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o644);

    zip.start_file("scum_walker_data.json", options.clone()).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;

    zip.start_file("nav_target.json", options.clone()).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&nav_target).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;

    zip.start_file("nav_route_color.json", options.clone()).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&serde_json::json!({"color": nav_route_color})).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;

    zip.start_file("settings.json", options.clone()).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string_pretty(&serde_json::json!({
        "type": "scum-walker-settings-backup",
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "settings": settings,
    })).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;

    if include_images {
        let image_dir = app_data_dir.join("poi_images");
        if image_dir.exists() {
            for entry in std::fs::read_dir(&image_dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                if path.is_file() {
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("unknown");
                    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                    zip.start_file(format!("poi_images/{}", name), options.clone()).map_err(|e| e.to_string())?;
                    zip.write_all(&bytes).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn import_full_zip_backup(state: State<Arc<AppState>>) -> Result<AppData, String> {
    let path = rfd::FileDialog::new()
        .set_title("Komplett-ZIP-Backup importieren")
        .add_filter("ZIP-Datei", &["zip"])
        .pick_file()
        .ok_or("Import abgebrochen")?;

    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut zip = zip::read::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let app_data_dir = app_data_dir(&state)?;

    let mut routes: Option<Vec<Route>> = None;
    let mut pois: Option<Vec<Poi>> = None;
    let mut settings: Option<AppSettings> = None;

    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;

        match name.as_str() {
            "scum_walker_data.json" => {
                let data: AppData = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("Ungültige Daten-Datei im ZIP: {}", e))?;
                routes = Some(data.routes);
                pois = Some(data.pois);
            }
            "settings.json" => {
                let value: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("Ungültige Einstellungen-Datei im ZIP: {}", e))?;
                settings = value.get("settings").and_then(|s| serde_json::from_value(s.clone()).ok());
            }
            s if s.starts_with("poi_images/") => {
                if let Some(file_name) = Path::new(s).file_name().and_then(|n| n.to_str()) {
                    let image_dir = app_data_dir.join("poi_images");
                    let _ = std::fs::create_dir_all(&image_dir);
                    let _ = std::fs::write(image_dir.join(file_name), bytes);
                }
            }
            _ => {}
        }
    }

    let mut data = state.data.lock().unwrap();
    if let Some(routes) = routes {
        data.routes = routes;
        data.current_route_id = data.routes.last().map(|r| r.id.clone());
    }
    if let Some(pois) = pois {
        data.pois = pois;
    }
    if let Some(settings) = settings {
        apply_settings_to_data(&mut data, &settings)?;
    }
    save_data(&state.data_path, &data);
    apply_nav_route_color(&state, &data.nav_route_color);
    let clone = data.clone();
    if let Some(app_handle) = state.app_handle.lock().unwrap().as_ref() {
        let _ = app_handle.emit("data-updated", &clone);
    }
    Ok(clone)
}

const HIRES_TILES_URL: &str = "https://github.com/HellBz/Scum-Walker/releases/latest/download/tiles-hires.zip";
const LOWRES_TILES_ZIP: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/tiles-lowres.zip"));
const GITHUB_LATEST_RELEASE_URL: &str = "https://api.github.com/repos/HellBz/SCUM-Walker/releases/latest";

#[derive(Serialize, Deserialize, Debug, Clone)]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    url: String,
    is_windows: bool,
}

fn release_version() -> &'static str {
    option_env!("RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[tauri::command]
fn get_version() -> String {
    release_version().to_string()
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let current = release_version().to_string();
    let updater = app.updater()
        .map_err(|e| format!("Updater nicht verfügbar: {}", e))?;
    let update = updater.check().await
        .map_err(|e| format!("Update-Check fehlgeschlagen: {}", e))?;
    match update {
        Some(update) => {
            Ok(Some(UpdateInfo {
                current_version: current,
                latest_version: update.version.clone(),
                url: GITHUB_LATEST_RELEASE_URL.to_string(),
                is_windows: cfg!(windows),
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater()
        .map_err(|e| format!("Updater nicht verfügbar: {}", e))?;
    let update = updater.check().await
        .map_err(|e| format!("Update-Check fehlgeschlagen: {}", e))?;
    match update {
        Some(update) => {
            let mut total_size: Option<u64> = None;
            update.download_and_install(
                move |chunk_length, content_length| {
                    if let Some(total) = content_length {
                        total_size = Some(total);
                    }
                    let _ = total_size;
                    let _ = chunk_length;
                },
                || {},
            ).await
                .map_err(|e| format!("Update-Installation fehlgeschlagen: {}", e))?;
            app.restart();
        }
        None => Err("Kein Update verfügbar".to_string()),
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("Öffnen externer URLs ist nur unter Windows verfügbar".to_string())
    }
}

fn get_tiles_dir(app: &tauri::AppHandle) -> PathBuf {
    match app.path().app_data_dir() {
        Ok(dir) => dir.join("tiles"),
        Err(e) => {
            eprintln!("[tiles] WARN: app_data_dir() fehlgeschlagen: {}, nutze lokales Verzeichnis", e);
            let fallback = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            fallback.join("tiles")
        }
    }
}

fn ensure_lowres_tiles(tiles_dir: &PathBuf) {
    let z0 = tiles_dir.join("0");
    if z0.exists() && z0.is_dir() {
        return;
    }
    eprintln!("[tiles] Entpacke Low-Res Tiles nach {}", tiles_dir.display());
    let cursor = std::io::Cursor::new(LOWRES_TILES_ZIP);
    match zip::ZipArchive::new(cursor) {
        Ok(mut archive) => {
            for i in 0..archive.len() {
                if let Ok(mut file) = archive.by_index(i) {
                    let outpath = match file.enclosed_name() {
                        Some(path) => tiles_dir.join(path),
                        None => continue,
                    };
                    if file.is_dir() {
                        std::fs::create_dir_all(&outpath).ok();
                        continue;
                    }
                    if let Some(parent) = outpath.parent() {
                        std::fs::create_dir_all(parent).ok();
                    }
                    if let Ok(mut outfile) = std::fs::File::create(&outpath) {
                        std::io::copy(&mut file, &mut outfile).ok();
                    }
                }
            }
            eprintln!("[tiles] Low-Res Tiles entpackt");
        }
        Err(e) => eprintln!("[tiles] Fehler beim Entpacken: {}", e),
    }
}

fn emit_hires_progress(app_handle: &tauri::AppHandle, phase: &str, percent: f64, text: String) {
    let _ = app_handle.emit("hires-download-progress", serde_json::json!({
        "phase": phase,
        "percent": percent,
        "text": text,
    }));
}

#[tauri::command]
async fn download_hires_tiles(app_handle: tauri::AppHandle) -> Result<(), String> {
    emit_hires_progress(&app_handle, "download", 0.0, "Verbinde...".to_string());

    // No overall request timeout here (a big ZIP can legitimately take a long time on a
    // slow connection) - instead each individual chunk read below is bounded, so a
    // stalled/dead connection fails with a clear error instead of hanging the download
    // (and the "downloading..." UI) forever.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP-Client konnte nicht erstellt werden: {}", e))?;

    let mut response = client.get(HIRES_TILES_URL).send().await
        .map_err(|e| format!("Download fehlgeschlagen: {}", e))?;
    let total_size = response.content_length();

    let mut data = Vec::with_capacity(total_size.unwrap_or(0) as usize);
    let mut downloaded: u64 = 0;
    let mut last_report = std::time::Instant::now();
    loop {
        let chunk = match tokio::time::timeout(Duration::from_secs(30), response.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(format!("Download fehlgeschlagen: {}", e)),
            Err(_) => return Err("Download fehlgeschlagen: keine Daten mehr empfangen (Verbindung hängt/zu langsam)".to_string()),
        };
        downloaded += chunk.len() as u64;
        data.extend_from_slice(&chunk);
        if last_report.elapsed().as_millis() >= 250 {
            last_report = std::time::Instant::now();
            let (percent, msg) = match total_size {
                Some(total) if total > 0 => (
                    (downloaded as f64 / total as f64) * 100.0,
                    format!(
                        "Lade tiles-hires.zip herunter ({} / {} MB)...",
                        downloaded / 1024 / 1024, total / 1024 / 1024
                    ),
                ),
                _ => (0.0, format!("Lade tiles-hires.zip herunter ({} MB)...", downloaded / 1024 / 1024)),
            };
            emit_hires_progress(&app_handle, "download", percent, msg);
        }
    }
    emit_hires_progress(&app_handle, "extract", 0.0, format!("ZIP geladen ({} MB), entpacke...", data.len() / 1024 / 1024));

    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("ZIP konnte nicht geöffnet werden: {}", e))?;

    let tiles_dir = get_tiles_dir(&app_handle);
    let total_files = archive.len();
    let mut count = 0;
    for i in 0..total_files {
        let mut file = archive.by_index(i).map_err(|e| format!("ZIP-Fehler: {}", e))?;
        let outpath = match file.enclosed_name() {
            Some(path) => tiles_dir.join(path),
            None => continue,
        };
        if file.is_dir() {
            std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        count += 1;
        if count % 100 == 0 || i == total_files - 1 {
            let percent = (i as f64 + 1.0) / total_files as f64 * 100.0;
            emit_hires_progress(&app_handle, "extract", percent, format!("Entpackt: {} Dateien...", count));
        }
    }

    emit_hires_progress(&app_handle, "done", 100.0, format!("Fertig! {} Tiles entpackt.", count));
    let _ = app_handle.emit("hires-tiles-installed", ());
    ws_broadcast(serde_json::json!(["hires-tiles-installed", null]).to_string());
    Ok(())
}

#[tauri::command]
fn check_hires_tiles(app_handle: tauri::AppHandle) -> bool {
    let z4 = get_tiles_dir(&app_handle).join("4");
    z4.exists() && z4.is_dir()
}

#[tauri::command]
fn new_route(state: State<Arc<AppState>>, name: String, color: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    let route = Route::new(name, color);
    data.current_route_id = Some(route.id.clone());
    data.routes.push(route);
    save_data(&state.data_path, &data);
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn select_route(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.current_route_id = Some(id);
    save_data(&state.data_path, &data);
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn rename_route(state: State<Arc<AppState>>, id: String, name: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.name = name;
        save_data(&state.data_path, &data);
    }
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn delete_route(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.routes.retain(|r| r.id != id);
    if data.current_route_id.as_ref() == Some(&id) {
        data.current_route_id = data.routes.last().map(|r| r.id.clone());
    }
    save_data(&state.data_path, &data);
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn set_route_color(state: State<Arc<AppState>>, id: String, color: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.color = color;
        save_data(&state.data_path, &data);
    }
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn toggle_route_visibility(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.visible = !route.visible;
        save_data(&state.data_path, &data);
    }
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn toggle_recording(state: State<Arc<AppState>>) -> bool {
    let mut recording = state.recording.lock().unwrap();
    *recording = !*recording;
    let is_recording = *recording;
    // recording requires live tracking
    if is_recording {
        let mut tracking = state.live_tracking.lock().unwrap();
        if !*tracking {
            *tracking = true;
            ws_broadcast(serde_json::json!(["tracking-state", {"recording": true, "live_tracking": true}]).to_string());
        }
    }
    ws_broadcast(serde_json::json!(["tracking-state", {"recording": is_recording, "live_tracking": *state.live_tracking.lock().unwrap()}]).to_string());
    is_recording
}

#[tauri::command]
fn is_recording(state: State<Arc<AppState>>) -> bool {
    *state.recording.lock().unwrap()
}

#[tauri::command]
fn toggle_live_tracking(state: State<Arc<AppState>>) -> bool {
    let mut tracking = state.live_tracking.lock().unwrap();
    *tracking = !*tracking;
    let is_tracking = *tracking;
    ws_broadcast(serde_json::json!(["tracking-state", {"recording": *state.recording.lock().unwrap(), "live_tracking": is_tracking}]).to_string());
    is_tracking
}

#[tauri::command]
fn is_live_tracking(state: State<Arc<AppState>>) -> bool {
    *state.live_tracking.lock().unwrap()
}

#[tauri::command]
fn set_tracking_interval(state: State<Arc<AppState>>, seconds: u64) {
    if seconds >= 1 {
        let mut data = state.data.lock().unwrap();
        data.tracking_interval = seconds;
        save_data(&state.data_path, &data);
        ws_broadcast(serde_json::json!(["tracking-interval", seconds]).to_string());
    }
}

#[tauri::command]
fn get_tracking_interval(state: State<Arc<AppState>>) -> u64 {
    state.data.lock().unwrap().tracking_interval
}

#[tauri::command]
fn ws_broadcast_msg(message: String) {
    ws_broadcast(message);
}

pub(crate) fn apply_poi_connections(state: &Arc<AppState>, ids: Vec<String>) {
    *state.poi_connections.lock().unwrap() = ids.clone();
    {
        let mut data = state.data.lock().unwrap();
        data.poi_connections = ids.clone();
    }
    let _ = save_data(&state.data_path, &state.data.lock().unwrap());
    let payload = serde_json::json!(["poi-connections", ids]);
    if let Some(app_handle) = state.app_handle.lock().unwrap().as_ref() {
        let _ = app_handle.emit("poi-connections", &payload);
    }
    ws_broadcast(payload.to_string());
}

#[tauri::command]
fn set_poi_connections(state: State<Arc<AppState>>, ids: Vec<String>) {
    apply_poi_connections(&state, ids);
}

#[tauri::command]
fn get_poi_connections(state: State<Arc<AppState>>) -> Vec<String> {
    state.poi_connections.lock().unwrap().clone()
}

#[tauri::command]
fn get_player_position(state: State<Arc<AppState>>) -> Option<CoordRecord> {
    state.current_position.lock().unwrap().clone()
}

#[tauri::command]
fn get_nav_target(state: State<Arc<AppState>>) -> Option<serde_json::Value> {
    state.nav_target.lock().unwrap().clone().map(|t| serde_json::json!({"x": t.x, "y": t.y}))
}

#[tauri::command]
fn set_nav_target(x: f64, y: f64, state: State<Arc<AppState>>, app_handle: tauri::AppHandle) {
    let target = CoordRecord { time: chrono::Utc::now(), x, y, z: 0.0, pitch: 0.0, yaw: 0.0, roll: 0.0 };
    *state.nav_target.lock().unwrap() = Some(target.clone());
    save_nav_target(&state.nav_target_path, &Some(target));
    let payload = serde_json::json!({"x": x, "y": y});
    let _ = app_handle.emit("nav-target", payload.clone());
    ws_broadcast(serde_json::json!(["nav-target", payload]).to_string());
}

#[tauri::command]
fn clear_nav_target(state: State<Arc<AppState>>, app_handle: tauri::AppHandle) {
    *state.nav_target.lock().unwrap() = None;
    save_nav_target(&state.nav_target_path, &None);
    let _ = app_handle.emit("nav-cleared", ());
    ws_broadcast(serde_json::json!(["nav-cleared"]).to_string());
}

pub(crate) fn apply_nav_route_color(state: &Arc<AppState>, color: &str) {
    let color = color.to_string();
    *state.nav_route_color.lock().unwrap() = color.clone();
    save_nav_route_color(&state.nav_route_color_path, &color);
    if let Some(app_handle) = state.app_handle.lock().unwrap().as_ref() {
        let _ = app_handle.emit("nav-route-color", &color);
    }
    ws_broadcast(serde_json::json!(["nav-route-color", color]).to_string());
}

#[tauri::command]
fn get_nav_route_color(state: State<Arc<AppState>>) -> String {
    state.nav_route_color.lock().unwrap().clone()
}

#[tauri::command]
fn set_nav_route_color(state: State<Arc<AppState>>, color: String) -> Result<(), String> {
    let color = color.trim().to_lowercase();
    if !color.starts_with('#') || color.len() != 7 || !color.chars().skip(1).all(|c| c.is_ascii_hexdigit()) {
        return Err("Ungültige Farbe. Bitte #RRGGBB verwenden.".to_string());
    }
    apply_nav_route_color(&state, &color);
    Ok(())
}

pub(crate) fn apply_add_poi(state: &Arc<AppState>, mut poi: Poi) -> AppData {
    if poi.category.is_empty() {
        poi.category = compute_sector(poi.x, poi.y);
    }
    let mut data = state.data.lock().unwrap();
    data.pois.push(poi);
    save_data(&state.data_path, &data);
    let clone = data.clone();
    if let Some(app_handle) = state.app_handle.lock().unwrap().as_ref() {
        let _ = app_handle.emit("data-updated", &clone);
    }
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn add_poi(state: State<Arc<AppState>>, poi: Poi) -> AppData {
    apply_add_poi(&state, poi)
}

#[tauri::command]
fn update_poi(state: State<Arc<AppState>>, id: String, label: String, color: String, category: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(poi) = data.pois.iter_mut().find(|poi| poi.id == id) {
        poi.label = label;
        poi.color = color;
        poi.category = if category.is_empty() { compute_sector(poi.x, poi.y) } else { category };
        save_data(&state.data_path, &data);
    }
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn remove_poi(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.pois.retain(|p| p.id != id);
    save_data(&state.data_path, &data);
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn toggle_hidden_category(state: State<Arc<AppState>>, category: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(pos) = data.hidden_categories.iter().position(|c| c == &category) {
        data.hidden_categories.remove(pos);
    } else {
        data.hidden_categories.push(category);
    }
    save_data(&state.data_path, &data);
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    clone
}

#[tauri::command]
fn paste_poi_screenshot(state: State<Arc<AppState>>, id: String) -> Result<AppData, String> {
    let img = capture_scum_window().ok_or_else(|| "Konnte SCUM-Fenster nicht aufnehmen".to_string())?;

    let image_dir = state.data_path.parent().unwrap_or(&state.data_path).join("poi_images");
    std::fs::create_dir_all(&image_dir).map_err(|e| e.to_string())?;
    let filename = format!("poi_{}.png", id);
    let path = image_dir.join(&filename);
    img.save_with_format(&path, image::ImageFormat::Png).map_err(|e| e.to_string())?;

    let mut data = state.data.lock().unwrap();
    if let Some(poi) = data.pois.iter_mut().find(|p| p.id == id) {
        poi.image_path = Some(filename);
        save_data(&state.data_path, &data);
    }
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    Ok(clone)
}

#[tauri::command]
fn get_poi_image_base64(state: State<Arc<AppState>>, id: String) -> Result<String, String> {
    let data = state.data.lock().unwrap();
    let poi = data.pois.iter().find(|p| p.id == id).ok_or("POI nicht gefunden")?;
    let filename = poi.image_path.as_ref().ok_or("Kein Bild vorhanden")?;
    let image_dir = state.data_path.parent().unwrap_or(&state.data_path).join("poi_images");
    let path = image_dir.join(filename);
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::{prelude::BASE64_STANDARD, Engine};
    Ok(BASE64_STANDARD.encode(bytes))
}

#[tauri::command]
fn upload_poi_image(state: State<Arc<AppState>>, id: String, base64_data: String) -> Result<AppData, String> {
    let image_dir = state.data_path.parent().unwrap_or(&state.data_path).join("poi_images");
    std::fs::create_dir_all(&image_dir).map_err(|e| e.to_string())?;
    let filename = format!("poi_{}.png", id);
    let path = image_dir.join(&filename);

    use base64::{prelude::BASE64_STANDARD, Engine};
    let bytes = BASE64_STANDARD.decode(base64_data.trim())
        .map_err(|e| format!("Base64 decode Fehler: {}", e))?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    let mut data = state.data.lock().unwrap();
    if let Some(poi) = data.pois.iter_mut().find(|p| p.id == id) {
        poi.image_path = Some(filename);
        save_data(&state.data_path, &data);
    }
    let clone = data.clone();
    ws_broadcast(serde_json::json!(["data-updated", clone]).to_string());
    Ok(clone)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SidebarState {
    #[serde(default)]
    livemap_collapsed: bool,
    #[serde(default)]
    routes_collapsed: bool,
    #[serde(default)]
    pois_collapsed: bool,
}

fn sidebar_state_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("sidebar_state.json")
}

fn load_sidebar_state(path: &PathBuf) -> SidebarState {
    if !path.exists() {
        return SidebarState::default();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_sidebar_state_file(path: &PathBuf, state: &SidebarState) {
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = fs::write(path, json);
    }
}

#[tauri::command]
fn get_sidebar_state(app: tauri::AppHandle) -> SidebarState {
    load_sidebar_state(&sidebar_state_path(&app))
}

#[tauri::command]
fn save_sidebar_state(app: tauri::AppHandle, state: SidebarState) -> Result<(), String> {
    save_sidebar_state_file(&sidebar_state_path(&app), &state);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct OverlayConfig {
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    opacity: Option<f64>,
}

fn create_overlay_window(app: &tauri::AppHandle, config: &OverlayConfig) -> Result<tauri::WebviewWindow, String> {
    let w = config.width.filter(|&w| w >= 200).unwrap_or(450);
    let h = config.height.filter(|&h| h >= 200).unwrap_or(450);
    eprintln!("[overlay] Erstelle Fenster: {}x{} an {:?},{:?}", w, h, config.x, config.y);
    let mut overlay_builder = WebviewWindowBuilder::new(app, "overlay", tauri::WebviewUrl::App("overlay.html".into()))
        .title("SCUM Walker Overlay")
        .inner_size(w as f64, h as f64)
        .min_inner_size(200.0, 200.0)
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .visible(false);
    #[cfg(windows)]
    {
        overlay_builder = overlay_builder.transparent(true);
    }
    if let (Some(x), Some(y)) = (config.x, config.y) {
        if x > -10000 && y > -10000 {
            // outer_position() returns physical pixels, but builder position() expects logical
            let scale = app.get_webview_window("main")
                .and_then(|w| w.scale_factor().ok())
                .unwrap_or(1.0);
            let logical_x = x as f64 / scale;
            let logical_y = y as f64 / scale;
            eprintln!("[overlay] Position logisch: {},{} (aus physisch {},{}, scale {})", logical_x, logical_y, x, y, scale);
            overlay_builder = overlay_builder.position(logical_x, logical_y);
        }
    }
    overlay_builder.build().map_err(|e| e.to_string())
}

fn overlay_config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("overlay_config.json")
}

fn load_overlay_config(path: &PathBuf) -> OverlayConfig {
    if !path.exists() {
        return OverlayConfig::default();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_overlay_config_file(path: &PathBuf, config: &OverlayConfig) {
    if let Ok(json) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, json);
    }
}

fn save_overlay_config_from_window(app: &tauri::AppHandle, window: &tauri::Window) {
    let Ok(position) = window.outer_position() else { return; };
    let Ok(size) = window.inner_size() else { return; };
    if position.x <= -32000 || position.y <= -32000 || size.width == 0 || size.height == 0 {
        return;
    }
    // Convert physical pixels to logical for storage
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical_w = (size.width as f64 / scale).round() as u32;
    let logical_h = (size.height as f64 / scale).round() as u32;
    eprintln!("[overlay] Speichere: {}x{} (logisch) aus {}x{} (physisch) an {},{}", logical_w, logical_h, size.width, size.height, position.x, position.y);
    let existing = load_overlay_config(&overlay_config_path(app));
    let config = OverlayConfig {
        x: Some(position.x),
        y: Some(position.y),
        width: Some(logical_w),
        height: Some(logical_h),
        opacity: existing.opacity,
    };
    save_overlay_config_file(&overlay_config_path(app), &config);
}

#[tauri::command]
fn save_overlay_config(app: tauri::AppHandle, config: OverlayConfig) -> Result<(), String> {
    let path = overlay_config_path(&app);
    save_overlay_config_file(&path, &config);
    Ok(())
}

#[tauri::command]
fn save_overlay_state(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("overlay").ok_or("Overlay nicht gefunden")?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    if position.x <= -32000 || position.y <= -32000 || size.width == 0 || size.height == 0 {
        return Ok(());
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical_w = (size.width as f64 / scale).round() as u32;
    let logical_h = (size.height as f64 / scale).round() as u32;
    let path = overlay_config_path(&app);
    let existing = load_overlay_config(&path);
    let config = OverlayConfig {
        x: Some(position.x),
        y: Some(position.y),
        width: Some(logical_w),
        height: Some(logical_h),
        opacity: existing.opacity,
    };
    save_overlay_config_file(&path, &config);
    Ok(())
}

#[tauri::command]
fn get_overlay_config(app: tauri::AppHandle) -> OverlayConfig {
    let path = overlay_config_path(&app);
    load_overlay_config(&path)
}

#[tauri::command]
fn reset_overlay_config(app: tauri::AppHandle) -> Result<(), String> {
    let path = overlay_config_path(&app);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: 450.0, height: 450.0 }));
        if let Ok(monitor) = window.current_monitor() {
            if let Some(m) = monitor {
                let size = m.size();
                let x = (size.width as i32 - 450) / 2;
                let y = (size.height as i32 - 450) / 2;
                let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
            }
        }
    }
    Ok(())
}

fn livemap_url() -> String {
    let port = http_server::HTTP_PORT.get().copied().unwrap_or(4488);
    if port == 80 {
        "http://127.0.0.1/livemap.html?v=4".to_string()
    } else {
        format!("http://127.0.0.1:{}/livemap.html?v=4", port)
    }
}

#[tauri::command]
fn get_livemap_url() -> String {
    livemap_url()
}

#[tauri::command]
fn is_scum_running() -> bool {
    scum_is_running()
}

// Debug: liefert, welches Fenster/Prozess find_scum_window() aktuell konkret
// erkennt (oder None, falls keins gefunden wird) - im Gegensatz zu is_scum_running,
// das nur einen bool liefert.
#[cfg(windows)]
#[tauri::command]
fn get_scum_window_info() -> Option<WindowInfo> {
    let hwnd = find_scum_window()?;
    let (pid, process_name, title) = window_process_info(hwnd);
    Some(WindowInfo { hwnd: hwnd.0, title, pid, process_name })
}

#[cfg(not(windows))]
#[tauri::command]
fn get_scum_window_info() -> Option<WindowInfo> {
    None
}

#[tauri::command]
fn copy_livemap_url() -> Result<(), String> {
    use arboard::Clipboard;
    let url = livemap_url();
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(url).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn close_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_overlay_clickthrough(app: tauri::AppHandle, clickthrough: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        window.set_ignore_cursor_events(clickthrough).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.get_webview_window("main").map(|w| {
                let _ = w.show();
                let _ = w.set_focus();
            });
        }))
        .plugin(tauri_plugin_updater::Builder::new()
            .default_version_comparator({
                let current_version = release_version().trim_start_matches('v').to_string();
                move |_current: semver::Version, release: tauri_plugin_updater::RemoteRelease| {
                    let release_version = release.version.to_string();
                    let release_version = release_version.trim_start_matches('v');
                    match (semver::Version::parse(&current_version), semver::Version::parse(release_version)) {
                        (Ok(c), Ok(r)) => r > c,
                        _ => release_version != current_version,
                    }
                }
            })
            .build())
        .setup(move |app| {
            let data_path = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("scum_walker_data.json");

            let nav_target_path = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("nav_target.json");

            let nav_route_color_path = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("nav_route_color.json");

            let mut data = load_data(&data_path);
            let saved_nav_target = load_nav_target(&nav_target_path);
            let file_nav_route_color = load_nav_route_color(&nav_route_color_path);
            if file_nav_route_color != default_nav_route_color() {
                data.nav_route_color = file_nav_route_color;
                save_data(&data_path, &data);
            }
            let nav_route_color = data.nav_route_color.clone();
            let state = Arc::new(AppState {
                data: Mutex::new(data.clone()),
                data_path,
                recording: Mutex::new(false),
                live_tracking: Mutex::new(false),
                current_position: Mutex::new(data.player_position.clone()),
                poi_connections: Mutex::new(data.poi_connections.clone()),
                big_map_active: Mutex::new(false),
                bigmap_modal_open: Mutex::new(false),
                app_handle: Mutex::new(None),
                nav_target: Mutex::new(saved_nav_target),
                nav_target_path,
                nav_route_color: Mutex::new(nav_route_color),
                nav_route_color_path,
            });
            *state.app_handle.lock().unwrap() = Some(app.handle().clone());

            if state.data.lock().unwrap().auto_start_live_tracking {
                *state.live_tracking.lock().unwrap() = true;
                let _ = app.handle().emit("live-tracking-state", true);
            }

            #[cfg(windows)]
            start_hotkey_watcher(state.clone(), app.handle().clone());
            #[cfg(windows)]
            start_bigmap_hotkey_watcher(state.clone(), app.handle().clone());
            start_recorder(state.clone(), app.handle().clone());
            let tiles_dir = get_tiles_dir(&app.handle());
            if let Err(e) = std::fs::create_dir_all(&tiles_dir) {
                eprintln!("[tiles] FEHLER: Konnte Verzeichnis nicht erstellen: {} -> {}", tiles_dir.display(), e);
            } else {
                eprintln!("[tiles] Verzeichnis: {}", tiles_dir.display());
            }
            ensure_lowres_tiles(&tiles_dir);
            http_server::start_http_server(state.clone(), tiles_dir.display().to_string());

            let overlay_config = load_overlay_config(&overlay_config_path(&app.handle()));
            let _ = create_overlay_window(&app.handle(), &overlay_config);

            let settings = settings_from_data(&state.data.lock().unwrap());
            if settings.auto_open_overlay {
                let _ = open_overlay(app.handle().clone());
            }
            if settings.auto_lock_overlay {
                let _ = set_overlay_clickthrough(app.handle().clone(), true);
            }

            app.manage(state);

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    if let Some(overlay) = window.app_handle().get_webview_window("overlay") {
                        let _ = overlay.close();
                    }
                }
            } else if window.label() == "overlay" {
                match event {
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        save_overlay_config_from_window(&window.app_handle(), window);
                    }
                    tauri::WindowEvent::CloseRequested { .. } => {
                        save_overlay_config_from_window(&window.app_handle(), window);
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_data,
            get_settings,
            save_settings,
            export_data,
            export_full_backup,
            export_routes_backup,
            export_pois_backup,
            export_settings_backup,
            import_full_backup,
            import_routes_backup,
            import_pois_backup,
            import_settings_backup,
            export_full_zip_backup,
            import_full_zip_backup,
            get_version,
            check_update,
            install_update,
            open_url,
            get_current_location,
            download_hires_tiles,
            check_hires_tiles,
            new_route,
            select_route,
            rename_route,
            delete_route,
            set_route_color,
            toggle_route_visibility,
            toggle_recording,
            is_recording,
            toggle_live_tracking,
            is_live_tracking,
            set_tracking_interval,
            get_tracking_interval,
            ws_broadcast_msg,
            set_poi_connections,
            get_poi_connections,
            get_player_position,
            get_nav_target,
            set_nav_target,
            clear_nav_target,
            get_nav_route_color,
            set_nav_route_color,
            add_poi,
            update_poi,
            remove_poi,
            toggle_hidden_category,
            paste_poi_screenshot,
            get_poi_image_base64,
            upload_poi_image,
            copy_livemap_url,
            get_livemap_url,
            is_scum_running,
            open_overlay,
            close_overlay,
            set_overlay_clickthrough,
            save_overlay_config,
            save_overlay_state,
            get_overlay_config,
            reset_overlay_config,
            get_sidebar_state,
            save_sidebar_state,
            list_visible_windows,
            set_manual_scum_window,
            clear_manual_scum_window,
            get_manual_scum_window,
            get_scum_window_info
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
