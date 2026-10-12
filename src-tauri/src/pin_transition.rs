//! Hold the already displayed desktop pixels while WebView and window bounds
//! change asynchronously. The small cover never moves or scales the image.
#[cfg(target_os="windows")]
pub fn begin(rect:super::screenshot::WindowRect)->Result<Option<usize>,String> {
    use windows_sys::Win32::{Foundation::{POINT,SIZE},Graphics::{Dwm::DwmFlush,Gdi::*},UI::WindowsAndMessaging::*};
    unsafe {
        let x=rect.x.max(GetSystemMetrics(SM_XVIRTUALSCREEN));
        let y=rect.y.max(GetSystemMetrics(SM_YVIRTUALSCREEN));
        let right=(rect.x+rect.width as i32).min(GetSystemMetrics(SM_XVIRTUALSCREEN)+GetSystemMetrics(SM_CXVIRTUALSCREEN));
        let bottom=(rect.y+rect.height as i32).min(GetSystemMetrics(SM_YVIRTUALSCREEN)+GetSystemMetrics(SM_CYVIRTUALSCREEN));
        let w=right-x;let h=bottom-y;if w<=0||h<=0{return Ok(None)}
        let screen=GetDC(std::ptr::null_mut());
        if screen.is_null(){return Err("не удалось подготовить переход закрепа".into())}
        let dc=CreateCompatibleDC(screen);let bitmap=CreateCompatibleBitmap(screen,w,h);
        if dc.is_null()||bitmap.is_null(){
            if !dc.is_null(){DeleteDC(dc);}if !bitmap.is_null(){DeleteObject(bitmap);}
            ReleaseDC(std::ptr::null_mut(),screen);return Err("не удалось сохранить кадр закрепа".into())
        }
        let old=SelectObject(dc,bitmap);DwmFlush();
        let copied=BitBlt(dc,0,0,w,h,screen,x,y,SRCCOPY|CAPTUREBLT);
        let class:Vec<u16>="STATIC\0".encode_utf16().collect();
        let title:Vec<u16>="Snipcast transition\0".encode_utf16().collect();
        let hwnd=if copied!=0 {CreateWindowExW(WS_EX_LAYERED|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE|WS_EX_TOPMOST,
            class.as_ptr(),title.as_ptr(),WS_POPUP,x,y,w,h,std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null_mut(),std::ptr::null())}else{std::ptr::null_mut()};
        let ready=!hwnd.is_null()&&UpdateLayeredWindow(hwnd,screen,&POINT{x,y},&SIZE{cx:w,cy:h},dc,&POINT{x:0,y:0},0,std::ptr::null(),ULW_OPAQUE)!=0;
        SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);ReleaseDC(std::ptr::null_mut(),screen);
        if !ready {if !hwnd.is_null(){DestroyWindow(hwnd);}return Err("не удалось показать кадр закрепа".into())}
        ShowWindow(hwnd,SW_SHOWNOACTIVATE);DwmFlush();Ok(Some(hwnd as usize))
    }
}

#[cfg(target_os="windows")]
pub fn end(cover:Option<usize>) {
    if let Some(handle)=cover {unsafe {
        windows_sys::Win32::Graphics::Dwm::DwmFlush();
        windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(handle as _);
    }}
}

#[cfg(not(target_os="windows"))]
pub fn begin(_rect:super::screenshot::WindowRect)->Result<Option<usize>,String>{Ok(None)}
#[cfg(not(target_os="windows"))]
pub fn end(_cover:Option<usize>){}
