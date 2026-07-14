// =====================================================================
// 【変換】線検出パイプライン(STSの中心変換)
// 最大抽象入力点 = 補正済みの入力画像(Img)と検出パラメータ(Params)。
// 最大抽象出力点 = キャンバス座標のポリゴン点列(Polygons)。
// DOM・matter.js・p5.js には一切触れない純変換。結果はすべて戻り値で渡す。
//
// 前回マスク(PreviousMask)だけはリアルタイム検出の差分スキップ判定のため
// このモジュールが所有し、clear_detection_memory() で外から初期化できる。
// =====================================================================

let PreviousMask = null;     // 前回地形へ反映したマスク(cv.Mat)。差分が小さければ再構築をスキップ
let MaskCanvasCache = null;  // マスク受け渡し用のオフスクリーンcanvas(毎回作らず使い回す)

// 検出パイプラインの統括。ノイズ低減→マスク生成→モルフォロジー→差分チェック→
// (変化があれば)輪郭抽出→ポリゴン化。
// 戻り値: { Polygons, AcceptedCount, DiffCount, ShouldUpdate, MaskCanvas }
//   ShouldUpdate が false のとき Polygons は null(地形の再構築は不要)。
// OpenCV Mat はGCされないため、let宣言+単一try/finallyでまとめて解放する(CLAUDE.mdのメモリ規律)。
function detect_polygons(Img, Params) {
  let Src = null;
  let Blurred = null;
  let Mask = null;
  let Contours = null;
  let Hierarchy = null;

  try {
    Src = cv.imread(Img);
    Blurred = new cv.Mat();
    cv.GaussianBlur(Src, Blurred, new cv.Size(5, 5), 0);

    Mask = new cv.Mat();
    if (Params.Method === 'hsv') {
      build_black_pen_mask(Blurred, Mask, Params);
    } else {
      build_adaptive_threshold_mask(Blurred, Mask);
    }
    apply_morphology(Mask, Params);

    const MaskCanvas = render_mask_to_canvas(Mask);

    // 前回(最後に地形へ反映した)マスクとの差分が小さければ、地形の再構築をスキップする
    const { ShouldUpdate, DiffCount } = evaluate_mask_change(Mask, Params.DiffThreshold);
    if (!ShouldUpdate) {
      return { Polygons: null, AcceptedCount: 0, DiffCount, ShouldUpdate, MaskCanvas };
    }

    // 今回のマスクを次回比較用に保存する(cloneして所有権を持つ)
    if (PreviousMask) PreviousMask.delete();
    PreviousMask = Mask.clone();

    Contours = new cv.MatVector();
    Hierarchy = new cv.Mat();
    cv.findContours(Mask, Contours, Hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const Polygons = extract_polygons(Contours, Params, Img.width, Img.height);
    return { Polygons, AcceptedCount: Polygons.length, DiffCount, ShouldUpdate, MaskCanvas };
  } finally {
    if (Src) Src.delete();
    if (Blurred) Blurred.delete();
    if (Mask) Mask.delete();
    if (Contours) Contours.delete();
    if (Hierarchy) Hierarchy.delete();
  }
}

// マスクをオフスクリーンcanvasへ描いて返す(表示は出力側 show_mask_preview の仕事)
function render_mask_to_canvas(Mask) {
  if (!MaskCanvasCache) {
    MaskCanvasCache = document.createElement('canvas');
  }
  MaskCanvasCache.width = Mask.cols;
  MaskCanvasCache.height = Mask.rows;
  cv.imshow(MaskCanvasCache, Mask);
  return MaskCanvasCache;
}

// 前回反映したマスクとの差分画素数を数え、しきい値未満なら更新不要と判断する
function evaluate_mask_change(Mask, DiffThreshold) {
  if (!PreviousMask || PreviousMask.rows !== Mask.rows || PreviousMask.cols !== Mask.cols) {
    // 初回、または補正変更等で解像度が変わった場合は無条件で更新する
    return { ShouldUpdate: true, DiffCount: null };
  }

  const Diff = new cv.Mat();
  try {
    cv.absdiff(Mask, PreviousMask, Diff);
    const DiffCount = cv.countNonZero(Diff);
    return { ShouldUpdate: DiffCount >= DiffThreshold, DiffCount };
  } finally {
    Diff.delete();
  }
}

// 前回マスクを破棄する(全消去時に呼ばれ、次回の検出を必ず更新させる)
function clear_detection_memory() {
  if (PreviousMask) {
    PreviousMask.delete();
    PreviousMask = null;
  }
}

// 画像をキャンバスの範囲(90%)に収まるよう縮小・中央寄せするための変換を求める
function compute_fit_transform(ImgW, ImgH) {
  const Scale = Math.min((CANVAS_W * 0.9) / ImgW, (CANVAS_H * 0.9) / ImgH);
  return {
    Scale,
    OffsetX: (CANVAS_W - ImgW * Scale) / 2,
    OffsetY: (CANVAS_H - ImgH * Scale) / 2,
  };
}

// 全輪郭を検査し、採用したものをキャンバス座標のポリゴン点列の配列にする
function extract_polygons(Contours, Params, ImgW, ImgH) {
  const Fit = compute_fit_transform(ImgW, ImgH);
  const Polygons = [];

  for (let I = 0; I < Contours.size(); I++) {
    const Contour = Contours.get(I);
    const Points = contour_to_points(Contour, Params, ImgW, ImgH, Fit);
    Contour.delete();
    if (Points) {
      Polygons.push(Points);
    }
  }
  return Polygons;
}

// 1つの輪郭を検査し、採用ならキャンバス座標の点列を返す。不採用なら null。
function contour_to_points(Contour, Params, ImgW, ImgH, Fit) {
  const ArcLen = cv.arcLength(Contour, true);
  const Area = cv.contourArea(Contour);

  // 平均化しても残る孤立した小断片を、長さと面積の両方でさらに足切りする
  if (ArcLen < Params.MinLength || Area < Params.MinArea || touches_image_edge(Contour, ImgW, ImgH)) {
    return null;
  }

  const Approx = new cv.Mat();
  try {
    cv.approxPolyDP(Contour, Approx, 0.01 * ArcLen, true);

    const Points = [];
    for (let R = 0; R < Approx.rows; R++) {
      Points.push({
        x: Approx.data32S[R * 2] * Fit.Scale + Fit.OffsetX,
        y: Approx.data32S[R * 2 + 1] * Fit.Scale + Fit.OffsetY,
      });
    }
    return Points.length >= 2 ? Points : null;
  } finally {
    Approx.delete();
  }
}

// 写真の縁に接している輪郭は縁の映り込みとみなして無視する
function touches_image_edge(Contour, ImgWidth, ImgHeight) {
  const Rect = cv.boundingRect(Contour);
  return (
    Rect.x <= EDGE_MARGIN ||
    Rect.y <= EDGE_MARGIN ||
    Rect.x + Rect.width >= ImgWidth - EDGE_MARGIN ||
    Rect.y + Rect.height >= ImgHeight - EDGE_MARGIN
  );
}
