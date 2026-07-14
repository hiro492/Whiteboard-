// =====================================================================
// 【入力】カメラの手動4隅補正(遠近補正 / 透視補正)
//
// カメラを斜めに設置すると、写ったホワイトボードは台形に歪み、奥ほど線が
// 小さくなる。プレビュー上でホワイトボードの実際の4隅をドラッグ指定し、
// 検出前にその四辺形を16:9固定解像度の長方形へ透視補正する。
// 「台形の形状」と「奥行きによる大きさの違い」は、この4隅1回の
// ホモグラフィー(cv.getPerspectiveTransform + warpPerspective)で同時に戻る。
// プロジェクタ調整(output_projector)とは完全に独立した入力側の補正。
//
// 4隅の状態(CameraCornerFractions)はこのモジュールが所有し、外へは
// get_camera_corners / is_camera_calib_dragging のアクセサだけを公開する。
// =====================================================================

let CameraCornerFractions = null; // [tl,tr,br,bl] 各 {fx,fy}(video native解像度に対する0~1)。null = 未設定(全体を処理)
let CameraCalibEditing = false;   // カメラ4隅の編集モード中か(プレビュー上にハンドルを表示)
let CameraDragCorner = -1;        // ドラッグ中の隅index(0~3)。-1 = ドラッグしていない

// 現在の4隅設定を返す(未設定なら null)。カメラキャプチャ側から参照される
function get_camera_corners() {
  return CameraCornerFractions;
}

// 4隅をドラッグ操作中か(リアルタイム検出は中間状態を使わないようスキップする)
function is_camera_calib_dragging() {
  return CameraDragCorner >= 0;
}

// カメラ4隅補正UIのイベント登録(mainのsetupから呼ばれる)
function init_camera_calib() {
  document.getElementById('cameraCalibBtn').addEventListener('click', toggle_camera_calib);
  document.getElementById('cameraCalibResetBtn').addEventListener('click', reset_camera_corners);
  load_camera_corners();
  init_camera_calib_overlay();
}

// カメラプレビュー上で、ホワイトボードの4隅ハンドルをドラッグして指定する。
// 編集モード(CameraCalibEditing)中のみハンドルを操作できる。
function init_camera_calib_overlay() {
  const Canvas = document.getElementById('roiOverlayCanvas');
  Canvas.addEventListener('mousedown', on_overlay_mousedown);
  Canvas.addEventListener('mousemove', on_overlay_mousemove);
  window.addEventListener('mouseup', on_overlay_mouseup);
}

function on_overlay_mousedown(Event) {
  if (!CameraCalibEditing) return;
  const Canvas = document.getElementById('roiOverlayCanvas');
  const Video = document.getElementById('cameraPreview');
  if (!Video.videoWidth || !CameraCornerFractions) return;

  CameraDragCorner = pick_nearest_corner(Event.clientX, Event.clientY, Canvas, Video);
  if (CameraDragCorner >= 0) {
    update_dragged_corner(Event.clientX, Event.clientY, Canvas, Video);
  }
}

function on_overlay_mousemove(Event) {
  if (!CameraCalibEditing || CameraDragCorner < 0) return;
  const Canvas = document.getElementById('roiOverlayCanvas');
  const Video = document.getElementById('cameraPreview');
  update_dragged_corner(Event.clientX, Event.clientY, Canvas, Video);
}

function on_overlay_mouseup() {
  if (CameraDragCorner < 0) return;
  CameraDragCorner = -1;
  save_camera_corners(); // ドラッグ確定ごとに保存
}

// ドラッグ中の隅を、マウス位置(映像native比率)へ更新して描き直す
function update_dragged_corner(ClientX, ClientY, Canvas, Video) {
  const Frac = client_point_to_video_fraction(ClientX, ClientY, Canvas, Video);
  CameraCornerFractions[CameraDragCorner] = { fx: Frac.fracX, fy: Frac.fracY };
  draw_camera_quad();
}

// クリック位置に最も近い隅index(表示px距離がしきい値内)を返す。無ければ -1。
function pick_nearest_corner(ClientX, ClientY, Canvas, Video) {
  const Rect = Canvas.getBoundingClientRect();
  const Px = ClientX - Rect.left;
  const Py = ClientY - Rect.top;
  const Pts = corner_frac_to_box_px(Rect.width, Rect.height, Video);

  let Best = -1;
  let BestDist = CAMERA_HANDLE_HIT_RADIUS;
  for (let I = 0; I < Pts.length; I++) {
    const D = Math.hypot(Pts[I].x - Px, Pts[I].y - Py);
    if (D <= BestDist) { BestDist = D; Best = I; }
  }
  return Best;
}

// カメラ4隅(映像native比率)を、指定サイズの枠内の表示px(レターボックス考慮)へ変換する
function corner_frac_to_box_px(BoxW, BoxH, Video) {
  const Box = get_video_display_box(BoxW, BoxH, Video);
  return CameraCornerFractions.map((C) => ({
    x: Box.offX + C.fx * Box.dispW,
    y: Box.offY + C.fy * Box.dispH,
  }));
}

