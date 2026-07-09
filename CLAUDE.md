# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code (claude.ai/code) へのガイダンスを提供します。

## これは何か

ブラウザで動く「斜面を描いてボールを転がす」物理演算おもちゃです。線を描く方法は、マウスでの手描き、またはアップロードした画像・ライブカメラから OpenCV で黒ペンの線を検出する方法があり、その線の上をボールが転がり落ちます。ホワイトボードに投影して、実際に描いた絵がそのままゲームの地形になることを想定しています。

UI テキストとコードコメントは**日本語**です — 新しいコメント/UI文字列もそれに合わせて日本語で記述してください。

## ディレクトリ構成と起動方法

実際のアプリは入れ子になった `whiteboard-game/` サブフォルダにあります(リポジトリルートにも `whiteboard-game/` があります — パスは `whiteboard-game/index.html`、`whiteboard-game/sketch.js`)。

**ビルドシステム、パッケージマネージャ、テストスイートは存在しません** — p5.js・matter.js・OpenCV.js を CDN から読み込む2つの静的ファイルのみです。ファイルを直接編集してください。

カメラアクセス(`getUserMedia`)と CDN スクリプトの都合上、**HTTP経由での配信が必須**です(`file://` では不可)。`.claude/launch.json` に起動設定があります(`npx http-server` で `whiteboard-game/` フォルダをポート8123で配信)。プレビューツール/サーバー名 `whiteboard` での `preview_start`、または `whiteboard-game/` をルートとする任意の静的サーバーを使用してください。

## アーキテクチャ

ファイルは2つ: [index.html](whiteboard-game/index.html) が UI/コントロール/CSS全て、[sketch.js](whiteboard-game/sketch.js) がロジック全てです。3つの CDN ライブラリが連携します:

- **p5.js** — 描画ループ(`draw()`)とキャンバス。内部解像度は `CANVAS_W`×`CANVAS_H`(800×600)で固定
- **matter.js** — 物理演算。線は**静的**な矩形ボディ、ボールは**動的**な円ボディ。線の当たり判定の太さ(`LINE_COLLISION_THICKNESS`)は、ボールが小さな隙間から抜け落ちないよう、見た目の太さ(`LINE_THICKNESS`)より意図的に太くしてある
- **OpenCV.js**(`@techstark/opencv-js`) — 画像から線への検出。非同期で読み込まれ、WASMランタイムの初期化が完了するまで `window.cvReady` / `window.handleCvReady` が使用をゲートする

**2つの独立した線ソース**を別々の配列で保持し、片方を作り直してももう片方に影響しないようにしています: `handLines`(マウス描画)と `imageLines`(検出結果、スライダー変更のたびに作り直される)。ボールは `balls` に格納されます。

### 検出パイプライン(`detectLinesFromImage`)

`GaussianBlur` → マスク生成(方式ドロップダウンで選択する**HSV黒ペンマスク** `buildBlackPenMask` または**適応的二値化** `buildAdaptiveThresholdMask`) → モルフォロジー処理(OPEN/dilate/CLOSE、いずれもスライダーで制御) → `previousMask` との**差分チェック**(`evaluateMaskChange`: しきい値未満の画素しか変化していなければ地形の再構築をスキップ — これによりリアルタイムのカメラモードが軽量になる) → `findContours` → `approxPolyDP` → 各ポリゴンの辺が `addLineSegment` によって matter.js の静的ボディになる。画像の縁に接する輪郭(`touchesImageEdge`)はフレームの映り込みとして破棄される。

検出した輪郭はキャンバスに収まるよう拡大縮小・中央寄せされる。変換パラメータ(`scale`、`offsetX/Y`)は `detectLinesFromImage` の内部で毎回計算し直される。

### 重要: OpenCV Mat のメモリ管理

OpenCV.js の Mat は**ガベージコレクションされません** — `new cv.Mat()` / `cv.imread` は必ず `.delete()` する必要があります。検出関数は繰り返し実行される(リアルタイムループ)ため、`let` 宣言した変数に確保し、単一の `try/finally` でまとめて解放しています。新しい OpenCV コードを書く際もこのパターンに従ってください。従わないと WASM メモリがリークし、最終的にタブがクラッシュします。

### カメラとリアルタイムモード

`captureAveragedFrame` は検出前に複数フレーム(`AVERAGE_FRAME_COUNT`)を平均化し、センサーノイズを抑えます。任意の **ROI**(プレビューのオーバーレイ上に描画、`roiRectFraction` として映像ネイティブ解像度に対する0〜1の比率で保存)で処理対象範囲を切り出せます。リアルタイムモード(`setInterval` → `runRealtimeTick`)はタイマーで再キャプチャを行い、`isRealtimeProcessing` による多重実行防止ガードを持ちます。

