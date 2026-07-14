// =====================================================================
// 【出力】ステータス表示(DOMラベル・マスクプレビュー)
// 検出結果やカメラ状態を画面のラベルへ書き込む処理をここへ集約する。
// 変換処理(transform_*)はDOMを触らず、結果を引数でここへ渡す(データ結合)。
// =====================================================================

function show_detection_count(Count) {
  document.getElementById('contourCountLabel').textContent = `検出輪郭数: ${Count}`;
}

// マスク差分の判定結果を表示する。DiffCount が null なら初回検出
function show_diff_status(DiffCount, ShouldUpdate) {
  const DiffText = DiffCount === null ? '初回' : `${DiffCount}画素`;
  document.getElementById('diffStatusLabel').textContent =
    `差分: ${DiffText} → ${ShouldUpdate ? '更新' : 'スキップ'}`;
}

function show_camera_status(Message) {
  document.getElementById('cameraStatus').textContent = Message;
}

// 変換側が作ったマスク画像(オフスクリーンcanvas)を右上のプレビューへ転写する
function show_mask_preview(MaskCanvas) {
  const Preview = document.getElementById('maskPreviewCanvas');
  Preview.width = MaskCanvas.width;
  Preview.height = MaskCanvas.height;
  Preview.getContext('2d').drawImage(MaskCanvas, 0, 0);
}