// 「カメラ4隅を合わせる」ボタンのトグル(編集モードの開始/確定)
function toggle_camera_calib() {
  if (CameraCalibEditing) {
    exit_camera_calib();
  } else {
    enter_camera_calib();
  }
}

function enter_camera_calib() {
  const Video = document.getElementById('cameraPreview');
  if (!Video.videoWidth) {
    show_camera_status('先に「カメラ開始」でカメラを起動してください');
    return;
  }
  CameraCalibEditing = true;
  CameraDragCorner = -1;
  // 未設定なら、四隅を合わせやすいよう内側に少し寄せた既定クアッドで初期化する
  if (!CameraCornerFractions) {
    CameraCornerFractions = [
      { fx: 0.1, fy: 0.1 }, // 左上
      { fx: 0.9, fy: 0.1 }, // 右上
      { fx: 0.9, fy: 0.9 }, // 右下
      { fx: 0.1, fy: 0.9 }, // 左下
    ];
  }
  document.getElementById('roiOverlayCanvas').classList.add('editing');
  document.getElementById('cameraCalibBtn').textContent = 'カメラ4隅を確定';
  show_camera_status('4隅ハンドルをホワイトボードの角にドラッグ → もう一度ボタンで確定');
  draw_camera_quad();
}

function exit_camera_calib() {
  CameraCalibEditing = false;
  CameraDragCorner = -1;
  document.getElementById('roiOverlayCanvas').classList.remove('editing');
  document.getElementById('cameraCalibBtn').textContent = 'カメラ4隅を合わせる';
  save_camera_corners();
  draw_camera_quad();
  show_camera_status('カメラ4隅を確定しました(検出時に長方形へ補正します)');
}

// カメラ補正を解除して映像全体を処理対象に戻す。
// 編集モード中に押された場合は4隅が無くなりドラッグ操作が無反応になるため、
// 編集モードのUI状態(ボタン文言・overlayのeditingクラス)もあわせて解除する。
function reset_camera_corners() {
  CameraCornerFractions = null;
  CameraDragCorner = -1;
  CameraCalibEditing = false;
  document.getElementById('roiOverlayCanvas').classList.remove('editing');
  document.getElementById('cameraCalibBtn').textContent = 'カメラ4隅を合わせる';
  try { localStorage.removeItem(CAMERA_CORNERS_STORAGE_KEY); } catch (E) { /* 無視 */ }
  draw_camera_quad();
  show_camera_status('カメラ補正を解除しました(次回は映像全体を処理します)');
}

function save_camera_corners() {
  try {
    if (CameraCornerFractions) {
      localStorage.setItem(CAMERA_CORNERS_STORAGE_KEY, JSON.stringify(CameraCornerFractions));
    } else {
      localStorage.removeItem(CAMERA_CORNERS_STORAGE_KEY);
    }
  } catch (E) { /* localStorage が使えない環境でも動作は続ける */ }
}

function load_camera_corners() {
  try {
    const Raw = localStorage.getItem(CAMERA_CORNERS_STORAGE_KEY);
    if (!Raw) return;
    const Arr = JSON.parse(Raw);
    if (Array.isArray(Arr) && Arr.length === 4 && Arr.every((C) => typeof C.fx === 'number' && typeof C.fy === 'number')) {
      CameraCornerFractions = Arr;
    }
  } catch (E) { /* 壊れた保存値は無視して未設定に戻す */ }
}

// マウス位置(画面座標)を、映像の実解像度に対する比率(0~1)に変換する
// video要素は object-fit:contain のため、レターボックス分のオフセットを考慮する
function client_point_to_video_fraction(ClientX, ClientY, Canvas, Video) {
  const Rect = Canvas.getBoundingClientRect();
  const Px = Math.max(0, Math.min(Rect.width, ClientX - Rect.left));
  const Py = Math.max(0, Math.min(Rect.height, ClientY - Rect.top));
  const Box = get_video_display_box(Rect.width, Rect.height, Video);

  return {
    fracX: Math.max(0, Math.min(1, (Px - Box.offX) / Box.dispW)),
    fracY: Math.max(0, Math.min(1, (Py - Box.offY) / Box.dispH)),
  };
}

// object-fit:contain によって video 要素の枠内に実際に描画される領域(レターボックス考慮)を求める
function get_video_display_box(BoxWidth, BoxHeight, Video) {
  const VideoAspect = Video.videoWidth / Video.videoHeight;
  const BoxAspect = BoxWidth / BoxHeight;

  let DispW, DispH, OffX, OffY;
  if (VideoAspect > BoxAspect) {
    DispW = BoxWidth;
    DispH = BoxWidth / VideoAspect;
    OffX = 0;
    OffY = (BoxHeight - DispH) / 2;
  } else {
    DispH = BoxHeight;
    DispW = BoxHeight * VideoAspect;
    OffY = 0;
    OffX = (BoxWidth - DispW) / 2;
  }

  return { dispW: DispW, dispH: DispH, offX: OffX, offY: OffY };
}

