# =========================================
# つむぎの通信を測る（読むだけ。PC の設定は変えない）
#
# つむぎ（Electron）のプロセスと、その子のプロセスが、どこへ TCP でつないでいるかを、
# くり返し読んで記録する。Electron の版を上げる前と後で動かして、接続先を比べる。
# 1回読むごとに1秒待つが、プロセスを数えるのにも時間がかかる（開発の PC では、1回が約2秒だった）。
#
# 使い方（PowerShell。つむぎを起動する前でも後でもよい）：
#   pwsh -File tools/net-watch.ps1 -Label electron29
#   → つむぎを一通り使う → この窓で Q を押すと、まとめを出して終わる
#
# 弱点：見えるのは TCP だけ。読む間（約2秒）より短い接続や、UDP（名前の問い合わせなど）は見落とすことがある。
#       だから、ファイアウォールで止める確かめも、あわせて行う（README）。
# =========================================
param(
  # 記録に付ける名前（例：electron29、electron45）
  [string]$Label = "net-watch",
  # つむぎの Electron を見分ける言葉（実行ファイルのパスに、この言葉が入っているものを見る）
  [string]$PathMatch = "tumugi_app",
  # 記録を書くファイル。空なら、一時フォルダーに作る
  [string]$OutFile = "",
  # 1回読むごとに待つ時間（ミリ秒）。実際の間隔は、これに読む時間を足したものになる
  [int]$IntervalMs = 1000
)

$ErrorActionPreference = "Stop"

if ($OutFile -eq "") {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutFile = Join-Path $env:TEMP "tumugi-net-watch-$Label-$stamp.txt"
}

# 接続先を、PC の中・社内・インターネットに分ける
function Get-AddressKind([string]$address) {
  if ($address -eq "::1" -or $address -like "127.*" -or $address -like "::ffff:127.*") { return "PCの中" }
  if ($address -like "10.*" -or $address -like "192.168.*" -or $address -like "169.254.*") { return "社内" }
  if ($address -match "^172\.(1[6-9]|2[0-9]|3[01])\.") { return "社内" }
  if ($address -match "^(fe80|fc|fd)") { return "社内" }
  return "インターネット"
}

# 見る相手のプロセスを集める。戻り値：プロセスID → { Group, Name }
function Get-TargetProcesses {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, ExecutablePath
  $targets = @{}

  # つむぎの Electron（パスで見分ける）
  foreach ($p in $all) {
    if ($p.Name -eq "electron.exe" -and $p.ExecutablePath -and $p.ExecutablePath -like "*$PathMatch*") {
      $targets[[int]$p.ProcessId] = @{ Group = "Electron"; Name = $p.Name }
    }
  }

  # その子・孫（Electron 自身の子は Electron。ほかの名前は「つむぎが立ち上げたプログラム」）
  $added = $true
  while ($added) {
    $added = $false
    foreach ($p in $all) {
      $id = [int]$p.ProcessId
      $parent = [int]$p.ParentProcessId
      if ($targets.ContainsKey($id) -or -not $targets.ContainsKey($parent)) { continue }
      $group = "子"
      if ($p.Name -eq "electron.exe" -and $targets[$parent].Group -eq "Electron") { $group = "Electron" }
      $targets[$id] = @{ Group = $group; Name = $p.Name }
      $added = $true
    }
  }

  # Ollama と VOICEVOX（つむぎの子でなくても、分けて記録する）
  foreach ($p in $all) {
    $id = [int]$p.ProcessId
    if ($targets.ContainsKey($id)) { continue }
    $path = [string]$p.ExecutablePath
    if ($p.Name -like "ollama*" -or $path -like "*voicevox*") {
      $targets[$id] = @{ Group = "別"; Name = $p.Name }
    }
  }
  return $targets
}

$groupTitles = [ordered]@{
  "Electron" = "つむぎ本体（Electron）"
  "子"       = "つむぎが立ち上げたプログラム（VOICEVOX など）"
  "別"       = "別のプログラム（Ollama・VOICEVOX）"
}