### 座標系は不可侵

800×600 の物理演算/描画座標系は**絶対にリサイズしません**。フルスクリーンやプロジェクタキャリブレーションが変更するのはキャンバス要素の **CSS表示**のみで、内部解像度には触れません — そのため物理演算に影響はありません。この不変条件を守ってください: `CANVAS_W/H` や `resizeCanvas` を触るのではなく、CSSで拡大縮小すること。

### プロジェクタのキーストーン補正(プロカム調整)

斜めから投影したとき(例: 側面から45度)の台形歪みを補正し、正面から投影したように見せます。キャンバス要素への CSS `matrix3d` として適用される純粋な**ホモグラフィー(射影変換)**で、物理演算や描画には一切影響しません。

- ドラッグ可能な4つの角ハンドル(`#calibOverlay`)。位置はビューポートに対する割合として `projectorCornerFractions` に保持され、`localStorage`(`projcam_corners_v1`)に永続化されるので、リロードしても補正が残ります
- `computeHomography(src, dst)` が `H = D · adj(S)`(`basisToPoints`/`adj3` ヘルパー)で4点対応を解く。`homographyToCssMatrix3d` が3×3の H を CSS の列優先4×4 `matrix3d` に並べ替える
- `applyCanvasProjection` がキャンバスの配置・変形を行う唯一の箇所。調整モードと実際のフルスクリーンの両方から呼ばれるため、保存済みのキーストーン補正はフルスクリーン投影時にも適用される
- 調整はあえて(Fullscreen APIではなく)ウィンドウ全面のオーバーレイで行う。理由は、Fullscreen API 中はキャンバスの兄弟DOM(ハンドル)が隠れてしまうため。なお、キーストーン変換下では p5 の `mouseX`/`mouseY` は近似値になる(p5 は線形なスケーリングを前提としている) — 投影中のマウス描画は不正確になることが想定内

#### カメラによる自動アライメント(カメラで自動調整)

`autoCalibrate` は4隅の割合を手動ではなく**自動で**計算し、手動ドラッグとまったく同じ `projectorCornerFractions` を生成します(そのため完全に相互運用可能 — 自動調整後にドラッグで微調整し、保存、という流れが可能)。カメラが起動していること(投影面に対して正面・まっすぐに設置)、およびこのページが投影面に投影されていることが前提です。処理の流れ:

- **構造化光による差分検出**: `showCalibPattern` が全画面の `#calibPatternOverlay` を黒→白の順に一瞬表示し、`captureCalibrationMat` がそれぞれで平均化済みカメラフレームを取得する。`detectProjectedQuad` は絶対差分 → Otsu二値化 → モルフォロジー → 最大の外部輪郭を取り、極値法(x±yの最小/最大)で4隅を求める。この四角形はカメラから見た投影ビューポート(すなわちビューポートの4隅にスクリーン→カメラのホモグラフィー `F` を適用したもの)にあたる
- **補正計算**: `computeAutoCorners` がその四角形に内接する軸並行の4:3長方形を目標として選び(こうするとカメラ=正面から見た視聴者には歪みのない長方形に見える)、`computeHomography(cameraCorners, screenCorners)`(= `F⁻¹`、`projectPoint` で適用)でスクリーン座標へ逆算する。結果はそのまま `projectorCornerFractions` になるが、永続化にはユーザーが引き続き「保存」を押す必要がある
- 検出のガード: 明るい領域がフレームの2%未満なら `null` を返す(→「検出できませんでした」)。四角形がフレームの縁に達している場合は `touchesEdge` フラグを立てる(→「画角からはみ出しています」)。角が切れているとホモグラフィーが不正確になるため
- OpenCV の Mat メモリ管理規律は同様に適用: `detectProjectedQuad` は自身が確保した Mat を `finally` で解放し、`autoCalibrate` はキャプチャした2枚のフレームMat(`matA`/`matB`)を自身の `finally` で解放する

## 注意点(Gotchas)

- OpenCV関連の機能は `cvReady` で `enableImageUpload()` が発火するまで無効。`setup()` の最後でレース条件に対処している
- ファイル `<input>` の値は選択のたびにクリアされるため、同じファイルを再選択しても `change` イベントが発火する
- スライダーは `scheduleReprocess`(1回の `requestAnimationFrame` にまとめられる)経由で、保持している `lastLoadedImage` に対して検出を再実行する
