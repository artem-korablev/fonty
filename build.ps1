param([string]$SdkPackage)

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'src'
$cache = Join-Path $PSScriptRoot '.cache'
$output = Join-Path $PSScriptRoot 'dist'
$version = '1.0.4370.26'
$expectedHash = '1C0DACAC84B70109B3FD42F90C53A0BA942ABC3A87590D7A4E0CCD86E4A06CF4'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The x64 .NET Framework C# compiler was not found.' }
New-Item -ItemType Directory -Force -Path $cache,$output | Out-Null

$package = Join-Path $cache "webview2-$version.zip"
if ($SdkPackage) {
    Copy-Item -LiteralPath $SdkPackage -Destination $package -Force
} elseif (-not (Test-Path -LiteralPath $package)) {
    $uri = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg"
    $temporary = Join-Path $cache "webview2-$version.download"
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $uri -OutFile $temporary -UseBasicParsing
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
    }
    if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $expectedHash) {
        throw 'WebView2 SDK checksum mismatch.'
    }
    Move-Item -LiteralPath $temporary -Destination $package
}
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'WebView2 SDK checksum mismatch.'
}

$sdk = Join-Path $cache "webview2-$version"
$webCore = Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$webForms = Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
$loader = Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll'
Expand-Archive -LiteralPath $package -DestinationPath $sdk -Force

$assets = @{
    'index.html' = (Join-Path $source 'ui/index.html')
    'style.css' = (Join-Path $source 'ui/style.css')
    'app.js' = (Join-Path $source 'ui/app.js')
    'google.js' = (Join-Path $source 'ui/google.js')
    'workspaces.js' = (Join-Path $source 'ui/workspaces.js')
    'mark.svg' = (Join-Path $source 'ui/mark.svg')
    'google-catalog.json' = (Join-Path $source 'google-catalog.json')
    'windows-fonts.txt' = (Join-Path $source 'windows-fonts.txt')
    'Fonty.ico' = (Join-Path $source 'Fonty.ico')
    'license.txt' = (Join-Path $sdk 'LICENSE.txt')
    'Microsoft.Web.WebView2.Core.dll' = $webCore
    'Microsoft.Web.WebView2.WinForms.dll' = $webForms
    'WebView2Loader.dll' = $loader
}
$target = Join-Path $output 'Fonty.exe'
$resources = foreach ($asset in $assets.GetEnumerator()) { "/resource:$($asset.Value),$($asset.Key)" }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/out:$target" `
    "/win32icon:$($assets['Fonty.ico'])" /reference:System.Drawing.dll /reference:System.Web.Extensions.dll `
    /reference:System.Windows.Forms.dll "/reference:$webCore" "/reference:$webForms" `
    $resources (Join-Path $source 'Program.cs') (Join-Path $source 'Fonts.cs') (Join-Path $source 'FontRemoval.cs')
if ($LASTEXITCODE -ne 0) { throw "Compilation failed ($LASTEXITCODE)." }
Write-Output $target
