# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code (claude.ai/code) へのガイダンスを提供します。

## これは何か

ブラウザで動く「斜面を描いてボールを転がす」物理演算おもちゃです。線を描く方法は、マウスでの手描き、またはアップロードした画像・ライブカメラから OpenCV で黒ペンの線を検出する方法があり、その線の上をボールが転がり落ちます。ホワイトボードに投影して、実際に描いた絵がそのままゲームの地形になることを想定しています。

UI テキストとコードコメントは**日本語**です — 新しいコメント/UI文字列もそれに合わせて日本語で記述してください。

## ディレクトリ構成と起動方法

実際のアプリは入れ子になった `whiteboard-game/` サブフォルダにあります(パスは `whiteboard-game/index.html`、`whiteboard-game/js/*.js`)。

**ビルドシステム、パッケージマネージャ、テストスイートは存在しません** — p5.js・matter.js・OpenCV.js を CDN から読み込む静的ファイルのみです。ファイルを直接編集してください。

JavaScript は **STS分割法**(入力/変換/出力)で `js/` フォルダの下、`input/`・`transform/`・`output/` の3サブフォルダに分割され、index.html が `<script>` タグで順次読み込みます(config → shared → transform → output → input → main の順)。**ESモジュール(`import`/`export`)は使いません** — p5.js のグローバルモードが `setup`/`draw` をグローバルに見つける必要があるためで、全ファイルはグローバル関数宣言で書きます。

```
whiteboard-game/js/
  config.js                       … 全定数。状態は持たない
  shared_homography.js            … ホモグラフィー計算の純関数群(カメラ/プロジェクタ両補正の共通機能)
  input/                          【入力(源泉)】
    mouse.js                      … p5マウスコールバック → 手描き線分
    image.js                      … 画像ファイル選択・SourceImage保持・read_detection_params(スライダー読取の一元化)
    camera.js                     … カメラ列挙/開始・平均化キャプチャ・リアルタイムタイマー
    camera_calib.js               … カメラ手動4隅補正(状態を所有、warp_camera_to_rectangle)
  transform/                      【変換(中心変換)】
    mask.js                       … マスク生成(HSV/適応的二値化)・モルフォロジー
    detect.js                     … detect_polygons(純変換の統括)・差分判定(PreviousMask所有)
    contact.js                    … 効果音の判定(衝突音か転がり音か。前フレームの接触状態を所有)
  output/                         【出力(吸収)】
    physics.js                    … matter.jsボディの生成/削除(HandLines/ImageLines/Ballsを所有)・接触の素データ取り出し
    sound.js                      … 効果音(WebAudioで合成。衝突音と転がり音)
    render.js                     … p5描画(線・ボール・輪郭デバッグ)
    status.js                     … DOMラベル・マスクプレビュー表示の吸収点
    fullscreen.js                 … フルスクリーン
    projector.js                  … プロジェクタ4隅キーストーン補正(apply_canvas_projection)
    projection.js                 … 投影ウィンドウ(2画面出力)
  main.js                         … p5のsetup/draw/keyPressedと統括(run_detection/clear_all)
```

カメラアクセス(`getUserMedia`)と CDN スクリプトの都合上、**HTTP経由での配信が必須**です(`file://` では不可)。`.claude/launch.json` に起動設定があります(`npx http-server` で `whiteboard-game/` フォルダをポート8123で配信)。プレビューツール/サーバー名 `whiteboard` での `preview_start`、または `whiteboard-game/` をルートとする任意の静的サーバーを使用してください。

## アーキテクチャ

[index.html](whiteboard-game/index.html) が UI/コントロール/CSS全て、ロジックは `whiteboard-game/js/` の各モジュール(上記の構成)です。3つの CDN ライブラリが連携します:

