// =====================================================================
// 【出力】プロジェクタ調整 = キーストーン(台形)補正
//
// 斜め45度など、投影面に対して斜めからプロジェクタを当てると、投影像は
// 台形にゆがむ。これを「正面から投影したように」戻すには、ゲーム画面の
// 長方形(4隅)を、投影面の実際の4隅へ写す射影変換(ホモグラフィー)を
// 掛ければよい。物理演算・描画の座標系(800x600)は一切変えず、キャンバス
// 要素に CSS transform: matrix3d(...) を掛けて「見た目」だけを歪ませる。
//
// 手順:
//   1) 元の長方形の4隅(src)と、四隅ドラッグで合わせた4隅(dst)を用意
//   2) src -> dst を満たす 3x3 ホモグラフィー行列 H を解く(js/shared_homography.js)
//   3) H を CSS matrix3d(列優先の4x4)へ並べ替えてキャンバスに適用
//
// カメラの手動4隅補正(input_camera_calib)とは完全に独立した出力側の補正。
// =====================================================================

// 4隅の位置は、ウィンドウサイズが変わっても比率で復元できるよう
// ビューポートに対する割合 {fx, fy}(0~1)で保持する。null = 未調整(既定の長方形)。
let ProjectorCornerFractions = null;
let CalibrationActive = false;
let HandlesVisible = true;
let SavedCalibDisplays = {};
let CalibrationDirty = false; // 保存(localStorage)していない変更があるか
let DragHandleIndex = -1;     // ドラッグ中のハンドルindex。-1 = ドラッグしていない
let DragRAF = null;           // ドラッグ中の再計算をまとめるrequestAnimationFrame ID

function init_calibration() {
  load_saved_corners();
  document.getElementById('calibrateBtn').addEventListener('click', enter_calibration);
  document.getElementById('calibExitBtn').addEventListener('click', exit_calibration);
  document.getElementById('calibResetBtn').addEventListener('click', reset_corners);
  document.getElementById('calibSaveBtn').addEventListener('click', save_calibration);
  document.getElementById('calibToggleHandlesBtn').addEventListener('click', toggle_handles);
  init_handle_dragging();

  window.addEventListener('resize', () => {
    if (CalibrationActive) {
      apply_canvas_projection();
      position_handles();
    }
  });
}

// --- 調整モードの開始/終了 -------------------------------------------

function enter_calibration() {
  // オーバーレイのハンドルはフルスクリーン要素の外側にあり、Fullscreen API 中は
  // 隠れてしまうため、いったんフルスクリーンを抜けてから通常のウィンドウ全面で調整する
  if (document.fullscreenElement) {
    document.exitFullscreen();
  }

  CalibrationActive = true;
  HandlesVisible = true;
  set_calib_hidden_ui(true);
  document.getElementById('calibOverlay').classList.add('active');
  document.getElementById('calibToggleHandlesBtn').textContent = 'ハンドルを隠す';

  apply_canvas_projection();
  update_handles_visibility();
  position_handles();
  update_calib_status();
}

function exit_calibration() {
  CalibrationActive = false;
  document.getElementById('calibOverlay').classList.remove('active');
  set_calib_hidden_ui(false);

  // 通常表示に戻す(保存した4隅は残るので、次回のフルスクリーン/調整で再適用される)
  reset_canvas_scale();
}

function toggle_handles() {
  HandlesVisible = !HandlesVisible;
  document.getElementById('calibToggleHandlesBtn').textContent =
    HandlesVisible ? 'ハンドルを隠す' : 'ハンドルを表示';
  update_handles_visibility();
}

// 四隅を既定(ゆがみなし)に戻す。localStorageへの保存は「保存」ボタンを押すまで行わない。
function reset_corners() {
  ProjectorCornerFractions = null;
  CalibrationDirty = true;
  apply_canvas_projection();
  position_handles();
  update_calib_status();
}

// 現在の四隅をlocalStorageへ明示保存する(単一スロット)
function save_calibration() {
  save_corners();
  CalibrationDirty = false;
  update_calib_status('保存しました');
}

