$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing
$shell=New-Object -ComObject Shell.Application
$ws=New-Object -ComObject WScript.Shell
$items=[System.Collections.Generic.List[object]]::new()
$seen=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
function Add-App($name,$target,$key,$iconPath) {
 if(!$name -or !$target -or !$seen.Add($key)){return}
 $icon=''
 try {if($iconPath -and [IO.File]::Exists($iconPath)){$ic=[Drawing.Icon]::ExtractAssociatedIcon($iconPath);if($ic){$bm=$ic.ToBitmap();$ms=[IO.MemoryStream]::new();$bm.Save($ms,[Drawing.Imaging.ImageFormat]::Png);$icon='data:image/png;base64,'+[Convert]::ToBase64String($ms.ToArray());$ms.Dispose();$bm.Dispose();$ic.Dispose()}}}catch{}
 $items.Add(@{id='';title=$name;kind='application';icon=$icon;keywords=($name+' '+$iconPath);target=$target;count=0;lastUsed=0})
}
function Add-File($file) {
 try {if($file.Extension -eq '.lnk'){$link=$ws.CreateShortcut($file.FullName);$target=$link.TargetPath;if(!$target -or !(Test-Path -LiteralPath $target -PathType Leaf)){return};if([IO.Path]::GetExtension($target) -notin @('.exe','.com','.bat','.cmd')){return};Add-App $file.BaseName $file.FullName ($target+'|'+$link.Arguments) $target}
 elseif($file.Extension -eq '.exe'){Add-App $file.BaseName $file.FullName ($file.FullName+'|') $file.FullName}}catch{}
}
$roots=@([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('CommonDesktopDirectory'))
function Scan($dir,$depth){if($depth -lt 0 -or !(Test-Path -LiteralPath $dir)){return};Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | ForEach-Object {if($_.Attributes -band [IO.FileAttributes]::ReparsePoint){return};if($_.PSIsContainer){Scan $_.FullName ($depth-1)}else{Add-File $_}}}
for($i=0;$i -lt $roots.Count;$i++){if($i -lt 2){Scan $roots[$i] 8}else{Scan $roots[$i] 0}}
foreach($r in ($env:SNIPCAST_APP_FOLDERS|ConvertFrom-Json)){Scan $r 3}
$folder=$shell.Namespace('shell:AppsFolder')
if($folder){foreach($item in $folder.Items()){try{$path=$item.ExtendedProperty('System.Link.TargetParsingPath');$appId=$item.ExtendedProperty('System.AppUserModel.ID');$args=$item.ExtendedProperty('System.Link.Arguments');if($path -and [IO.File]::Exists($path)){Add-App $item.Name $item.Path ($path+'|'+$args) $path}elseif($appId){Add-App $item.Name ('shell:AppsFolder\'+$appId) $appId ''}}catch{}}}
ConvertTo-Json -InputObject @($items.ToArray()) -Depth 4 -Compress