- **p5.js** — 描画ループ(`draw()`)とキャンバス。内部解像度は `CANVAS_W`×`CANVAS_H`(800×600)で固定
- **matter.js** — 物理演算。線は**静的**な矩形ボディ、ボールは**動的**な円ボディ。線の当たり判定の太さ(`LINE_COLLISION_THICKNESS`)は、ボールが小さな隙間から抜け落ちないよう、見た目の太さ(`LINE_THICKNESS`)より意図的に太くしてある
- **OpenCV.js**(`@techstark/opencv-js`) — 画像から線への検出。非同期で読み込まれ、WASMランタイムの初期化が完了するまで `window.cvReady` / `window.handle_cv_ready` が使用をゲートする

**2つの独立した線ソース**を別々の配列で保持し、片方を作り直してももう片方に影響しないようにしています: `HandLines`(マウス描画)と `ImageLines`(検出結果、スライダー変更のたびに作り直される)。ボールは `Balls` に格納され、いずれも output/physics.js が所有し、外へはアクセサ(`get_hand_lines` 等)だけを公開します。

### 検出のデータフロー(STSの中核)

検出は `main.js` の `run_detection(Img)` が「入力→変換→出力」を**引数と戻り値だけで**繋ぎます(データ結合):

```
run_detection(Img)
  ├ Params = read_detection_params()     [入力: スライダー/セレクトのDOM読取を一元化]
  ├ Result = detect_polygons(Img, Params) [変換: 純関数。DOM/matter.js/p5に触れない]
  │    Result = { Polygons, AcceptedCount, DiffCount, ShouldUpdate, MaskCanvas }
  ├ show_mask_preview / show_diff_status   [出力: DOM表示]
  └ ShouldUpdateなら rebuild_image_terrain(Polygons) → set_contour_debug → show_detection_count
```

変換の内部: `GaussianBlur` → マスク生成(`Params.Method` で選ぶ **HSV黒ペンマスク** `build_black_pen_mask` または**適応的二値化** `build_adaptive_threshold_mask`) → モルフォロジー処理 `apply_morphology`(OPEN/dilate/CLOSE) → `PreviousMask` との**差分チェック**(`evaluate_mask_change`: しきい値未満の画素しか変化していなければ `ShouldUpdate=false` を返し地形の再構築をスキップ — これによりリアルタイムのカメラモードが軽量になる) → `findContours` → `approxPolyDP`(`contour_to_points`) → ポリゴン点列。画像の縁に接する輪郭(`touches_image_edge`)はフレームの映り込みとして破棄される。

検出した輪郭はキャンバスに収まるよう拡大縮小・中央寄せされる。変換パラメータは `compute_fit_transform` が毎回計算し直す。

### 効果音のデータフロー(衝突音と転がり音を重複させない設計)

毎フレーム `main.js` の `run_contact_sound()` が、検出と同じく「入力→変換→出力」を**引数と戻り値だけで**繋ぐ:

```
run_contact_sound()
  ├ Contacts = collect_ball_contacts()          [源泉: output/physics.js — matter.jsの接触ペアを平たい素データにするだけ]
  │    Contacts = { Balls: [{Id, Vx, Vy, IsTouching, NormalX, NormalY}], BallPairs: [...] }
  ├ Events = evaluate_contact_sounds(Contacts)  [変換: transform/contact.js。純関数。matter.js/DOM/WebAudioに触れない]
  │    Events = { Impacts: [{Strength: 0〜1, IsBallHit}], RollLevel: 0〜1 }
  └ play_contact_sounds(Events)                 [出力: output/sound.js。0〜1の数値しか知らない]
```

**重複しない理由(この機能の核心)**: 線は1本の連続した線ではなく、`add_line_segment` が作った独立ボディが数十個連なったものである。そのため「新しい接触ペアができたら衝突音」とすると、転がっているだけのボールがセグメントを跨ぐたびに衝突音が連射される。そこで判定を**ペア単位ではなくボール単位の状態遷移**で行う:

- **衝突音** = ボールが「どの静的ボディにも触れていない → 何かに触れた」と**遷移したフレームだけ**。転がり中はセグメントを乗り継いでも接触が途切れないので遷移が起きず、鳴りようがない
- **転がり音** = 接触が**継続している**ボールの、面に沿った速度(接線成分 = 速度と法線の外積)だけ。衝突したフレームは接触が継続していないので寄与しない

