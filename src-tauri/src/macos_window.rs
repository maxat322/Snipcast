//! Скругление на macOS:
//! 1) Окно непрозрачно для сервера окон по умолчанию — остаётся «квадрат». Ставим `opaque = NO`,
//!    фон окна clear (нужна связка с `transparent` + private API в конфиге Tauri).
//! 2) Маска `CAShapeLayer` в координатах **каждого** view: на `contentView` и на **прямых детях**
//!    (WKWebView), но не глубже — иначе ломаются внутренности WebKit.
//! 3) При наличии API — `-[NSWindow setCornerRadius:]`.

use tauri::{Runtime, Webview};

#[cfg(target_os = "macos")]
pub fn apply_rounded_corners<R: Runtime>(webview: &Webview<R>, radius: f64) -> tauri::Result<()> {
    webview.with_webview(move |platform| unsafe {
        let raw = platform.ns_window();
        if raw.is_null() {
            return;
        }
        apply_rounded_mask(raw.cast::<objc2_app_kit::NSWindow>(), radius);
    })
}

#[cfg(target_os = "macos")]
unsafe fn apply_rounded_mask(window: *mut objc2_app_kit::NSWindow, radius: f64) {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use objc2_app_kit::NSColor;

    let window_ref = &*window;
    let window_any = &*(window as *const AnyObject);

    window_ref.setOpaque(false);
    let clear = NSColor::clearColor();
    window_ref.setBackgroundColor(Some(&*clear));

    if msg_send![window_any, respondsToSelector: sel!(setCornerRadius:)] {
        let _: () = msg_send![window_any, setCornerRadius: radius];
    }

    let Some(content) = window_ref.contentView() else {
        return;
    };

    mask_content_and_webview_children(content.as_ref(), radius);
}

/// Только `contentView` (WryWebViewParent) и его прямые дети (в т.ч. WKWebView), без внутренностей WebKit.
#[cfg(target_os = "macos")]
unsafe fn mask_content_and_webview_children(content: &objc2_app_kit::NSView, radius: f64) {
    use objc2_app_kit::NSView;
    use objc2_core_foundation::CGFloat;
    use objc2_core_graphics::CGPath;
    use objc2_quartz_core::CAShapeLayer;

    fn apply_one(view: &NSView, radius: f64) {
        let b = view.bounds();
        let r = radius as CGFloat;
        let path = unsafe { CGPath::with_rounded_rect(b, r, r, core::ptr::null()) };
        let mask = CAShapeLayer::layer();
        mask.setPath(Some(&*path));
        view.setWantsLayer(true);
        if let Some(layer) = view.layer() {
            layer.setCornerRadius(radius as CGFloat);
            layer.setMasksToBounds(true);
            unsafe {
                layer.setMask(Some(&*mask));
            }
        }
    }

    apply_one(content, radius);

    let subs = content.subviews();
    let n = subs.count();
    for i in 0..n {
        let sub = subs.objectAtIndex(i);
        apply_one(&*sub, radius);
    }
}