$seen = @{}      # "グループ|プロセス名|アドレス|ポート" → 見た回数
$samples = 0
$foundElectron = $false
$startedAt = Get-Date

Write-Host "つむぎの通信を測っています。つむぎを一通り使ってから、この窓で Q を押してください。"
Write-Host "記録の書き先：$OutFile"

while ($true) {
  $targets = Get-TargetProcesses
  if (($targets.Values | Where-Object { $_.Group -eq "Electron" }).Count -gt 0) { $foundElectron = $true }

  $connections = Get-NetTCPConnection -ErrorAction SilentlyContinue |
    Where-Object { $_.State -ne "Listen" -and $_.State -ne "Bound" -and $_.RemotePort -ne 0 }
  foreach ($c in $connections) {
    $id = [int]$c.OwningProcess
    if (-not $targets.ContainsKey($id)) { continue }
    $t = $targets[$id]
    $key = "{0}|{1}|{2}|{3}" -f $t.Group, $t.Name, $c.RemoteAddress, $c.RemotePort
    if ($seen.ContainsKey($key)) { $seen[$key]++ } else {
      $seen[$key] = 1
      $kind = Get-AddressKind $c.RemoteAddress
      Write-Host ("  新しい接続先：[{0}] {1} → {2}:{3}（{4}）" -f $t.Group, $t.Name, $c.RemoteAddress, $c.RemotePort, $kind)
    }
  }
  $samples++

  $stop = $false
  while ([Console]::KeyAvailable) {
    if ([Console]::ReadKey($true).Key -eq "Q") { $stop = $true }
  }
  if ($stop) { break }
  Start-Sleep -Milliseconds $IntervalMs
}

# ---- まとめ ----
$endedAt = Get-Date
# 実際に読んだ間隔（待つ時間に、プロセスと接続を読む時間が足される）
$averageSeconds = 0
if ($samples -gt 0) { $averageSeconds = [math]::Round(($endedAt - $startedAt).TotalSeconds / $samples, 1) }

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("=== つむぎの通信の記録 ===")
$lines.Add("名前：$Label")
$lines.Add("開始：$($startedAt.ToString('yyyy-MM-dd HH:mm:ss'))")
$lines.Add("終了：$($endedAt.ToString('yyyy-MM-dd HH:mm:ss'))")
$lines.Add("読んだ回数：$samples（平均 $averageSeconds 秒ごと。1回ごとに $IntervalMs ミリ秒待つ）")
if (-not $foundElectron) {
  $lines.Add("注意：つむぎの Electron が一度も見つからなかった（パスに「$PathMatch」が入った electron.exe）。この記録は、確かめに使えない。")
}

$electronOutside = 0
foreach ($group in $groupTitles.Keys) {
  $lines.Add("")
  $lines.Add("[$($groupTitles[$group])]")
  $rows = foreach ($key in $seen.Keys) {
    $parts = $key -split "\|"
    if ($parts[0] -ne $group) { continue }
    [pscustomobject]@{
      Kind = Get-AddressKind $parts[2]; Name = $parts[1]; Address = $parts[2]; Port = [int]$parts[3]; Count = $seen[$key]
    }
  }
  if (-not $rows) { $lines.Add("  （接続なし）"); continue }
  foreach ($kind in @("PCの中", "社内", "インターネット")) {
    $kindRows = @($rows | Where-Object { $_.Kind -eq $kind } | Sort-Object Address, Port, Name)
    $lines.Add("  ${kind}：$($kindRows.Count)件")
    foreach ($r in $kindRows) {
      $lines.Add(("    {0}:{1}  {2}  （見た回数 {3}）" -f $r.Address, $r.Port, $r.Name, $r.Count))
    }
    if ($group -eq "Electron" -and $kind -ne "PCの中") { $electronOutside += $kindRows.Count }
  }
}

$lines.Add("")
$lines.Add("つむぎ本体（Electron）から、PC の外への接続先：$electronOutside 件")

$lines | Set-Content -Path $OutFile -Encoding utf8
$lines | ForEach-Object { Write-Host $_ }
Write-Host ""
Write-Host "記録を書きました：$OutFile"