同じ1つの状態機械の相互排他な2つの枝なので、構造的に重複しない。衝突の強さは**前フレームの速度**を法線へ射影して求める(`Engine.update` 後の速度は跳ね返りが解決済みで、接近の勢いを過小評価するため)。

WebAudio の AudioContext は**最初のユーザー操作まで作れない**(ブラウザが操作前の再生を禁止している)ため、sound.js は `window` に一度きりの `pointerdown`/`keydown` リスナーを張って遅延生成する。転がり音は全ボール共通の1ボイスで、音源は鳴らしっぱなしにしてゲインだけを動かす(start/stop を繰り返すとプチノイズが出る)。

### 重要: OpenCV Mat のメモリ管理

OpenCV.js の Mat は**ガベージコレクションされません** — `new cv.Mat()` / `cv.imread` は必ず `.delete()` する必要があります。検出関数は繰り返し実行される(リアルタイムループ)ため、`let` 宣言した変数に確保し、単一の `try/finally` でまとめて解放しています。新しい OpenCV コードを書く際もこのパターンに従ってください。従わないと WASM メモリがリークし、最終的にタブがクラッシュします。

### カメラとリアルタイムモード

`capture_averaged_frame` は検出前に複数フレーム(`AVERAGE_FRAME_COUNT`)を平均化し、センサーノイズを抑えます。リアルタイムモード(`setInterval` → `run_realtime_tick`)はタイマーで再キャプチャを行い、`IsRealtimeProcessing` による多重実行防止ガードを持ちます。

### カメラの手動4隅補正(遠近補正 / 透視補正)

カメラを斜めに設置すると、写ったホワイトボードは台形に歪み、奥ほど線が小さくなります。これを手動で補正します。**プロジェクタ補正とは完全に独立した別の調整**です(入力画像側の補正)。

- プレビュー(`#roiOverlayCanvas`)上に4隅ハンドルを表示し、ホワイトボードの実際の角へドラッグして合わせます。4隅は映像ネイティブ解像度に対する0〜1の比率 `CameraCornerFractions`(`[左上,右上,右下,左下]`)で保持し、`localStorage`(`camera_corners_v1`)に永続化します。状態は input/camera_calib.js が所有し、外へは `get_camera_corners` / `is_camera_calib_dragging` のアクセサだけを公開します
- 検出時、`capture_camera_frame`(input_camera.js)は 4隅が設定されていれば `warp_camera_to_rectangle` を呼び、その四辺形を **16:9固定解像度**(`CAMERA_WARP_W`×`CAMERA_WARP_H` = 1280×720)の長方形へ透視補正してから検出パイプラインへ渡します。平面を斜めから見た歪みは、この4隅1回のホモグラフィー(`cv.getPerspectiveTransform` + `cv.warpPerspective`)で「台形の形状」と「奥行きによる大きさの違い」が同時に長方形へ戻ります(=遠近補正と透視補正を1回で達成。レンズ歪み補正は対象外)
- OpenCV の Mat メモリ管理規律は同様に適用: `warp_camera_to_rectangle` は確保した Mat(`Src`/`SrcTri`/`DstTri`/`M`/`Warped`)を単一の `finally` で解放します

### 座標系は不可侵

800×600 の物理演算/描画座標系は**絶対にリサイズしません**。フルスクリーンやプロジェクタキャリブレーションが変更するのはキャンバス要素の **CSS表示**のみで、内部解像度には触れません — そのため物理演算に影響はありません。この不変条件を守ってください: `CANVAS_W/H` や `resizeCanvas` を触るのではなく、CSSで拡大縮小すること。

### プロジェクタのキーストーン補正(プロジェクタ調整)

斜めから投影したとき(例: 側面から45度)の台形歪みを補正し、正面から投影したように見せます。キャンバス要素への CSS `matrix3d` として適用される純粋な**ホモグラフィー(射影変換)**で、物理演算や描画には一切影響しません。**カメラの手動4隅補正とは完全に独立**しています(出力画像側の補正)。

