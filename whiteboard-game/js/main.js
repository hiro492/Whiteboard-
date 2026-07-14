// =====================================================================
// 統括(main)「お絵かき斜面ボールゲーム」
// p5.jsのライフサイクル(setup/draw/keyPressed。関数名はp5.jsの仕様で固定)と、
// 「入力→変換→出力」のデータフローを繋ぐ統括処理だけを持つ薄い層。
// 各機能は js/ フォルダのSTS分割されたモジュール(input_*/transform_*/output_*)にある。
// =====================================================================

let GameCanvasElement = null; // p5.jsのcanvas本体(フルスクリーン/投影の対象)

// キャンバス要素を出力系モジュール(フルスクリーン/プロジェクタ/投影)へ渡すアクセサ
function get_game_canvas() {
  return GameCanvasElement;
}

// p5.jsの初期化コールバック。各モジュールの init_*(自分のDOMリスナーは自分で張る)を呼ぶだけ。
function setup() {
  const Cnv = createCanvas(CANVAS_W, CANVAS_H);
  GameCanvasElement = Cnv.elt;

  init_physics();

  document.getElementById('clearBtn').addEventListener('click', clear_all);
  init_sound();
  init_fullscreen();
  init_calibration();
  init_projection();
  init_image_input();
  init_camera_controls();
  init_camera_calib();

  // このファイルの読み込みより先に opencv.js の初期化が終わっていた場合に備える
  if (window.cvReady) {
    enable_image_upload();
  }
}

// p5.jsの毎フレームコールバック: 物理を進めて、音を鳴らして、描画する
function draw() {
  update_physics();
  run_contact_sound();

  background(30);

  draw_lines(get_hand_lines());
  draw_lines(get_image_lines());
  draw_balls(get_balls());
  draw_contour_debug();

  remove_fallen_balls();
}

function keyPressed() {
  if (key === ' ') {
    drop_ball(mouseX, mouseY);
  }
}

// 検出の統括: 入力(パラメータ読取)→変換(純関数)→出力(地形・表示)を
// 引数と戻り値だけで繋ぐ(データ結合)。画像選択・カメラキャプチャ・スライダー変更から呼ばれる。
function run_detection(Img) {
  const Params = read_detection_params();
  const Result = detect_polygons(Img, Params);

  show_mask_preview(Result.MaskCanvas);
  show_diff_status(Result.DiffCount, Result.ShouldUpdate);
  if (!Result.ShouldUpdate) return;

  rebuild_image_terrain(Result.Polygons);
  set_contour_debug(Result.Polygons);
  show_detection_count(Result.AcceptedCount);
}

// 効果音の統括: 接触の素データ(物理)→ 変換(衝突音か転がり音かの判定)→ 出力(WebAudio)を
// 引数と戻り値だけで繋ぐ(run_detection と同じ形)。毎フレーム draw から呼ばれる。
function run_contact_sound() {
  const Contacts = collect_ball_contacts();
  const Events = evaluate_contact_sounds(Contacts);

  play_contact_sounds(Events);
}

// 全消去の統括: 物理ボディ・デバッグ表示・検出メモリをまとめて初期化する
function clear_all() {
  clear_physics();
  set_contour_debug([]);
  clear_detection_memory(); // クリア後は次回の検出を必ず更新させる
}