// 保存状態のラベルを更新する。Messageを渡すと一時的にその文言を出す。
function update_calib_status(Message, Color) {
  const El = document.getElementById('calibStatus');
  if (!El) return;
  if (Message) {
    El.textContent = Message;
    El.style.color = Color || '#8f8';
  } else if (CalibrationDirty) {
    El.textContent = '未保存の変更あり';
    El.style.color = '#fc8';
  } else {
    El.textContent = ProjectorCornerFractions ? '保存済み' : '未調整';
    El.style.color = '#aaa';
  }
}

// 調整中は編集用UI・プレビュー類を隠し、終了時に元の表示状態へ戻す
function set_calib_hidden_ui(Hide) {
  CALIB_HIDDEN_IDS.forEach((Id) => {
    const El = document.getElementById(Id);
    if (!El) return;
    if (Hide) {
      SavedCalibDisplays[Id] = El.style.display;
      El.style.display = 'none';
    } else {
      El.style.display = SavedCalibDisplays[Id] || '';
    }
  });
}

// --- 4隅ハンドルの表示・ドラッグ -------------------------------------

function update_handles_visibility() {
  document.querySelectorAll('.calib-handle').forEach((H) => {
    H.style.display = HandlesVisible ? 'block' : 'none';
  });
}

function position_handles() {
  const Px = corner_fractions_to_px(current_corner_fractions());
  document.querySelectorAll('.calib-handle').forEach((H) => {
    const I = Number(H.dataset.corner);
    H.style.left = `${Px[I].x}px`;
    H.style.top = `${Px[I].y}px`;
  });
}

function init_handle_dragging() {
  document.querySelectorAll('.calib-handle').forEach((Handle) => {
    Handle.addEventListener('pointerdown', (Event) => on_handle_down(Handle, Event));
    Handle.addEventListener('pointermove', on_handle_move);
    Handle.addEventListener('pointerup', on_handle_up);
  });
}

function on_handle_down(Handle, Event) {
  Event.preventDefault();
  DragHandleIndex = Number(Handle.dataset.corner);
  Handle.setPointerCapture(Event.pointerId);
}

// pointermoveは1秒間に100回以上発火し得るが、apply_canvas_projection は
// ホモグラフィー計算に加え投影ウィンドウが開いていればそちらのDOMも
// 更新するため、1フレームに1回(rAF)へまとめて余計な再計算を避ける。
function on_handle_move(Event) {
  if (DragHandleIndex < 0) return;

  const X = Math.max(0, Math.min(window.innerWidth, Event.clientX));
  const Y = Math.max(0, Math.min(window.innerHeight, Event.clientY));
  set_corner_fraction(DragHandleIndex, X / window.innerWidth, Y / window.innerHeight);

  if (DragRAF === null) {
    DragRAF = requestAnimationFrame(() => {
      DragRAF = null;
      apply_canvas_projection();
      position_handles();
    });
  }
}

function on_handle_up(Event) {
  if (DragHandleIndex < 0) return;
  Event.target.releasePointerCapture(Event.pointerId);
  DragHandleIndex = -1;

  if (DragRAF !== null) {
    cancelAnimationFrame(DragRAF);
    DragRAF = null;
  }
  apply_canvas_projection(); // 最後の位置を確実に反映する
  position_handles();
  CalibrationDirty = true; // 保存は明示ボタンに任せる(自動保存しない)
  update_calib_status();
}

// 1隅だけ動かすときも、他の3隅は現在値(未調整なら既定)から引き継ぐ
function set_corner_fraction(I, Fx, Fy) {
  if (!ProjectorCornerFractions) {
    ProjectorCornerFractions = current_corner_fractions().map((C) => ({ fx: C.fx, fy: C.fy }));
  }
  ProjectorCornerFractions[I] = { fx: Fx, fy: Fy };
}

// --- 4隅の座標(割合↔ピクセル)と保存 -------------------------------

function current_corner_fractions(W = window.innerWidth, H = window.innerHeight) {
  return ProjectorCornerFractions ? ProjectorCornerFractions : default_corner_fractions(W, H);
}

