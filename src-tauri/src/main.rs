#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use arboard::Clipboard;
use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tauri::webview::WebviewWindowBuilder;

mod http_server;

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, WPARAM};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    SRCCOPY,
};
#[cfg(windows)]
use windows::Win32::System::ProcessStatus::GetModuleFileNameExW;
#[cfg(windows)]
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClientRect, GetWindowThreadProcessId, IsWindowVisible,
    PostMessageW, SetForegroundWindow, WM_KEYDOWN, WM_KEYUP,
};

const INTERVAL_SECONDS: u64 = 10;
const SCUM_WINDOW_TITLES: &[&str] = &["SCUM", "SCUM ", "SCUM Early Access"];

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
struct Poi {
    id: String,
    label: String,
    x: f64,
    y: f64,
    #[serde(rename = "type")]
    poi_type: String,
    color: String,
    #[serde(default)]
    image_path: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
struct AppData {
    routes: Vec<Route>,
    current_route_id: Option<String>,
    pois: Vec<Poi>,
}

pub(crate) struct AppState {
    data: Mutex<AppData>,
    data_path: PathBuf,
    recording: Mutex<bool>,
    live_tracking: Mutex<bool>,
    current_position: Mutex<Option<CoordRecord>>,
    chat_paused: Mutex<bool>,
}

impl AppState {
    pub(crate) fn app_data(&self) -> AppData {
        self.data.lock().unwrap().clone()
    }

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
            return data;
        }
    }
    AppData::default()
}

fn save_data(path: &PathBuf, data: &AppData) {
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let _ = fs::write(path, json);
    }
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
    None
}

#[cfg(windows)]
unsafe extern "system" fn enum_window_callback(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return true.into();
    }
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return true.into();
    }
    let Ok(hproc) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid) else {
        return true.into();
    };
    let mut buf = [0u16; 512];
    let len = GetModuleFileNameExW(hproc, None, &mut buf);
    let _ = CloseHandle(hproc);
    if len == 0 {
        return true.into();
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let lower = path.to_lowercase();
    if lower.ends_with("scum.exe") || lower.ends_with("scum-win64-shipping.exe") {
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

#[cfg(windows)]
fn find_scum_window() -> Option<HWND> {
    find_scum_window_by_title().or_else(find_scum_window_by_process)
}

#[cfg(not(windows))]
fn find_scum_window() -> Option<()> { None }

#[cfg(windows)]
fn focus_scum_window() {
    if let Some(hwnd) = find_scum_window() {
        unsafe { let _ = SetForegroundWindow(hwnd); }
    }
}

#[cfg(not(windows))]
fn focus_scum_window() {}

#[cfg(windows)]
const VK_CONTROL: u16 = 0x11;
#[cfg(windows)]
const VK_C: u16 = 0x43;
#[cfg(windows)]
const VK_T: u16 = 0x54;
#[cfg(windows)]
const VK_RETURN: u16 = 0x0D;
#[cfg(windows)]
const VK_ESCAPE: u16 = 0x1B;

#[cfg(windows)]
fn is_key_pressed(vk: u16) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    unsafe { (GetAsyncKeyState(vk as i32) as u16) & 0x8000 != 0 }
}

#[cfg(windows)]
fn start_chat_watcher(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        loop {
            if is_key_pressed(VK_T) {
                *state.chat_paused.lock().unwrap() = true;
                let _ = app_handle.emit("chat-paused", true);
                eprintln!("[chat-watcher] Chat geöffnet (T) - pausiere Tracking");

                // Warte auf Enter oder ESC
                loop {
                    if is_key_pressed(VK_RETURN) {
                        // Erster Enter erkannt. Warte 300ms, dann prüfe
                        // ob innerhalb 2 Sekunden ein weiterer Enter/ESC kommt.
                        thread::sleep(Duration::from_millis(300));
                        let mut closed = true;
                        let deadline = std::time::Instant::now() + Duration::from_secs(2);
                        while std::time::Instant::now() < deadline {
                            if is_key_pressed(VK_RETURN) || is_key_pressed(VK_ESCAPE) {
                                closed = true;
                                thread::sleep(Duration::from_millis(100));
                                break;
                            }
                            thread::sleep(Duration::from_millis(50));
                        }
                        if closed {
                            break;
                        }
                    }
                    if is_key_pressed(VK_ESCAPE) {
                        thread::sleep(Duration::from_millis(100));
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }

                *state.chat_paused.lock().unwrap() = false;
                let _ = app_handle.emit("chat-paused", false);
                eprintln!("[chat-watcher] Chat geschlossen - resume");
                thread::sleep(Duration::from_millis(300));
            }
            thread::sleep(Duration::from_millis(50));
        }
    });
}

