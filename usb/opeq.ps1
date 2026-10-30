param([switch]$NoBrowser, [int]$Port = 47821, [string]$Token = "", [string]$CheckUrl = "https://opeq.io/usb/")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$App = $PSScriptRoot
$Data = Join-Path $Root "data"
$Wallet = Join-Path $Data "opeq-wallet.json"
$WalletTmp = "$Wallet.tmp"
$Origin = "http://127.0.0.1:$Port"
$HostHeader = "127.0.0.1:$Port"
$MaxHead = 16KB
$MaxBody = 4MB
$Deadline = 2000
$Prefix = '{"kind":"opeq-usb-wallet"'
$Mime = @{
  ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".css" = "text/css; charset=utf-8"
  ".svg" = "image/svg+xml"; ".png" = "image/png"; ".woff2" = "font/woff2"
}
$Reason = @{ 200 = "OK"; 204 = "No Content"; 400 = "Bad Request"; 403 = "Forbidden"; 404 = "Not Found"; 405 = "Method Not Allowed"; 410 = "Gone"; 413 = "Payload Too Large"; 500 = "Internal Server Error" }

function Show-Message([string]$text) {
  if ($NoBrowser) { Write-Output $text; return }
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($text, "OPEQ") | Out-Null
}

if (-not $Token) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

function Send-Response($stream, [int]$code, [string]$type, [byte[]]$body) {
  if ($null -eq $body) { $body = [byte[]]@() }
  $head = "HTTP/1.1 $code $($Reason[$code])`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nX-Frame-Options: DENY`r`nContent-Security-Policy: frame-ancestors 'none'`r`nReferrer-Policy: no-referrer`r`nCross-Origin-Resource-Policy: same-origin`r`nConnection: close`r`n`r`n"
  $h = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($h, 0, $h.Length)
  if ($body.Length) { $stream.Write($body, 0, $body.Length) }
}

function Send-Text($stream, [int]$code, [string]$text) {
  Send-Response $stream $code "text/plain; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes($text))
}

function Read-Some($stream, $buf, [int]$count, $clock) {
  $left = $Deadline - $clock.ElapsedMilliseconds
  if ($left -le 0) { return -1 }
  $stream.ReadTimeout = [int][Math]::Max(1, $left)
  try { return $stream.Read($buf, 0, $count) } catch { return -1 }
}

function Read-Head($stream, $clock) {
  $buf = New-Object byte[] 4096
  $ms = New-Object System.IO.MemoryStream
  $end = -1
  while ($end -lt 0) {
    $n = Read-Some $stream $buf $buf.Length $clock
    if ($n -le 0) { return $null }
    $ms.Write($buf, 0, $n)
    if ($ms.Length -gt $MaxHead) { return $null }
    $all = $ms.ToArray()
    for ($i = [Math]::Max(0, $all.Length - $n - 3); $i -le $all.Length - 4; $i++) {
      if ($all[$i] -eq 13 -and $all[$i + 1] -eq 10 -and $all[$i + 2] -eq 13 -and $all[$i + 3] -eq 10) { $end = $i; break }
    }
  }
  $all = $ms.ToArray()
  $lines = [System.Text.Encoding]::ASCII.GetString($all, 0, $end) -split "`r`n"
  $first = $lines[0] -split " "
  if ($first.Count -ne 3 -or $lines.Count -lt 2) { return $null }
  $headers = @{}
  foreach ($line in $lines[1..($lines.Count - 1)]) {
    $k = $line.IndexOf(":")
    if ($k -le 0) { return $null }
    $name = $line.Substring(0, $k).Trim().ToLowerInvariant()
    if ($headers.ContainsKey($name)) { return $null }
    $headers[$name] = $line.Substring($k + 1).Trim()
  }
  $rest = [byte[]]@()
  if ($all.Length -gt $end + 4) { $rest = [byte[]]$all[($end + 4)..($all.Length - 1)] }
  return @{ Method = $first[0]; Path = $first[1]; Headers = $headers; Rest = $rest }
}

