// =====================================================================
// 【変換】マスク生成とモルフォロジー処理
// 入力画像(cv.Mat)から「黒い線の画素 = 白(255)」の二値マスクを作る。
// DOMは一切読み書きせず、パラメータは引数(Params)で受け取る(データ結合)。
// =====================================================================

// 黒ペン検出方式: HSVに変換し、彩度・明度が低い(黒に近い)範囲だけを抽出する
function build_black_pen_mask(Src, OutMask, Params) {
  const Rgb = new cv.Mat();
  cv.cvtColor(Src, Rgb, cv.COLOR_RGBA2RGB);

  const Hsv = new cv.Mat();
  cv.cvtColor(Rgb, Hsv, cv.COLOR_RGB2HSV);

  const Low = new cv.Mat(Hsv.rows, Hsv.cols, Hsv.type(), [0, 0, 0, 0]);
  const High = new cv.Mat(Hsv.rows, Hsv.cols, Hsv.type(), [180, Params.SatMax, Params.ValMax, 0]);
  cv.inRange(Hsv, Low, High, OutMask);

  Rgb.delete();
  Hsv.delete();
  Low.delete();
  High.delete();
}

// 従来方式: グレースケール化して適応的二値化(周囲の明るさに応じてしきい値を変える)
function build_adaptive_threshold_mask(Src, OutMask) {
  const Gray = new cv.Mat();
  cv.cvtColor(Src, Gray, cv.COLOR_RGBA2GRAY);
  // 黒い線を白(255)として残すため反転。blockSize/Cは照明ムラに強い値からスタート
  cv.adaptiveThreshold(Gray, OutMask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 51, 10);
  Gray.delete();
}

// モルフォロジー処理: 小さなゴミを除去(OPEN、細い線ごと消える場合はParamsでOFFにできる)
// →線を膨張(dilate)で太らせる→大きめのカーネルで途切れをつなぐ(CLOSE)。Maskを直接書き換える。
function apply_morphology(Mask, Params) {
  let SmallKernel = null;
  let CloseKernel = null;
  const Anchor = new cv.Point(-1, -1);

  try {
    SmallKernel = cv.Mat.ones(3, 3, cv.CV_8U);

    if (Params.UseMorphOpen) {
      cv.morphologyEx(Mask, Mask, cv.MORPH_OPEN, SmallKernel, Anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    }
    if (Params.DilateIterations > 0) {
      cv.dilate(Mask, Mask, SmallKernel, Anchor, Params.DilateIterations, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    }

    CloseKernel = cv.Mat.ones(Params.CloseKernelSize, Params.CloseKernelSize, cv.CV_8U);
    cv.morphologyEx(Mask, Mask, cv.MORPH_CLOSE, CloseKernel, Anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
  } finally {
    if (SmallKernel) SmallKernel.delete();
    if (CloseKernel) CloseKernel.delete();
  }
}