- ドラッグ可能な4つの角ハンドル(`#calibOverlay`)。位置はビューポートに対する割合として `ProjectorCornerFractions`(output/projector.js が所有)に保持され、`localStorage`(`projcam_corners_v1`)に永続化されるので、リロードしても補正が残ります
- `compute_homography(Src, Dst)` が `H = D · adj(S)`(`basis_to_points`/`adj3` ヘルパー、js/shared_homography.js)で4点対応を解く。`homography_to_css_matrix3d` が3×3の H を CSS の列優先4×4 `matrix3d` に並べ替える
- `apply_canvas_projection` がキャンバスの配置・変形を行う唯一の箇所。調整モードと実際のフルスクリーンの両方から呼ばれるため、保存済みのキーストーン補正はフルスクリーン投影時にも適用される
- 調整はあえて(Fullscreen APIではなく)ウィンドウ全面のオーバーレイで行う。理由は、Fullscreen API 中はキャンバスの兄弟DOM(ハンドル)が隠れてしまうため。なお、キーストーン変換下では p5 の `mouseX`/`mouseY` は近似値になる(p5 は線形なスケーリングを前提としている) — 投影中のマウス描画は不正確になることが想定内

**設計方針: カメラ補正とプロジェクタ補正は別々の手動調整**です。両者を結合していた「カメラで自動調整(構造化光)」機能は削除しました。カメラ側は入力画像を長方形へ透視補正し、プロジェクタ側は出力キャンバスを投影面の4隅へキーストーン補正する — それぞれ独立に手動で合わせます。

## 注意点(Gotchas)

- OpenCV関連の機能は `cvReady` で `enable_image_upload()` が発火するまで無効。`setup()` の最後でレース条件に対処している(index.html のインラインスクリプトが `window.handle_cv_ready` を呼ぶ)
- ファイル `<input>` の値は選択のたびにクリアされるため、同じファイルを再選択しても `change` イベントが発火する
- スライダーは `schedule_reprocess`(1回の `requestAnimationFrame` にまとめられる)経由で、保持している `SourceImage`(input/image.js)に対して検出を再実行する

## プログラムの設計の原則について
- 処理のかたまり(ルーチン)は1ページ（20~30行)程度にまとめること。
- ひとまとめにした処理はそれだけで意味を完結できることにすること
- できるだけ単純な構造で作成すること
- データの宣言は明示すること
- 変数はアッパーキャメルで命名
- 関数は関数はスネークケースで命名
- すべてのプログラムが機能的強度(特定の明確に定義できる1つの機能だけのモジュール)になるようにしてほしい
- できるだけモジュールの結合度は下げる方針(ソフトウェア工学で言うデータ結合の状態にして)
- STS分割法を使い入力処理、変換処理、出力処理に分割していくこと。
- モジュールの強度はできるだけ機能的強度にすること

### 命名規則の適用例外(技術的制約による)

- **p5.jsコールバック**(`setup`/`draw`/`mousePressed`/`mouseDragged`/`mouseReleased`/`keyPressed`)は p5.js の仕様で名前が固定されており改名不可
- **ライブラリ識別子**(`cv`、`Matter`、`Engine`/`World`/`Bodies`、p5の `mouseX`/`background` 等)はそのまま使う
- **定数**(`const` の設定値)は `CANVAS_W` のような大文字スネークケース。アッパーキャメルにするのは `let` の状態変数とローカル変数
- **データオブジェクトのプロパティ名**(`{x, y}`、`{fx, fy}` 等)は小文字のまま — localStorage の保存形式(`camera_corners_v1`/`projcam_corners_v1`)との互換、および座標点としてホモグラフィー計算と共有する形式のため
- index.html と連携するグローバルフック(`window.cvReady` はインラインスクリプト側が定義、`window.handle_cv_ready` はこちら側)は両ファイルで名前を一致させること
