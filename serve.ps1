# =====================================================================
# whiteboard-game を配信する簡易サーバー(Windows標準のPowerShellだけで動く)
# Node.js や Python のインストールは不要。.NET の HttpListener を使う。
# 起動に成功したら、その瞬間に既定のブラウザで http://localhost:8081/ を開く。
# このウィンドウを閉じるとサーバーは止まる。
# =====================================================================

param(
  [int]$Port = 8081,
  [string]$Root = "whiteboard-game"
)

$ErrorActionPreference = "Stop"

# 拡張子ごとのMIMEタイプ。無ければ汎用バイナリ扱いにする。
$MimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".wasm" = "application/wasm"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
}

# 1件のリクエストに応答する。ファイルがあれば中身を、無ければ404を返す。
function serve_one_request($Context, $FullRoot, $MimeTypes) {
  $Request = $Context.Request
  $Response = $Context.Response

  # URLのパスをファイルパスに直す(末尾/はindex.htmlにする)
  $RelPath = [System.Uri]::UnescapeDataString($Request.Url.AbsolutePath.TrimStart("/"))
  if ($RelPath -eq "") { $RelPath = "index.html" }
  $FullFile = [System.IO.Path]::GetFullPath((Join-Path $FullRoot $RelPath))

  # 配信フォルダの外を指すリクエストは拒否する(ディレクトリトラバーサル対策)
  if (-not $FullFile.StartsWith($FullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $Response.StatusCode = 403
    $Response.Close()
    return
  }

  if (Test-Path $FullFile -PathType Leaf) {
    $Bytes = [System.IO.File]::ReadAllBytes($FullFile)
    $Ext = [System.IO.Path]::GetExtension($FullFile).ToLower()
    if ($MimeTypes.ContainsKey($Ext)) { $Response.ContentType = $MimeTypes[$Ext] }
    else { $Response.ContentType = "application/octet-stream" }
    $Response.Headers.Add("Cache-Control", "no-store") # 編集がすぐ反映されるようキャッシュ無効
    $Response.ContentLength64 = $Bytes.Length
    $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
  } else {
    $Response.StatusCode = 404
    $Msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $RelPath")
    $Response.OutputStream.Write($Msg, 0, $Msg.Length)
  }
  $Response.Close()
}

# --- ここから本体 ---

# このスクリプトのある場所を基準にする(どこから起動しても同じ結果になる=環境非依存)
$RootPath = Join-Path $PSScriptRoot $Root
if (-not (Test-Path $RootPath)) {
  Write-Host "配信フォルダが見つかりません: $RootPath"
  Read-Host "Enterキーで終了します"
  exit 1
}

# 配信フォルダの絶対パス(末尾に区切り文字を付けて外部アクセス判定に使う)
$FullRoot = [System.IO.Path]::GetFullPath($RootPath)
if (-not $FullRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
  $FullRoot += [System.IO.Path]::DirectorySeparatorChar
}

# localhost 宛ての待ち受けは管理者権限なしで開ける
$Prefix = "http://localhost:$Port/"
$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add($Prefix)
try {
  $Listener.Start()
} catch {
  Write-Host "ポート $Port を開けませんでした。別のプログラムが使用中かもしれません。"
  Read-Host "Enterキーで終了します"
  exit 1
}

Write-Host "サーバーを起動しました: $Prefix"
Write-Host "このウィンドウを閉じるとサーバーが止まります。"

# 起動できた瞬間に既定のブラウザで開く(サーバーが準備できてから開くので確実)
try { Start-Process $Prefix } catch { }

# ブラウザからのリクエストを1件ずつ処理する
while ($Listener.IsListening) {
  try {
    $Context = $Listener.GetContext()
    serve_one_request $Context $FullRoot $MimeTypes
  } catch {
    break # ウィンドウを閉じた等でリスナーが止まったら抜ける
  }
}

$Listener.Stop()
