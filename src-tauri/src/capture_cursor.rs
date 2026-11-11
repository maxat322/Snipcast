//! Freeze the actual Windows cursor over the captured pixels, including XOR cursors.
use base64::Engine as _;
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    // Physical pixels relative to the screenshot, already clipped to its bounds.
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub png: String,
}

impl Snapshot {
    pub fn composite(&self, image: &mut image::RgbaImage) -> Result<(), String> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(&self.png).map_err(|e| e.to_string())?;
        let patch = image::load_from_memory(&bytes).map_err(|e| e.to_string())?.to_rgba8();
        image::imageops::overlay(image, &patch, self.x as i64, self.y as i64);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub fn capture(image: &image::RgbaImage, x: i32, y: i32) -> Option<Snapshot> {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let mut cursor: CURSORINFO = std::mem::zeroed();
        cursor.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
        if GetCursorInfo(&mut cursor) == 0 || cursor.flags & CURSOR_SHOWING == 0 { return None; }
        render(image, x, y, cursor.hCursor, cursor.ptScreenPos.x, cursor.ptScreenPos.y)
    }
}

#[cfg(not(target_os = "windows"))]
pub fn capture(_: &image::RgbaImage, _: i32, _: i32) -> Option<Snapshot> { None }

#[cfg(target_os = "windows")]
unsafe fn render(image: &image::RgbaImage, origin_x: i32, origin_y: i32,
    cursor: windows_sys::Win32::UI::WindowsAndMessaging::HCURSOR, px: i32, py: i32) -> Option<Snapshot> {
    use windows_sys::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};
    let mut icon: ICONINFO = std::mem::zeroed();
    if GetIconInfo(cursor, &mut icon) == 0 { return None; }
    let mut bitmap: BITMAP = std::mem::zeroed();
    let monochrome = icon.hbmColor.is_null();
    let ok = GetObjectW(if monochrome { icon.hbmMask } else { icon.hbmColor },
        std::mem::size_of::<BITMAP>() as i32, &mut bitmap as *mut _ as *mut _);
    if !icon.hbmMask.is_null() { DeleteObject(icon.hbmMask); }
    if !icon.hbmColor.is_null() { DeleteObject(icon.hbmColor); }
    if ok == 0 { return None; }
    let (w, h) = (bitmap.bmWidth, bitmap.bmHeight / if monochrome { 2 } else { 1 });
    let left = px as i64 - icon.xHotspot as i64 - origin_x as i64;
    let top = py as i64 - icon.yHotspot as i64 - origin_y as i64;
    let x = left.max(0).min(image.width() as i64);
    let y = top.max(0).min(image.height() as i64);
    let right = (left + w as i64).clamp(0, image.width() as i64);
    let bottom = (top + h as i64).clamp(0, image.height() as i64);
    if right <= x || bottom <= y { return None; }
    let (width, height) = ((right - x) as u32, (bottom - y) as u32);
    let dc = CreateCompatibleDC(std::ptr::null_mut());
    if dc.is_null() { return None; }
    let mut bmi: BITMAPINFO = std::mem::zeroed();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width as i32;
    bmi.bmiHeader.biHeight = -(height as i32);
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB;
    let mut bits = std::ptr::null_mut();
    let dib = CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
    if dib.is_null() || bits.is_null() {
        if !dib.is_null() { DeleteObject(dib); }
        DeleteDC(dc); return None;
    }
    let old = SelectObject(dc, dib);
    let mut patch = image::imageops::crop_imm(image, x as u32, y as u32, width, height).to_image();
    let raw = bits as *mut u8;
    // This memory is also accessed by GDI, outside Rust's aliasing model.
    for (index, src) in patch.pixels().enumerate() {
        for (channel, value) in [src[2], src[1], src[0], 255].into_iter().enumerate() {
            raw.add(index*4+channel).write_volatile(value);
        }
    }
    // Render over the frozen screenshot, not over a second capture of a moving desktop.
    let drawn = DrawIconEx(dc, (left-x) as i32, (top-y) as i32, cursor, w, h, 0, std::ptr::null_mut(), DI_NORMAL);
    GdiFlush();
    for (index, dst) in patch.pixels_mut().enumerate() {
        let src = raw.add(index*4);
        *dst = image::Rgba([src.add(2).read_volatile(), src.add(1).read_volatile(), src.read_volatile(), 255]);
    }
    SelectObject(dc, old); DeleteObject(dib); DeleteDC(dc);
    if drawn == 0 { return None; }
    Some(Snapshot { x: x as u32, y: y as u32, width, height,
        png: base64::engine::general_purpose::STANDARD.encode(super::encode_png(&patch)) })
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    #[test]
    fn system_cursor_pixels_hotspot_clipping_and_negative_monitor() {
        let original = image::RgbaImage::from_pixel(128, 96, image::Rgba([70, 100, 130, 255]));
        for id in [IDC_ARROW, IDC_IBEAM, IDC_HAND] {
            unsafe {
                let cursor = LoadCursorW(std::ptr::null_mut(), id);
                assert!(!cursor.is_null());
                let patch = render(&original, -1920, -400, cursor, -1880, -360).unwrap();
                let mut combined = original.clone(); patch.composite(&mut combined).unwrap();
                assert!(combined != original, "cursor {} produced no pixels ({}x{})", id as usize, patch.width, patch.height);
                assert!(combined.pixels().all(|p| p[3] == 255));
                // The same physical position relative to a different monitor produces identical pixels.
                let positive = render(&original, 0, 0, cursor, 40, 40).unwrap();
                assert_eq!((patch.x, patch.y, &patch.png), (positive.x, positive.y, &positive.png));
                let edge = render(&original, 0, 0, cursor, 127, 95).unwrap();
                assert!(edge.x + edge.width <= 128 && edge.y + edge.height <= 96);
                assert!(render(&original, 0, 0, cursor, -1000, -1000).is_none());
            }
        }
    }
}