// カメラ4隅の四辺形をプレビュー上に描画する。
// 編集モードならハンドル付きで、そうでなければ設定済みの枠を薄く表示する。未設定なら何も描かない。
function draw_camera_quad() {
  const Canvas = document.getElementById('roiOverlayCanvas');
  const Ctx = Canvas.getContext('2d');
  Ctx.clearRect(0, 0, Canvas.width, Canvas.height);

  const Video = document.getElementById('cameraPreview');
  if (!CameraCornerFractions || !Video.videoWidth) return;

  const Pts = corner_frac_to_box_px(Canvas.width, Canvas.height, Video);

  // 四辺形の枠
  Ctx.strokeStyle = CameraCalibEditing ? '#3cf' : 'rgba(60,200,255,0.5)';
  Ctx.lineWidth = 2;
  Ctx.beginPath();
  Ctx.moveTo(Pts[0].x, Pts[0].y);
  for (let I = 1; I < Pts.length; I++) Ctx.lineTo(Pts[I].x, Pts[I].y);
  Ctx.closePath();
  Ctx.stroke();

  if (CameraCalibEditing) {
    draw_camera_handles(Ctx, Pts);
  }
}

// 編集モードで各隅に描くハンドル円とラベル
function draw_camera_handles(Ctx, Pts) {
  const Labels = ['左上', '右上', '右下', '左下'];
  Ctx.font = '11px sans-serif';
  for (let I = 0; I < Pts.length; I++) {
    Ctx.beginPath();
    Ctx.arc(Pts[I].x, Pts[I].y, 7, 0, Math.PI * 2);
    Ctx.fillStyle = 'rgba(255,80,80,0.85)';
    Ctx.fill();
    Ctx.lineWidth = 2;
    Ctx.strokeStyle = '#fff';
    Ctx.stroke();
    Ctx.fillStyle = '#fff';
    Ctx.fillText(Labels[I], Pts[I].x + 9, Pts[I].y - 9);
  }
}

// 4隅(video native比率)が退化した四辺形でないかを検証する:
// 隣接する隅同士が近すぎる、または囲む面積がほぼ0の場合はtrue。
function is_degenerate_quad(Corners) {
  const MIN_EDGE_FRACTION = 0.02; // 隣接2隅の最小距離(比率)
  for (let I = 0; I < 4; I++) {
    const A = Corners[I];
    const B = Corners[(I + 1) % 4];
    if (Math.hypot(A.fx - B.fx, A.fy - B.fy) < MIN_EDGE_FRACTION) return true;
  }
  // シューレース公式で面積を確認(自己交差や極端に潰れた四辺形を弾く)
  let Area = 0;
  for (let I = 0; I < 4; I++) {
    const A = Corners[I];
    const B = Corners[(I + 1) % 4];
    Area += A.fx * B.fy - B.fx * A.fy;
  }
  Area = Math.abs(Area) / 2;
  return Area < MIN_EDGE_FRACTION * MIN_EDGE_FRACTION;
}

// 指定4隅(video native比率 [tl,tr,br,bl])で囲まれた四辺形を、16:9固定の長方形へ
// 透視補正して返す。cv.getPerspectiveTransform + warpPerspective を使用。
// OpenCV Mat はGCされないため、単一のtry/finallyでまとめて解放する(CLAUDE.mdのメモリ規律)。
function warp_camera_to_rectangle(SrcCanvas, Corners) {
  const W = SrcCanvas.width;
  const H = SrcCanvas.height;

  // src点 = 入力canvas上のpx。dst点 = 出力長方形の四隅(左上→右上→右下→左下)。
  const SrcPts = [
    Corners[0].fx * W, Corners[0].fy * H,
    Corners[1].fx * W, Corners[1].fy * H,
    Corners[2].fx * W, Corners[2].fy * H,
    Corners[3].fx * W, Corners[3].fy * H,
  ];
  const DstPts = [
    0, 0,
    CAMERA_WARP_W, 0,
    CAMERA_WARP_W, CAMERA_WARP_H,
    0, CAMERA_WARP_H,
  ];

  let Src = null;
  let SrcTri = null;
  let DstTri = null;
  let M = null;
  let Warped = null;
  try {
    Src = cv.imread(SrcCanvas);
    SrcTri = cv.matFromArray(4, 1, cv.CV_32FC2, SrcPts);
    DstTri = cv.matFromArray(4, 1, cv.CV_32FC2, DstPts);
    M = cv.getPerspectiveTransform(SrcTri, DstTri);

    Warped = new cv.Mat();
    const Dsize = new cv.Size(CAMERA_WARP_W, CAMERA_WARP_H);
    cv.warpPerspective(Src, Warped, M, Dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

    const OutCanvas = document.createElement('canvas');
    OutCanvas.width = CAMERA_WARP_W;
    OutCanvas.height = CAMERA_WARP_H;
    cv.imshow(OutCanvas, Warped);
    return OutCanvas;
  } finally {
    if (Src) Src.delete();
    if (SrcTri) SrcTri.delete();
    if (DstTri) DstTri.delete();
    if (M) M.delete();
    if (Warped) Warped.delete();
  }
}