function Read-Body($stream, $req, $clock) {
  $length = 0
  if ($req.Headers.ContainsKey("content-length")) {
    if (-not [int]::TryParse($req.Headers["content-length"], [ref]$length) -or $length -lt 0) { return $null }
  }
  if ($length -gt $MaxBody) { return $null }
  $body = New-Object System.IO.MemoryStream
  if ($req.Rest.Length) { $body.Write($req.Rest, 0, [Math]::Min($req.Rest.Length, $length)) }
  $buf = New-Object byte[] 65536
  while ($body.Length -lt $length) {
    $n = Read-Some $stream $buf ([Math]::Min($buf.Length, $length - $body.Length)) $clock
    if ($n -le 0) { return $null }
    $body.Write($buf, 0, $n)
  }
  return ,$body.ToArray()
}

function Present() {
  return (Test-Path -LiteralPath (Join-Path $App "app.html")) -and (Test-Path -LiteralPath $Data)
}

function Save-Wallet([byte[]]$body) {
  $fs = [System.IO.File]::Open($WalletTmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $fs.Write($body, 0, $body.Length); $fs.Flush($true) } finally { $fs.Close() }
  for ($try = 0; $try -lt 8; $try++) {
    try {
      if (Test-Path -LiteralPath $Wallet) { [System.IO.File]::Replace($WalletTmp, $Wallet, [NullString]::Value) }
      else { [System.IO.File]::Move($WalletTmp, $Wallet) }
      return
    } catch {
      Start-Sleep -Milliseconds 150
    }
  }
  throw "could not replace the wallet file"
}

function Restore-Wallet() {
  if (-not (Test-Path -LiteralPath $WalletTmp)) { return }
  $tmp = [System.IO.File]::ReadAllText($WalletTmp)
  if (-not $tmp.StartsWith($Prefix)) { return }
  $current = ""
  if (Test-Path -LiteralPath $Wallet) { $current = [System.IO.File]::ReadAllText($Wallet) }
  if ($current.StartsWith($Prefix)) {
    try { $null = $current | ConvertFrom-Json; return } catch { }
  }
  try { $null = $tmp | ConvertFrom-Json } catch { return }
  if (Test-Path -LiteralPath $Wallet) { [System.IO.File]::Replace($WalletTmp, $Wallet, [NullString]::Value) } else { [System.IO.File]::Move($WalletTmp, $Wallet) }
}

