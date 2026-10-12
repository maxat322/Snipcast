// Манифест для тестовых бинарников: cargo test собирает их без манифеста
// Tauri, а импорт TaskDialogIndirect (comctl32) требует Common-Controls v6 —
// без него загрузка теста падает STATUS_ENTRYPOINT_NOT_FOUND.
const TEST_MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity version="1.0.0.0" processorArchitecture="*" name="Snipcast.tests" type="win32"/>
  <description>Snipcast tests</description>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>
"#;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        build_video();
    }
    tauri_build::build();

    let manifest_dir = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).to_path_buf();
    let manifest_path = manifest_dir.join("tests.manifest");
    if let Err(err) = std::fs::write(&manifest_path, TEST_MANIFEST) {
        eprintln!("[snipcast] запись тестового манифеста: {err}");
        return;
    }
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest_path.display()
    );
}

fn build_video() {
    use std::{path::PathBuf, process::Command};
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let shaders = out.join("shaders");
    std::fs::create_dir_all(&shaders).unwrap();
    let kits = PathBuf::from(std::env::var_os("ProgramFiles(x86)").unwrap_or("C:\\Program Files (x86)".into()))
        .join("Windows Kits/10/bin");
    let mut versions: Vec<_> = std::fs::read_dir(kits).expect("Windows SDK is required")
        .flatten().map(|e| e.path()).filter(|p| p.join("x64/fxc.exe").exists()).collect();
    versions.sort();
    let fxc = versions.last().expect("Windows SDK fxc.exe is required").join("x64/fxc.exe");
    for entry in ["ResizePassH", "ResizePassV", "ResizeLinearPassH", "ResizeLinearPassV", "ConvertSinglePass", "ConvertPass1", "ConvertPass2"] {
        let bytecode = shaders.join(format!("{entry}.dxbc"));
        assert!(Command::new(&fxc).args(["/nologo", "/O3", "/Qstrip_reflect", "/Qstrip_debug", "/T", "cs_5_0", "/E", entry, "/Fo"])
            .arg(&bytecode).arg("vendor/wcap/wcap_shaders.hlsl").status().unwrap().success(), "shader {entry}");
        assert!(Command::new(&fxc).args(["/nologo", "/compress", "/Vn", &format!("{entry}ShaderBytes"), "/Fo"])
            .arg(shaders.join(format!("{entry}.dcs"))).arg("/Fh").arg(shaders.join(format!("{entry}.h")))
            .arg(&bytecode).status().unwrap().success());
    }
    cc::Build::new().file("native/video.c").include("vendor/wcap").include(&out)
        .flag("/std:c11").flag("/experimental:c11atomics").opt_level_str("s").flag("/Gy")
        .define("NDEBUG", None).warnings(false).compile("snipcast_video");
    for lib in ["ntdll", "dxgi", "d3dcompiler", "d3d11", "dwmapi", "mfplat", "mfuuid", "mfreadwrite", "evr", "strmiids", "ksuser", "mmdevapi", "ole32", "oleaut32", "wmcodecdspuuid", "avrt", "OneCore", "CoreMessaging", "windowscodecs", "shlwapi", "uxtheme", "msimg32"] {
        println!("cargo:rustc-link-lib={lib}");
    }
    println!("cargo:rerun-if-changed=native/video.c");
    println!("cargo:rerun-if-changed=vendor/wcap");
}