#[cfg(windows)]
fn send_ctrl_c_to_scum() -> Result<(), String> {
    let hwnd = find_scum_window().ok_or("SCUM-Fenster nicht gefunden")?;
    unsafe {
        let _ = PostMessageW(hwnd, WM_KEYDOWN, WPARAM(VK_CONTROL as usize), LPARAM(0));
        std::thread::sleep(Duration::from_millis(20));
        let _ = PostMessageW(hwnd, WM_KEYDOWN, WPARAM(VK_C as usize), LPARAM(0));
        std::thread::sleep(Duration::from_millis(50));
        let _ = PostMessageW(hwnd, WM_KEYUP, WPARAM(VK_C as usize), LPARAM(0));
        std::thread::sleep(Duration::from_millis(20));
        let _ = PostMessageW(hwnd, WM_KEYUP, WPARAM(VK_CONTROL as usize), LPARAM(0));
    }
    Ok(())
}

#[cfg(not(windows))]
fn send_ctrl_c_to_scum() -> Result<(), String> {
    Err("Nicht unterstützt auf dieser Plattform".to_string())
}

#[cfg(windows)]
fn capture_window(hwnd: HWND) -> Option<image::RgbaImage> {
    unsafe {
        let hdc_window = GetDC(hwnd);
        if hdc_window.0 == 0 {
            return None;
        }

        let mut rect: RECT = std::mem::zeroed();
        if GetClientRect(hwnd, &mut rect).is_err() {
            let _ = ReleaseDC(hwnd, hdc_window);
            return None;
        }

        let width = (rect.right - rect.left) as u32;
        let height = (rect.bottom - rect.top) as u32;
        if width == 0 || height == 0 {
            let _ = ReleaseDC(hwnd, hdc_window);
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

        let _ = BitBlt(
            hdc_mem,
            0, 0,
            width as i32, height as i32,
            hdc_window,
            0, 0,
            SRCCOPY,
        );

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
fn get_current_location() -> Result<CoordRecord, String> {
    send_ctrl_c_to_scum()?;
    std::thread::sleep(Duration::from_millis(300));
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    let text = clipboard.get_text().map_err(|e| e.to_string())?;
    parse_clipboard(&text).ok_or_else(|| "Keine gültigen Koordinaten in der Zwischenablage".to_string())
}

fn scum_is_running() -> bool {
    find_scum_window().is_some()
}

fn start_recorder(state: Arc<AppState>, app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        let mut clipboard = Clipboard::new().expect("clipboard");
        let mut last_scum_status = true;
        loop {
            let tracking = *state.live_tracking.lock().unwrap();
            if tracking {
                let scum_running = scum_is_running();
                if scum_running != last_scum_status {
                    let _ = app_handle.emit("scum-status", scum_running);
                    last_scum_status = scum_running;
                }
                if !scum_running {
                    thread::sleep(Duration::from_secs(INTERVAL_SECONDS));
                    continue;
                }
                #[cfg(windows)]
                {
                    if *state.chat_paused.lock().unwrap() {
                        thread::sleep(Duration::from_millis(200));
                        continue;
                    }
                }
                if send_ctrl_c_to_scum().is_err() {
                    thread::sleep(Duration::from_secs(INTERVAL_SECONDS));
                    continue;
                }
                thread::sleep(Duration::from_millis(500));
                if let Ok(text) = clipboard.get_text() {
                    if let Some(record) = parse_clipboard(&text) {
                        let should_emit = {
                            let mut pos = state.current_position.lock().unwrap();
                            let changed = pos.as_ref().map_or(true, |last| {
                                (last.x - record.x).abs() > 0.1 || (last.y - record.y).abs() > 0.1
                            });
                            *pos = Some(record.clone());
                            changed
                        };

                        if *state.recording.lock().unwrap() {
                            let mut data = state.data.lock().unwrap();
                            if let Some(current_id) = data.current_route_id.clone() {
                                if let Some(route) = data.routes.iter_mut().find(|r| r.id == current_id) {
                                    route.records.push(record.clone());
                                    save_data(&state.data_path, &data);
                                }
                            }
                            drop(data);
                        }

                        if should_emit {
                            let _ = app_handle.emit("coord-update", record);
                        }
                    }
                }
                thread::sleep(Duration::from_secs(INTERVAL_SECONDS));
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

const HIRES_TILES_URL: &str = "https://github.com/HellBz/Scum-Walker/releases/latest/download/tiles-hires.zip";
const LOWRES_TILES_ZIP: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/tiles-lowres.zip"));

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

#[tauri::command]
fn download_hires_tiles(app_handle: tauri::AppHandle) -> Result<(), String> {
    let _ = app_handle.emit("hires-download-progress", "Lade tiles-hires.zip herunter...");
    let response = reqwest::blocking::get(HIRES_TILES_URL)
        .map_err(|e| format!("Download fehlgeschlagen: {}", e))?;
    let bytes = response.bytes().map_err(|e| format!("Download fehlgeschlagen: {}", e))?;
    let _ = app_handle.emit("hires-download-progress", format!("ZIP geladen ({} MB), entpacke...", bytes.len() / 1024 / 1024));

    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("ZIP konnte nicht geöffnet werden: {}", e))?;

    let tiles_dir = get_tiles_dir(&app_handle);
    let mut count = 0;
    for i in 0..archive.len() {
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
        if count % 200 == 0 {
            let _ = app_handle.emit("hires-download-progress", format!("Entpackt: {} Dateien...", count));
        }
    }

    let _ = app_handle.emit("hires-download-progress", format!("Fertig! {} Tiles entpackt.", count));
    let _ = app_handle.emit("hires-tiles-installed", ());
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
    data.clone()
}

#[tauri::command]
fn select_route(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.current_route_id = Some(id);
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn rename_route(state: State<Arc<AppState>>, id: String, name: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.name = name;
        save_data(&state.data_path, &data);
    }
    data.clone()
}

#[tauri::command]
fn delete_route(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.routes.retain(|r| r.id != id);
    if data.current_route_id.as_ref() == Some(&id) {
        data.current_route_id = data.routes.last().map(|r| r.id.clone());
    }
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn set_route_color(state: State<Arc<AppState>>, id: String, color: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.color = color;
        save_data(&state.data_path, &data);
    }
    data.clone()
}

#[tauri::command]
fn toggle_route_visibility(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(route) = data.routes.iter_mut().find(|r| r.id == id) {
        route.visible = !route.visible;
        save_data(&state.data_path, &data);
    }
    data.clone()
}

#[tauri::command]
fn toggle_recording(state: State<Arc<AppState>>) -> bool {
    let mut recording = state.recording.lock().unwrap();
    *recording = !*recording;
    // recording requires live tracking
    if *recording {
        let mut tracking = state.live_tracking.lock().unwrap();
        if !*tracking {
            *tracking = true;
        }
    }
    *recording
}

#[tauri::command]
fn is_recording(state: State<Arc<AppState>>) -> bool {
    *state.recording.lock().unwrap()
}

#[tauri::command]
fn toggle_live_tracking(state: State<Arc<AppState>>) -> bool {
    let mut tracking = state.live_tracking.lock().unwrap();
    *tracking = !*tracking;
    *tracking
}

#[tauri::command]
fn is_live_tracking(state: State<Arc<AppState>>) -> bool {
    *state.live_tracking.lock().unwrap()
}

#[tauri::command]
fn add_poi(state: State<Arc<AppState>>, poi: Poi) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.pois.push(poi);
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn update_poi(state: State<Arc<AppState>>, id: String, label: String, color: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    if let Some(poi) = data.pois.iter_mut().find(|poi| poi.id == id) {
        poi.label = label;
        poi.color = color;
        save_data(&state.data_path, &data);
    }
    data.clone()
}

#[tauri::command]
fn remove_poi(state: State<Arc<AppState>>, id: String) -> AppData {
    let mut data = state.data.lock().unwrap();
    data.pois.retain(|p| p.id != id);
    save_data(&state.data_path, &data);
    data.clone()
}

#[tauri::command]
fn paste_poi_screenshot(state: State<Arc<AppState>>, id: String) -> Result<AppData, String> {
    focus_scum_window();
    std::thread::sleep(Duration::from_millis(300));

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
    Ok(data.clone())
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
        "http://127.0.0.1/livemap.html".to_string()
    } else {
        format!("http://127.0.0.1:{}/livemap.html", port)
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
        .setup(move |app| {
            let data_path = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("scum_walker_data.json");

            let data = load_data(&data_path);
            let state = Arc::new(AppState {
                data: Mutex::new(data),
                data_path,
                recording: Mutex::new(false),
                live_tracking: Mutex::new(false),
                current_position: Mutex::new(None),
                chat_paused: Mutex::new(false),
            });

            #[cfg(windows)]
            start_chat_watcher(state.clone(), app.handle().clone());
            start_recorder(state.clone(), app.handle().clone());
            let tiles_dir = get_tiles_dir(&app.handle());
            if let Err(e) = std::fs::create_dir_all(&tiles_dir) {
                eprintln!("[tiles] FEHLER: Konnte Verzeichnis nicht erstellen: {} -> {}", tiles_dir.display(), e);
            } else {
                eprintln!("[tiles] Verzeichnis: {}", tiles_dir.display());
            }
            ensure_lowres_tiles(&tiles_dir);
            http_server::start_http_server(state.clone(), tiles_dir.display().to_string());
            app.manage(state);

            let overlay_config = load_overlay_config(&overlay_config_path(&app.handle()));
            let _ = create_overlay_window(&app.handle(), &overlay_config);

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
            export_data,
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
            add_poi,
            update_poi,
            remove_poi,
            paste_poi_screenshot,
            get_poi_image_base64,
            copy_livemap_url,
            get_livemap_url,
            is_scum_running,
            open_overlay,
            close_overlay,
            set_overlay_clickthrough,
            save_overlay_config,
            get_overlay_config,
            reset_overlay_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