function Disk-Facts() {
  $facts = @{ volume = ""; drive = "" }
  try {
    $drive = [System.IO.Path]::GetPathRoot($Root).TrimEnd("\")
    $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$drive'"
    if ($disk) {
      if ($disk.VolumeSerialNumber) { $facts.volume = [string]$disk.VolumeSerialNumber }
      if ($disk.DriveType -eq 2) { $facts.drive = "removable" } elseif ($disk.DriveType -eq 3) { $facts.drive = "fixed" }
    }
  } catch { }
  return $facts
}

function Check-Code() {
  $result = @{ state = "offline"; version = ""; changed = @() }
  try {
    $version = ([System.IO.File]::ReadAllText((Join-Path $App "VERSION"))).Trim()
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { $result.state = "changed"; $result.changed = @("app/VERSION"); return $result }
    $result.version = $version
    $local = @{}
    foreach ($f in Get-ChildItem -LiteralPath $App -Recurse -File -Force) {
      $rel = "app/" + $f.FullName.Substring($App.Length).TrimStart("\").Replace("\", "/")
      $local[$rel] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    foreach ($name in @("OPEQ.cmd", "README.txt")) {
      $p = Join-Path $Root $name
      if (Test-Path -LiteralPath $p) { $local[$name] = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    try { $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 -Uri ($CheckUrl + $version + ".json") }
    catch {
      $code = 0
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if ($code -eq 404) { $result.state = "changed"; $result.changed = @("app/VERSION (" + $version + " is not an official release)"); return $result }
      throw
    }
    $list = ($resp.Content | ConvertFrom-Json).files
    $want = @{}
    foreach ($p in $list.PSObject.Properties) { $want[$p.Name] = [string]$p.Value }
    $changed = @()
    foreach ($k in $local.Keys) { if (-not $want.ContainsKey($k) -or $want[$k] -ne $local[$k]) { $changed += $k } }
    foreach ($k in $want.Keys) { if (-not $local.ContainsKey($k)) { $changed += $k } }
    if ($changed.Count) { $result.state = "changed"; $result.changed = @($changed | Sort-Object) } else { $result.state = "ok" }
    if ($result.state -eq "ok") {
      try {
        $latest = ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 6 -Uri ($CheckUrl + "latest.json")).Content | ConvertFrom-Json).version
        if ($latest -match '^[0-9]+\.[0-9]+\.[0-9]+$' -and ([version]$latest -gt [version]$version)) { $result.state = "old"; $result.latest = $latest }
      } catch {}
    }
  } catch {
    if ($result.state -ne "changed") { $result.state = "offline" }
  }
  return $result
}

function Handle($client) {
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $stream = $client.GetStream()
  $stream.WriteTimeout = 3000
  $req = Read-Head $stream $clock
  if ($null -eq $req) { return }
  if ($req.Headers["host"] -ne $HostHeader) { Send-Text $stream 403 "wrong host"; return }
  $reqOrigin = $req.Headers["origin"]
  if ($reqOrigin -and $reqOrigin -ne $Origin) { Send-Text $stream 403 "wrong origin"; return }
  $path = $req.Path
  if ($path -notmatch '^/[A-Za-z0-9._/-]*$' -or $path.Contains("..") -or $path.Contains("//")) { Send-Text $stream 400 "bad path"; return }
  $isPut = $path -eq "/api/wallet" -and $req.Method -eq "PUT"
  if ($path.StartsWith("/api/")) {
    if ($req.Headers["x-opeq-token"] -ne $Token) { Send-Text $stream 403 "missing token"; return }
  }
  if (-not $isPut -and $req.Headers.ContainsKey("content-length") -and $req.Headers["content-length"] -ne "0") { Send-Text $stream 400 "unexpected body"; return }
  if ($path -eq "/api/alive" -and $req.Method -eq "GET") {
    if (Present) { Send-Text $stream 200 "ok" } else { Send-Text $stream 410 "gone" }
    return
  }
  if ($path -eq "/api/info" -and $req.Method -eq "GET") {
    Send-Response $stream 200 "application/json" ([System.Text.Encoding]::UTF8.GetBytes($Info))
    return
  }
  if ($path -eq "/api/wallet" -and $req.Method -eq "GET") {
    if (-not (Present)) { Send-Text $stream 410 "gone"; return }
    if (-not (Test-Path -LiteralPath $Wallet)) { Send-Response $stream 204 "text/plain" $null; return }
    Send-Response $stream 200 "application/json" ([System.IO.File]::ReadAllBytes($Wallet))
    return
  }
  if ($isPut) {
    if (-not (Present)) { Send-Text $stream 410 "gone"; return }
    if ($req.Headers["content-type"] -ne "application/json" -or -not $reqOrigin) { Send-Text $stream 400 "bad request"; return }
    $body = Read-Body $stream $req $clock
    if ($null -eq $body) { Send-Text $stream 400 "incomplete body"; return }
    $text = [System.Text.Encoding]::UTF8.GetString($body)
    if (-not $text.StartsWith($Prefix)) { Send-Text $stream 400 "not an opeq wallet"; return }
    try { Save-Wallet $body } catch { Send-Text $stream 500 "write failed"; return }
    Send-Response $stream 204 "text/plain" $null
    return
  }
  if ($path.StartsWith("/api/")) { Send-Text $stream 405 "not allowed"; return }
  if ($req.Method -ne "GET") { Send-Text $stream 405 "not allowed"; return }
  if ($path -eq "/") { $path = "/app.html" }
  $file = Join-Path $App ($path.Substring(1).Replace("/", "\"))
  $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
  if (-not $Mime.ContainsKey($ext) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { Send-Text $stream 404 "not found"; return }
  Send-Response $stream 200 $Mime[$ext] ([System.IO.File]::ReadAllBytes($file))
}

function Find-Browser() {
  $list = @(
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )
  foreach ($p in $list) { if ($p -and (Test-Path -LiteralPath $p)) { return $p } }
  return $null
}

function Remove-Profile([string]$dir) {
  for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $dir); $i++) {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $dir) { Start-Sleep -Milliseconds 500 }
  }
}

if ($Root -match '\\(Temp\d+_[^\\]+\.zip|7z[A-Za-z0-9]+|Rar\$[^\\]+)(\\|$)') {
  Show-Message "OPEQ is still inside the zip file. Right-click OPEQ-USB.zip, choose Extract All, copy the OPEQ-USB folder to your USB stick and double-click OPEQ there."
  exit 1
}
if (-not (Test-Path -LiteralPath $Data)) { New-Item -ItemType Directory -Path $Data | Out-Null }
try { Restore-Wallet } catch { }

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.ExclusiveAddressUse = $true
try { $listener.Start() } catch {
  $code = 0
  $e = $_.Exception
  while ($e) { if ($e -is [System.Net.Sockets.SocketException]) { $code = $e.ErrorCode; break }; $e = $e.InnerException }
  if ($code -eq 10048 -or $code -eq 10013) { Show-Message "OPEQ cannot start: another program on this computer is using port $Port. If an OPEQ window is open, close it. If not, restart the computer or use another one, and do not enter your password in any window that says OPEQ until OPEQ starts normally." }
  else { Show-Message "OPEQ cannot start on this computer ($($_.Exception.Message))." }
  exit 1
}

$check = Check-Code
$disk = Disk-Facts
$Info = (@{ volume = $disk.volume; drive = $disk.drive; check = $check.state; version = $check.version; latest = $check.latest; changed = @($check.changed | Select-Object -First 20) } | ConvertTo-Json -Compress)

$browser = $null
$profileDir = $null
if (-not $NoBrowser) {
  $exe = Find-Browser
  if (-not $exe) { $listener.Stop(); Show-Message "OPEQ needs Google Chrome or Microsoft Edge on this computer."; exit 1 }
  Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter "opeq-usb-*" -ErrorAction SilentlyContinue | ForEach-Object { Remove-Profile $_.FullName }
  $profileDir = Join-Path $env:TEMP ("opeq-usb-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path (Join-Path $profileDir "Default") -Force | Out-Null
  $prefs = '{"credentials_enable_service":false,"profile":{"password_manager_enabled":false},"autofill":{"profile_enabled":false,"credit_card_enabled":false},"translate":{"enabled":false}}'
  [System.IO.File]::WriteAllText((Join-Path $profileDir "Default\Preferences"), $prefs)
  $browserArgs = @("--user-data-dir=`"$profileDir`"", "--app=$Origin/app.html#t=$Token", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-breakpad", "--disable-crash-reporter", "--disable-features=Translate", "--window-size=1180,880")
  $browser = Start-Process -FilePath $exe -ArgumentList $browserArgs -PassThru
} else {
  Write-Output "OPEQ USB serving $Origin token $Token check $($check.state)"
}

$clock = [System.Diagnostics.Stopwatch]::StartNew()
try {
  while ($true) {
    if ($browser -and $browser.HasExited) { break }
    if ($clock.ElapsedMilliseconds -ge 1000) {
      $clock.Restart()
      if (-not (Present)) { break }
    }
    if ($listener.Pending()) {
      $client = $listener.AcceptTcpClient()
      try { Handle $client } catch { } finally { $client.Close() }
    } else {
      Start-Sleep -Milliseconds 25
    }
  }
} finally {
  $listener.Stop()
  if ($browser -and -not $browser.HasExited) { & taskkill.exe /PID $browser.Id /T /F | Out-Null }
  if ($profileDir) {
    Start-Sleep -Seconds 1
    Remove-Profile $profileDir
  }
}