// 既定の4隅 = 指定ビューポート中央に、アスペクト比を保って最大化した長方形(=ゆがみなし)。
// W/H省略時はメインウィンドウ(window.innerWidth/innerHeight)を対象とする。
// 投影ウィンドウ側(layout_projection_canvas)は自身のビューポートサイズを明示的に渡す。
function default_corner_fractions(W = window.innerWidth, H = window.innerHeight) {
  const Scale = Math.min(W / CANVAS_W, H / CANVAS_H);
  const DispW = CANVAS_W * Scale;
  const DispH = CANVAS_H * Scale;
  const Ox = (W - DispW) / 2;
  const Oy = (H - DispH) / 2;
  return [
    { fx: Ox / W, fy: Oy / H },                      // 0: 左上
    { fx: (Ox + DispW) / W, fy: Oy / H },            // 1: 右上
    { fx: (Ox + DispW) / W, fy: (Oy + DispH) / H },  // 2: 右下
    { fx: Ox / W, fy: (Oy + DispH) / H },            // 3: 左下
  ];
}

function corner_fractions_to_px(Fr, W = window.innerWidth, H = window.innerHeight) {
  return Fr.map((C) => ({ x: C.fx * W, y: C.fy * H }));
}

// 指定ビューポートサイズに、アスペクト比を保って収まる表示矩形(DispW/DispH)と、
// そのキャンバスローカル座標(左上原点)での4隅(src)を計算する。
// apply_canvas_projection(メインウィンドウ)とlayout_projection_canvas(投影ウィンドウ)の
// 両方から共通で使われる — 同じ計算を2箇所に持たないための唯一の実装。
function compute_display_rect(W, H) {
  const Scale = Math.min(W / CANVAS_W, H / CANVAS_H);
  const DispW = CANVAS_W * Scale;
  const DispH = CANVAS_H * Scale;
  const Src = [
    { x: 0, y: 0 },
    { x: DispW, y: 0 },
    { x: DispW, y: DispH },
    { x: 0, y: DispH },
  ];
  return { DispW, DispH, Src };
}

function save_corners() {
  try {
    if (ProjectorCornerFractions) {
      localStorage.setItem(PROJCAM_STORAGE_KEY, JSON.stringify(ProjectorCornerFractions));
    } else {
      localStorage.removeItem(PROJCAM_STORAGE_KEY);
    }
  } catch (E) {
    /* localStorage が使えない環境でも動作は続ける */
  }
}

function load_saved_corners() {
  try {
    const Raw = localStorage.getItem(PROJCAM_STORAGE_KEY);
    if (!Raw) return;
    const Arr = JSON.parse(Raw);
    if (Array.isArray(Arr) && Arr.length === 4 && Arr.every((C) => typeof C.fx === 'number' && typeof C.fy === 'number')) {
      ProjectorCornerFractions = Arr;
    }
  } catch (E) {
    /* 壊れた保存値は無視して既定に戻す */
  }
}

// --- キャンバスへの適用 ----------------------------------------------

// キャンバスをビューポート左上基準に配置し、元の長方形(src)を調整後の4隅(dst)へ
// 写すホモグラフィーを CSS transform として適用する。フルスクリーン時・調整時の両方から呼ばれる。
function apply_canvas_projection() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const { DispW, DispH, Src } = compute_display_rect(W, H);
  const Dst = corner_fractions_to_px(current_corner_fractions(W, H), W, H);

  const Canvas = get_game_canvas();
  Canvas.style.position = 'fixed';
  Canvas.style.left = '0';
  Canvas.style.top = '0';
  Canvas.style.width = `${DispW}px`;
  Canvas.style.height = `${DispH}px`;
  Canvas.style.margin = '0';
  Canvas.style.transformOrigin = '0 0';
  Canvas.style.transform = homography_to_css_matrix3d(Src, Dst);

  // 投影ウィンドウを開いている間は、キーストーン調整をそちらへも反映する
  if (is_projecting()) {
    layout_projection_canvas();
  }
}

// キャンバスのCSS配置・変形を通常表示(中央寄せ)へ戻す
function reset_canvas_scale() {
  const Canvas = get_game_canvas();
  Canvas.style.width = '';
  Canvas.style.height = '';
  Canvas.style.position = '';
  Canvas.style.top = '';
  Canvas.style.left = '';
  Canvas.style.transform = '';
  Canvas.style.transformOrigin = '';
  Canvas.style.margin = '';
}
