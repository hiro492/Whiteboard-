// p5.js + matter.js の雛形
// マウスドラッグで線を自由に描き、その上をボールが転がる
// + OpenCV.js による画像からの線検出(黒ペン専用のHSVマスク方式 / 従来の適応的二値化方式)

const { Engine, World, Bodies } = Matter;

const CANVAS_W = 800;
const CANVAS_H = 600;
const LINE_THICKNESS = 8;             // 見た目の線の太さ
const LINE_COLLISION_THICKNESS = 18;  // 当たり判定用の太さ(見た目より太くして小さな隙間でも落ちにくくする)
const BALL_RADIUS = 16;
const MIN_SEGMENT_LEN = 4; // これより短い移動は線分を作らない
const EDGE_MARGIN = 2;     // 画像の縁とみなす余白(px)

let engine;
let world;

let handLines = [];  // マウスドラッグで描いた線(静的ボディ)
let imageLines = []; // 画像検出で生成した線(静的ボディ、スライダー操作のたびに作り直す)
let balls = [];       // 落としたボール

let isDrawing = false;
let lastPoint = null;

let contourDebugPaths = []; // 検出輪郭のデバッグ表示用点列(キャンバス座標系)
let lastLoadedImage = null; // スライダー変更時に同じ画像(またはキャプチャしたcanvas)で再検出するために保持
let reprocessScheduled = false;

const CAMERA_CAPTURE_WIDTH = 960; // カメラ映像は処理前にこの幅まで縮小して負荷を下げる
const AVERAGE_FRAME_COUNT = 4;    // センサーノイズの揺らぎを抑えるため平均化するフレーム数(3~5程度)

let currentCameraStream = null;
let previousMask = null; // 前回検出時のマスク(cv.Mat)。差分が小さければ地形の再構築をスキップする

let roiDragging = false;
let roiStartFrac = null;
let roiRectFraction = null; // {x0,y0,x1,y1}(video native解像度に対する0~1の比率)。null = ROI未指定(全体を処理)

let realtimeTimerId = null;       // setIntervalのID。null = 停止中
let isRealtimeProcessing = false; // 検出処理中に次のタイマーが多重実行されないようにするフラグ

let gameCanvasElement = null; // p5.jsのcanvas本体(フルスクリーン対象)
const FULLSCREEN_HIDDEN_ELEMENT_IDS = ['toolbar', 'cameraPreviewWrap', 'maskPreviewCanvas'];
let savedDisplayValues = {};
let hideExitBtnTimer = null;

function setup() {
  const cnv = createCanvas(CANVAS_W, CANVAS_H);
  gameCanvasElement = cnv.elt;

  engine = Engine.create();
  world = engine.world;

  document.getElementById('clearBtn').addEventListener('click', clearAll);
  setupFullscreen();
  setupCalibration();
  setupProjection();

  const imageInput = document.getElementById('imageInput');
  imageInput.addEventListener('change', onImageSelected);

  const methodSelect = document.getElementById('methodSelect');
  methodSelect.addEventListener('change', () => {
    updateHsvControlsVisibility();
    scheduleReprocess();
  });

  bindSlider('satMaxSlider', 'satMaxValue');
  bindSlider('valMaxSlider', 'valMaxValue');
  bindSlider('minLengthSlider', 'minLengthValue');
  bindSlider('minAreaSlider', 'minAreaValue');
  bindSlider('dilateIterSlider', 'dilateIterValue');
  bindSlider('closeKernelSlider', 'closeKernelValue');
  bindSlider('diffThresholdSlider', 'diffThresholdValue');

  updateHsvControlsVisibility();
  bindSourceModeRadios();

  document.getElementById('startCameraBtn').addEventListener('click', startCamera);
  document.getElementById('captureCameraBtn').addEventListener('click', captureCameraFrame);
  document.getElementById('clearRoiBtn').addEventListener('click', () => {
    roiRectFraction = null;
    drawRoiOverlay();
    document.getElementById('cameraStatus').textContent = 'ROIを解除しました(次回は全体を処理します)';
  });
  document.getElementById('morphOpenToggle').addEventListener('change', scheduleReprocess);
  setupRoiOverlay();
  refreshCameraList();

  document.getElementById('realtimeToggleBtn').addEventListener('click', toggleRealtime);
  document.getElementById('realtimeIntervalSlider').addEventListener('input', onRealtimeIntervalChanged);

  // 映像サイズが0x0のままなら映像が届いていないと判断できるデバッグ表示
  document.getElementById('cameraPreview').addEventListener('loadedmetadata', (event) => {
    const video = event.target;
    document.getElementById('cameraStatus').textContent =
      `映像サイズ: ${video.videoWidth}x${video.videoHeight}`;
    drawRoiOverlay(); // 映像サイズ確定後にROI枠(あれば)の位置を描き直す
  });

  // sketch.js の読み込みより先に opencv.js の初期化が終わっていた場合に備える
  if (window.cvReady) {
    enableImageUpload();
  }
}

// ゲームキャンバスだけをFullscreen APIで全画面表示する。
// resizeCanvasはせず、CSSで見た目だけ拡大するので物理演算の座標系はそのまま。
function setupFullscreen() {
  document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      gameCanvasElement.requestFullscreen().catch((err) => {
        console.error('フルスクリーンに切り替えられませんでした', err);
      });
    }
  });

  document.getElementById('fullscreenExitBtn').addEventListener('click', () => {
    document.exitFullscreen();
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  window.addEventListener('resize', () => {
    if (document.fullscreenElement === gameCanvasElement) {
      applyFullscreenCanvasScale();
    }
  });

  // フルスクリーン中、マウスを画面上部に近づけると「終了」ボタンを表示する
  document.addEventListener('mousemove', (event) => {
    if (document.fullscreenElement !== gameCanvasElement) return;

    const exitBtn = document.getElementById('fullscreenExitBtn');
    if (event.clientY < 60) {
      exitBtn.classList.add('visible');
      if (hideExitBtnTimer) {
        clearTimeout(hideExitBtnTimer);
        hideExitBtnTimer = null;
      }
    } else if (exitBtn.classList.contains('visible') && !hideExitBtnTimer) {
      hideExitBtnTimer = setTimeout(() => {
        exitBtn.classList.remove('visible');
        hideExitBtnTimer = null;
      }, 1000);
    }
  });
}

function onFullscreenChange() {
  const isFullscreen = document.fullscreenElement === gameCanvasElement;

  if (isFullscreen) {
    hideUiForFullscreen();
    applyFullscreenCanvasScale();
  } else {
    restoreUiAfterFullscreen();
    resetCanvasScale();
    document.getElementById('fullscreenExitBtn').classList.remove('visible');
  }
}

// キャンバスの内部解像度(座標系)は変えず、CSSの表示サイズだけを画面いっぱいに拡大する。
// プロカム調整で保存したキーストーン補正(ホモグラフィー)があればそれも適用する。
function applyFullscreenCanvasScale() {
  applyCanvasProjection();
}

function resetCanvasScale() {
  gameCanvasElement.style.width = '';
  gameCanvasElement.style.height = '';
  gameCanvasElement.style.position = '';
  gameCanvasElement.style.top = '';
  gameCanvasElement.style.left = '';
  gameCanvasElement.style.transform = '';
  gameCanvasElement.style.margin = '';
}

// フルスクリーン中はスライダー類やプレビューを隠す(元の表示状態を保存しておき、解除時に復元する)
function hideUiForFullscreen() {
  FULLSCREEN_HIDDEN_ELEMENT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    savedDisplayValues[id] = el.style.display;
    el.style.display = 'none';
  });
}

function restoreUiAfterFullscreen() {
  FULLSCREEN_HIDDEN_ELEMENT_IDS.forEach((id) => {
    const el = document.getElementById(id);
    el.style.display = savedDisplayValues[id] || '';
  });
}

function bindSourceModeRadios() {
  const radios = document.querySelectorAll('input[name="sourceMode"]');
  radios.forEach((radio) => radio.addEventListener('change', updateSourceModeVisibility));
  updateSourceModeVisibility();
}

function updateSourceModeVisibility() {
  const mode = document.querySelector('input[name="sourceMode"]:checked').value;
  document.getElementById('fileControls').style.display = mode === 'file' ? '' : 'none';
  document.getElementById('cameraControls').style.display = mode === 'camera' ? '' : 'none';
  if (mode !== 'camera') {
    stopRealtime(); // カメラから離れたらバックグラウンドでの自動更新は止める
  }
}

// カメラ一覧を取得してセレクトボックスに反映する(権限付与後はラベルも取得できる)
async function refreshCameraList() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoInputs = devices.filter((d) => d.kind === 'videoinput');

  const select = document.getElementById('cameraSelect');
  const previousValue = select.value;
  select.innerHTML = '';
  videoInputs.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `カメラ ${index + 1}`;
    select.appendChild(option);
  });
  if (previousValue && videoInputs.some((d) => d.deviceId === previousValue)) {
    select.value = previousValue;
  }
}

async function startCamera() {
  const status = document.getElementById('cameraStatus');
  const deviceId = document.getElementById('cameraSelect').value;

  if (currentCameraStream) {
    currentCameraStream.getTracks().forEach((track) => track.stop());
  }

  try {
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    };
    currentCameraStream = await navigator.mediaDevices.getUserMedia(constraints);

    const video = document.getElementById('cameraPreview');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = currentCameraStream;
    // 非表示になっているのは video 自身ではなく親の #cameraPreviewWrap 側なので、そちらを表示する
    document.getElementById('cameraPreviewWrap').style.display = 'block';
    await video.play();

    document.getElementById('captureCameraBtn').disabled = false;
    document.getElementById('realtimeToggleBtn').disabled = false;
    status.textContent = 'カメラ映像を取得中です';

    await refreshCameraList(); // 権限付与後はラベル付きで一覧を取り直す
  } catch (err) {
    status.textContent = `カメラを開始できませんでした: ${err.message}`;
  }
}

// 複数フレームを平均化してキャプチャし(センサーノイズの揺らぎを抑える)、
// ROI指定があればその範囲だけ切り出して検出パイプラインに渡す
async function captureCameraFrame() {
  const video = document.getElementById('cameraPreview');
  if (!currentCameraStream || !video.videoWidth) return;

  const scale = CAMERA_CAPTURE_WIDTH / video.videoWidth;
  const targetHeight = Math.round(video.videoHeight * scale);

  const fullCanvas = await captureAveragedFrame(video, CAMERA_CAPTURE_WIDTH, targetHeight);

  let processedCanvas = fullCanvas;
  const roiActive = !!roiRectFraction;

  if (roiActive) {
    const sx = Math.round(roiRectFraction.x0 * CAMERA_CAPTURE_WIDTH);
    const sy = Math.round(roiRectFraction.y0 * targetHeight);
    const sw = Math.max(1, Math.round((roiRectFraction.x1 - roiRectFraction.x0) * CAMERA_CAPTURE_WIDTH));
    const sh = Math.max(1, Math.round((roiRectFraction.y1 - roiRectFraction.y0) * targetHeight));

    const roiCanvas = document.createElement('canvas');
    roiCanvas.width = sw;
    roiCanvas.height = sh;
    roiCanvas.getContext('2d').drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    processedCanvas = roiCanvas;
  }

  document.getElementById('cameraStatus').textContent =
    `ROI: ${roiActive ? '有効' : '無効'} / 処理解像度: ${processedCanvas.width}x${processedCanvas.height} / ${AVERAGE_FRAME_COUNT}フレーム平均`;

  lastLoadedImage = processedCanvas;
  detectLinesFromImage(processedCanvas);
}

// 連続数フレームをキャプチャし、cv.addWeightedによる累積平均でセンサーノイズを平滑化する
async function captureAveragedFrame(video, targetWidth, targetHeight) {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = targetWidth;
  tempCanvas.height = targetHeight;
  const tempCtx = tempCanvas.getContext('2d');

  let avg = null; // cv.Mat(CV_32F)。フレームを重ねるごとに累積平均を更新する

  try {
    for (let i = 0; i < AVERAGE_FRAME_COUNT; i++) {
      tempCtx.drawImage(video, 0, 0, targetWidth, targetHeight);

      const frame = cv.imread(tempCanvas);
      const frameFloat = new cv.Mat();
      frame.convertTo(frameFloat, cv.CV_32F);
      frame.delete();

      if (avg === null) {
        avg = frameFloat;
      } else {
        // 累積平均の更新式: avg = avg*(i/(i+1)) + frame*(1/(i+1))
        cv.addWeighted(avg, i / (i + 1), frameFloat, 1 / (i + 1), 0, avg);
        frameFloat.delete();
      }

      if (i < AVERAGE_FRAME_COUNT - 1) {
        await waitForNextVideoFrame(video);
      }
    }

    const averaged8u = new cv.Mat();
    avg.convertTo(averaged8u, cv.CV_8U);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = targetWidth;
    outCanvas.height = targetHeight;
    cv.imshow(outCanvas, averaged8u);
    averaged8u.delete();

    return outCanvas;
  } finally {
    if (avg) avg.delete();
  }
}

// 実際に新しい映像フレームが描画されるまで待つ(対応ブラウザではrequestVideoFrameCallbackを使用)
function waitForNextVideoFrame(video) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => resolve());
    } else {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }
  });
}

function toggleRealtime() {
  if (realtimeTimerId) {
    stopRealtime();
  } else {
    startRealtime();
  }
}

function startRealtime() {
  if (realtimeTimerId || !currentCameraStream) return;

  const intervalMs = Number(document.getElementById('realtimeIntervalSlider').value) * 1000;
  realtimeTimerId = setInterval(runRealtimeTick, intervalMs);
  updateRealtimeUi();
  runRealtimeTick(); // 開始した瞬間にも1回実行する
}

function stopRealtime() {
  if (realtimeTimerId) {
    clearInterval(realtimeTimerId);
    realtimeTimerId = null;
  }
  updateRealtimeUi();
}

// スライダーで間隔を変えたら、動作中なら新しい間隔でタイマーを張り直す
function onRealtimeIntervalChanged() {
  const seconds = Number(document.getElementById('realtimeIntervalSlider').value);
  document.getElementById('realtimeIntervalValue').textContent = seconds.toFixed(1);

  if (realtimeTimerId) {
    clearInterval(realtimeTimerId);
    realtimeTimerId = setInterval(runRealtimeTick, seconds * 1000);
  }
}

// 検出処理中に次のタイマーが発火しても多重実行しない
async function runRealtimeTick() {
  if (isRealtimeProcessing) return;
  isRealtimeProcessing = true;
  try {
    await captureCameraFrame();
  } finally {
    isRealtimeProcessing = false;
  }
  updateRealtimeUi();
}

function updateRealtimeUi() {
  const btn = document.getElementById('realtimeToggleBtn');
  const seconds = Number(document.getElementById('realtimeIntervalSlider').value);
  const active = !!realtimeTimerId;

  btn.textContent = active ? 'リアルタイム停止' : 'リアルタイム開始';
  btn.classList.toggle('active', active);

  const lastRun = active ? `(最終検出: ${new Date().toLocaleTimeString()})` : '';
  document.getElementById('realtimeStatus').textContent =
    `リアルタイム: ${active ? `動作中(間隔${seconds}秒)` : '停止中'} ${lastRun}`;
}

// カメラプレビュー上のドラッグでROI(検出範囲)を指定する
function setupRoiOverlay() {
  const canvas = document.getElementById('roiOverlayCanvas');

  canvas.addEventListener('mousedown', (event) => {
    const video = document.getElementById('cameraPreview');
    if (!video.videoWidth) return;

    const frac = clientPointToVideoFraction(event.clientX, event.clientY, canvas, video);
    roiDragging = true;
    roiStartFrac = frac;
    roiRectFraction = { x0: frac.fracX, y0: frac.fracY, x1: frac.fracX, y1: frac.fracY };
    drawRoiOverlay();
  });

  canvas.addEventListener('mousemove', (event) => {
    if (!roiDragging) return;
    const video = document.getElementById('cameraPreview');
    const frac = clientPointToVideoFraction(event.clientX, event.clientY, canvas, video);
    roiRectFraction = normalizeRoiRect(roiStartFrac, frac);
    drawRoiOverlay();
  });

  window.addEventListener('mouseup', () => {
    if (!roiDragging) return;
    roiDragging = false;
    // ほぼ動かさずにクリックしただけの場合はROI指定なし扱いにする
    if (
      roiRectFraction &&
      (roiRectFraction.x1 - roiRectFraction.x0 < 0.02 || roiRectFraction.y1 - roiRectFraction.y0 < 0.02)
    ) {
      roiRectFraction = null;
    }
    drawRoiOverlay();
  });
}

// マウス位置(画面座標)を、映像の実解像度に対する比率(0~1)に変換する
// video要素は object-fit:contain のため、レターボックス分のオフセットを考慮する
function clientPointToVideoFraction(clientX, clientY, canvas, video) {
  const rect = canvas.getBoundingClientRect();
  const px = constrain(clientX - rect.left, 0, rect.width);
  const py = constrain(clientY - rect.top, 0, rect.height);
  const box = getVideoDisplayBox(rect.width, rect.height, video);

  return {
    fracX: constrain((px - box.offX) / box.dispW, 0, 1),
    fracY: constrain((py - box.offY) / box.dispH, 0, 1),
  };
}

// object-fit:contain によって video 要素の枠内に実際に描画される領域(レターボックス考慮)を求める
function getVideoDisplayBox(boxWidth, boxHeight, video) {
  const videoAspect = video.videoWidth / video.videoHeight;
  const boxAspect = boxWidth / boxHeight;

  let dispW, dispH, offX, offY;
  if (videoAspect > boxAspect) {
    dispW = boxWidth;
    dispH = boxWidth / videoAspect;
    offX = 0;
    offY = (boxHeight - dispH) / 2;
  } else {
    dispH = boxHeight;
    dispW = boxHeight * videoAspect;
    offY = 0;
    offX = (boxWidth - dispW) / 2;
  }

  return { dispW, dispH, offX, offY };
}

function normalizeRoiRect(a, b) {
  return {
    x0: Math.min(a.fracX, b.fracX),
    y0: Math.min(a.fracY, b.fracY),
    x1: Math.max(a.fracX, b.fracX),
    y1: Math.max(a.fracY, b.fracY),
  };
}

function drawRoiOverlay() {
  const canvas = document.getElementById('roiOverlayCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const video = document.getElementById('cameraPreview');
  if (!roiRectFraction || !video.videoWidth) return;

  const box = getVideoDisplayBox(canvas.width, canvas.height, video);
  const x0 = box.offX + roiRectFraction.x0 * box.dispW;
  const y0 = box.offY + roiRectFraction.y0 * box.dispH;
  const x1 = box.offX + roiRectFraction.x1 * box.dispW;
  const y1 = box.offY + roiRectFraction.y1 * box.dispH;

  ctx.strokeStyle = 'red';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

// スライダーを動かすたびに数値表示を更新し、リアルタイムに再検出する
function bindSlider(sliderId, valueLabelId) {
  const slider = document.getElementById(sliderId);
  const valueLabel = document.getElementById(valueLabelId);
  slider.addEventListener('input', () => {
    valueLabel.textContent = slider.value;
    scheduleReprocess();
  });
}

function updateHsvControlsVisibility() {
  const method = document.getElementById('methodSelect').value;
  document.getElementById('hsvControls').style.display = method === 'hsv' ? '' : 'none';
}

// index.html のインラインスクリプトから呼ばれる(opencv.js 初期化完了時)
window.handleCvReady = enableImageUpload;

function enableImageUpload() {
  document.getElementById('imageInput').disabled = false;
  document.getElementById('imageLabel').classList.remove('disabled');
  document.getElementById('cvStatus').textContent = '画像をアップロードできます';
}

function draw() {
  Engine.update(engine);

  background(30);

  drawLines(handLines);
  drawLines(imageLines);
  drawBalls();
  drawContourDebug();

  // 画面外に落ちたボールは削除してメモリを圧迫しないようにする
  balls = balls.filter((body) => {
    if (body.position.y > CANVAS_H + 300) {
      World.remove(world, body);
      return false;
    }
    return true;
  });
}

function isInsideCanvas(x, y) {
  return x >= 0 && x <= width && y >= 0 && y <= height;
}

function mousePressed() {
  if (!isInsideCanvas(mouseX, mouseY)) return;
  isDrawing = true;
  lastPoint = { x: mouseX, y: mouseY };
}

function mouseDragged() {
  if (!isDrawing || !lastPoint) return;

  const current = { x: mouseX, y: mouseY };
  if (dist(lastPoint.x, lastPoint.y, current.x, current.y) < MIN_SEGMENT_LEN) return;

  addLineSegment(lastPoint, current, handLines);
  lastPoint = current;
}

function mouseReleased() {
  isDrawing = false;
  lastPoint = null;
}

function keyPressed() {
  if (key === ' ') {
    dropBall(mouseX, mouseY);
  }
}

function addLineSegment(p1, p2, targetList) {
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const length = dist(p1.x, p1.y, p2.x, p2.y);
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);

  // 当たり判定は見た目より太くする(renderLengthは見た目の描画で使う)
  const segment = Bodies.rectangle(midX, midY, length, LINE_COLLISION_THICKNESS, {
    isStatic: true,
    friction: 0.05,
    angle,
  });
  segment.renderLength = length;

  World.add(world, segment);
  targetList.push(segment);
}

function dropBall(x, y) {
  const clampedX = constrain(x, 0, width);
  const clampedY = constrain(y, 0, height);

  const ball = Bodies.circle(clampedX, clampedY, BALL_RADIUS, {
    restitution: 0.3,
    friction: 0.02,
    frictionAir: 0.0005,
  });

  World.add(world, ball);
  balls.push(ball);
}

function clearAll() {
  World.remove(world, handLines);
  World.remove(world, imageLines);
  World.remove(world, balls);
  handLines = [];
  imageLines = [];
  balls = [];
  contourDebugPaths = [];

  if (previousMask) {
    previousMask.delete();
    previousMask = null; // クリア後は次回の検出を必ず更新させる
  }
}

// 画像検出結果だけを消す(手描き線は残したまま、スライダー変更時の再検出前に呼ぶ)
function clearImageLines() {
  World.remove(world, imageLines);
  imageLines = [];
  contourDebugPaths = [];
}

function drawLines(bodies) {
  noStroke();
  fill(200);
  for (const body of bodies) {
    drawLineBody(body);
  }
}

// 当たり判定(body本体)より細い見た目(LINE_THICKNESS)で描画する
function drawLineBody(body) {
  push();
  translate(body.position.x, body.position.y);
  rotate(body.angle);
  rectMode(CENTER);
  rect(0, 0, body.renderLength, LINE_THICKNESS);
  pop();
}

function drawContourDebug() {
  noFill();
  stroke(0, 255, 0);
  strokeWeight(2);
  for (const points of contourDebugPaths) {
    beginShape();
    for (const p of points) {
      vertex(p.x, p.y);
    }
    endShape(CLOSE);
  }
  noStroke();
}

// 画像が選択されたら読み込んで OpenCV で線検出する
function onImageSelected(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // 同じファイルを連続で選んでも change が発火するようにする
  if (!file || !window.cvReady) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      lastLoadedImage = img;
      detectLinesFromImage(img);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// スライダー/検出方式の変更時に、同じ画像で再検出する(連続操作でも1フレームにまとめる)
function scheduleReprocess() {
  if (!lastLoadedImage || !window.cvReady || reprocessScheduled) return;
  reprocessScheduled = true;
  requestAnimationFrame(() => {
    reprocessScheduled = false;
    detectLinesFromImage(lastLoadedImage);
  });
}

// ノイズ低減→(HSVマスク or 適応的二値化)→モルフォロジー処理→前回との差分チェック→
// (変化があれば)輪郭抽出→折れ線化→matter.jsの静的当たり判定へ変換
function detectLinesFromImage(img) {
  const method = document.getElementById('methodSelect').value;

  // リアルタイム実行で繰り返し呼ばれるため、途中で例外が起きても
  // 生成済みのMatを確実にdelete()できるようtry/finallyでまとめて管理する
  let src = null;
  let blurred = null;
  let mask = null;
  let smallKernel = null;
  let closeKernel = null;
  let contours = null;
  let hierarchy = null;

  try {
    src = cv.imread(img);
    blurred = new cv.Mat();
    cv.GaussianBlur(src, blurred, new cv.Size(5, 5), 0);

    mask = new cv.Mat();

    if (method === 'hsv') {
      buildBlackPenMask(blurred, mask);
    } else {
      buildAdaptiveThresholdMask(blurred, mask);
    }

    // モルフォロジー処理: 小さなゴミを除去(OPEN、細い線ごと消える場合はチェックを外してOFFにできる)
    // →線を膨張(dilate)で太らせる→大きめのカーネルで途切れをつなぐ(CLOSE)
    smallKernel = cv.Mat.ones(3, 3, cv.CV_8U);
    const anchor = new cv.Point(-1, -1);

    if (document.getElementById('morphOpenToggle').checked) {
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, smallKernel, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    }

    const dilateIterations = Number(document.getElementById('dilateIterSlider').value);
    if (dilateIterations > 0) {
      cv.dilate(mask, mask, smallKernel, anchor, dilateIterations, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    }

    const closeKernelSize = Number(document.getElementById('closeKernelSlider').value);
    closeKernel = cv.Mat.ones(closeKernelSize, closeKernelSize, cv.CV_8U);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    cv.imshow('maskPreviewCanvas', mask);

    // 前回(最後に地形へ反映した)マスクとの差分が小さければ、地形の再構築をスキップする
    const { shouldUpdate, diffCount } = evaluateMaskChange(mask);
    updateDiffStatus(diffCount, shouldUpdate);
    if (!shouldUpdate) {
      return;
    }

    // 今回のマスクを次回比較用に保存する(cloneして所有権を持つ)
    if (previousMask) previousMask.delete();
    previousMask = mask.clone();

    clearImageLines(); // 前回の検出結果を消す(手描き線は残す)

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const minLength = Number(document.getElementById('minLengthSlider').value);
    const minArea = Number(document.getElementById('minAreaSlider').value);

    // 画像をキャンバスの範囲に収まるよう縮小・中央寄せするための変換
    const scale = Math.min((width * 0.9) / img.width, (height * 0.9) / img.height);
    const offsetX = (width - img.width * scale) / 2;
    const offsetY = (height - img.height * scale) / 2;

    let acceptedCount = 0;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const arcLen = cv.arcLength(contour, true);
      const area = cv.contourArea(contour);

      // 平均化しても残る孤立した小断片を、長さと面積の両方でさらに足切りする
      if (arcLen < minLength || area < minArea || touchesImageEdge(contour, img.width, img.height)) {
        contour.delete();
        continue;
      }

      const approx = new cv.Mat();
      const epsilon = 0.01 * arcLen;
      cv.approxPolyDP(contour, approx, epsilon, true);

      const points = [];
      for (let r = 0; r < approx.rows; r++) {
        points.push({
          x: approx.data32S[r * 2] * scale + offsetX,
          y: approx.data32S[r * 2 + 1] * scale + offsetY,
        });
      }

      if (points.length >= 2) {
        contourDebugPaths.push(points);
        for (let p = 0; p < points.length; p++) {
          addLineSegment(points[p], points[(p + 1) % points.length], imageLines);
        }
        acceptedCount++;
      }

      contour.delete();
      approx.delete();
    }

    document.getElementById('contourCountLabel').textContent = `検出輪郭数: ${acceptedCount}`;
  } finally {
    if (src) src.delete();
    if (blurred) blurred.delete();
    if (mask) mask.delete();
    if (smallKernel) smallKernel.delete();
    if (closeKernel) closeKernel.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
  }
}

// 前回反映したマスクとの差分画素数を数え、しきい値未満なら更新不要と判断する
function evaluateMaskChange(mask) {
  if (!previousMask || previousMask.rows !== mask.rows || previousMask.cols !== mask.cols) {
    // 初回、またはROI変更等で解像度が変わった場合は無条件で更新する
    return { shouldUpdate: true, diffCount: null };
  }

  const diff = new cv.Mat();
  try {
    cv.absdiff(mask, previousMask, diff);
    const diffCount = cv.countNonZero(diff);
    const threshold = Number(document.getElementById('diffThresholdSlider').value);
    return { shouldUpdate: diffCount >= threshold, diffCount };
  } finally {
    diff.delete();
  }
}

function updateDiffStatus(diffCount, shouldUpdate) {
  const diffText = diffCount === null ? '初回' : `${diffCount}画素`;
  document.getElementById('diffStatusLabel').textContent =
    `差分: ${diffText} → ${shouldUpdate ? '更新' : 'スキップ'}`;
}

// 黒ペン検出方式: HSVに変換し、彩度・明度が低い(黒に近い)範囲だけを抽出する
function buildBlackPenMask(src, outMask) {
  const rgb = new cv.Mat();
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);

  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

  const satMax = Number(document.getElementById('satMaxSlider').value);
  const valMax = Number(document.getElementById('valMaxSlider').value);

  const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, 0, 0]);
  const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, satMax, valMax, 0]);
  cv.inRange(hsv, low, high, outMask);

  rgb.delete();
  hsv.delete();
  low.delete();
  high.delete();
}

// 従来方式: グレースケール化して適応的二値化(周囲の明るさに応じてしきい値を変える)
function buildAdaptiveThresholdMask(src, outMask) {
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  // 黒い線を白(255)として残すため反転。blockSize/Cは照明ムラに強い値からスタート
  cv.adaptiveThreshold(gray, outMask, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 51, 10);
  gray.delete();
}

// 写真の縁に接している輪郭は縁の映り込みとみなして無視する
function touchesImageEdge(contour, imgWidth, imgHeight) {
  const rect = cv.boundingRect(contour);
  return (
    rect.x <= EDGE_MARGIN ||
    rect.y <= EDGE_MARGIN ||
    rect.x + rect.width >= imgWidth - EDGE_MARGIN ||
    rect.y + rect.height >= imgHeight - EDGE_MARGIN
  );
}

function drawBalls() {
  for (const body of balls) {
    const { x, y } = body.position;
    push();
    translate(x, y);
    rotate(body.angle);
    noStroke();
    fill(255, 100, 80);
    circle(0, 0, BALL_RADIUS * 2);
    stroke(255);
    line(0, 0, BALL_RADIUS, 0); // 回転が見えるように印を付ける
    pop();
  }
}

// =====================================================================
// プロカム(プロジェクタ)調整 = キーストーン(台形)補正
//
// 斜め45度など、投影面に対して斜めからプロジェクタを当てると、投影像は
// 台形にゆがむ。これを「正面から投影したように」戻すには、ゲーム画面の
// 長方形(4隅)を、投影面の実際の4隅へ写す射影変換(ホモグラフィー)を
// 掛ければよい。物理演算・描画の座標系(800x600)は一切変えず、キャンバス
// 要素に CSS transform: matrix3d(...) を掛けて「見た目」だけを歪ませる。
//
// 手順:
//   1) 元の長方形の4隅(src)と、四隅ドラッグで合わせた4隅(dst)を用意
//   2) src -> dst を満たす 3x3 ホモグラフィー行列 H を解く
//      (2つの基底行列の積 H = D * adj(S) で求める標準解法)
//   3) H を CSS matrix3d(列優先の4x4)へ並べ替えてキャンバスに適用
// =====================================================================

const PROJCAM_STORAGE_KEY = 'projcam_corners_v1';
const CALIB_HIDDEN_IDS = ['toolbar', 'cameraPreviewWrap', 'maskPreviewCanvas'];

// 4隅の位置は、ウィンドウサイズが変わっても比率で復元できるよう
// ビューポートに対する割合 {fx, fy}(0~1)で保持する。null = 未調整(既定の長方形)。
let projectorCornerFractions = null;
let calibrationActive = false;
let handlesVisible = true;
let savedCalibDisplays = {};
let calibrationDirty = false; // 保存(localStorage)していない変更があるか

function setupCalibration() {
  loadSavedCorners();
  document.getElementById('calibrateBtn').addEventListener('click', enterCalibration);
  document.getElementById('calibExitBtn').addEventListener('click', exitCalibration);
  document.getElementById('calibResetBtn').addEventListener('click', resetCorners);
  document.getElementById('calibSaveBtn').addEventListener('click', saveCalibration);
  document.getElementById('calibToggleHandlesBtn').addEventListener('click', toggleHandles);
  document.getElementById('autoCalibrateBtn').addEventListener('click', autoCalibrate);
  setupHandleDragging();

  window.addEventListener('resize', () => {
    if (calibrationActive) {
      applyCanvasProjection();
      positionHandles();
    }
  });
}

// --- 調整モードの開始/終了 -------------------------------------------

function enterCalibration() {
  // オーバーレイのハンドルはフルスクリーン要素の外側にあり、Fullscreen API 中は
  // 隠れてしまうため、いったんフルスクリーンを抜けてから通常のウィンドウ全面で調整する
  if (document.fullscreenElement) {
    document.exitFullscreen();
  }

  calibrationActive = true;
  handlesVisible = true;
  setCalibHiddenUi(true);
  document.getElementById('calibOverlay').classList.add('active');
  document.getElementById('calibToggleHandlesBtn').textContent = 'ハンドルを隠す';

  applyCanvasProjection();
  updateHandlesVisibility();
  positionHandles();
  updateCalibStatus();
}

function exitCalibration() {
  calibrationActive = false;
  document.getElementById('calibOverlay').classList.remove('active');
  setCalibHiddenUi(false);

  // 通常表示に戻す(保存した4隅は残るので、次回のフルスクリーン/調整で再適用される)
  resetCanvasScale();
  gameCanvasElement.style.transform = '';
  gameCanvasElement.style.transformOrigin = '';
}

function toggleHandles() {
  handlesVisible = !handlesVisible;
  document.getElementById('calibToggleHandlesBtn').textContent =
    handlesVisible ? 'ハンドルを隠す' : 'ハンドルを表示';
  updateHandlesVisibility();
}

// 四隅を既定(ゆがみなし)に戻す。localStorageへの保存は「保存」ボタンを押すまで行わない。
function resetCorners() {
  projectorCornerFractions = null;
  calibrationDirty = true;
  applyCanvasProjection();
  positionHandles();
  updateCalibStatus();
}

// 現在の四隅をlocalStorageへ明示保存する(単一スロット)
function saveCalibration() {
  saveCorners();
  calibrationDirty = false;
  updateCalibStatus('保存しました');
}

// 保存状態のラベルを更新する。messageを渡すと一時的にその文言を出す。
// colorを渡すとその色で表示する(自動調整の進捗・エラー表示に使用)。
function updateCalibStatus(message, color) {
  const el = document.getElementById('calibStatus');
  if (!el) return;
  if (message) {
    el.textContent = message;
    el.style.color = color || '#8f8';
  } else if (calibrationDirty) {
    el.textContent = '未保存の変更あり';
    el.style.color = '#fc8';
  } else {
    el.textContent = projectorCornerFractions ? '保存済み' : '未調整';
    el.style.color = '#aaa';
  }
}

// 調整中は編集用UI・プレビュー類を隠し、終了時に元の表示状態へ戻す
function setCalibHiddenUi(hide) {
  CALIB_HIDDEN_IDS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (hide) {
      savedCalibDisplays[id] = el.style.display;
      el.style.display = 'none';
    } else {
      el.style.display = savedCalibDisplays[id] || '';
    }
  });
}

// --- 4隅ハンドルの表示・ドラッグ -------------------------------------

function updateHandlesVisibility() {
  document.querySelectorAll('.calib-handle').forEach((h) => {
    h.style.display = handlesVisible ? 'block' : 'none';
  });
}

function positionHandles() {
  const px = cornerFractionsToPx(currentCornerFractions());
  document.querySelectorAll('.calib-handle').forEach((h) => {
    const i = Number(h.dataset.corner);
    h.style.left = `${px[i].x}px`;
    h.style.top = `${px[i].y}px`;
  });
}

function setupHandleDragging() {
  document.querySelectorAll('.calib-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const i = Number(handle.dataset.corner);
      handle.setPointerCapture(event.pointerId);

      const onMove = (ev) => {
        const x = Math.max(0, Math.min(window.innerWidth, ev.clientX));
        const y = Math.max(0, Math.min(window.innerHeight, ev.clientY));
        setCornerFraction(i, x / window.innerWidth, y / window.innerHeight);
        applyCanvasProjection();
        positionHandles();
      };
      const onUp = () => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        calibrationDirty = true; // 保存は明示ボタンに任せる(自動保存しない)
        updateCalibStatus();
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });
}

// 1隅だけ動かすときも、他の3隅は現在値(未調整なら既定)から引き継ぐ
function setCornerFraction(i, fx, fy) {
  if (!projectorCornerFractions) {
    projectorCornerFractions = currentCornerFractions().map((c) => ({ fx: c.fx, fy: c.fy }));
  }
  projectorCornerFractions[i] = { fx, fy };
}

// --- 4隅の座標(割合↔ピクセル)と保存 -------------------------------

function currentCornerFractions() {
  return projectorCornerFractions ? projectorCornerFractions : defaultCornerFractions();
}

// 既定の4隅 = 画面中央に、アスペクト比を保って最大化した長方形(=ゆがみなし)
function defaultCornerFractions() {
  const scale = Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H);
  const dispW = CANVAS_W * scale;
  const dispH = CANVAS_H * scale;
  const ox = (window.innerWidth - dispW) / 2;
  const oy = (window.innerHeight - dispH) / 2;
  const iw = window.innerWidth;
  const ih = window.innerHeight;
  return [
    { fx: ox / iw, fy: oy / ih },                    // 0: 左上
    { fx: (ox + dispW) / iw, fy: oy / ih },          // 1: 右上
    { fx: (ox + dispW) / iw, fy: (oy + dispH) / ih },// 2: 右下
    { fx: ox / iw, fy: (oy + dispH) / ih },          // 3: 左下
  ];
}

function cornerFractionsToPx(fr) {
  const iw = window.innerWidth;
  const ih = window.innerHeight;
  return fr.map((c) => ({ x: c.fx * iw, y: c.fy * ih }));
}

function saveCorners() {
  try {
    if (projectorCornerFractions) {
      localStorage.setItem(PROJCAM_STORAGE_KEY, JSON.stringify(projectorCornerFractions));
    } else {
      localStorage.removeItem(PROJCAM_STORAGE_KEY);
    }
  } catch (e) {
    /* localStorage が使えない環境でも動作は続ける */
  }
}

function loadSavedCorners() {
  try {
    const raw = localStorage.getItem(PROJCAM_STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length === 4 && arr.every((c) => typeof c.fx === 'number' && typeof c.fy === 'number')) {
      projectorCornerFractions = arr;
    }
  } catch (e) {
    /* 壊れた保存値は無視して既定に戻す */
  }
}

// --- キャンバスへの適用 ----------------------------------------------

// キャンバスをビューポート左上基準に配置し、元の長方形(src)を調整後の4隅(dst)へ
// 写すホモグラフィーを CSS transform として適用する。フルスクリーン時・調整時の両方から呼ばれる。
function applyCanvasProjection() {
  const scale = Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H);
  const dispW = CANVAS_W * scale;
  const dispH = CANVAS_H * scale;

  // src はキャンバス要素のローカル座標(左上原点)での長方形の4隅
  const src = [
    { x: 0, y: 0 },
    { x: dispW, y: 0 },
    { x: dispW, y: dispH },
    { x: 0, y: dispH },
  ];
  const dst = cornerFractionsToPx(currentCornerFractions());

  gameCanvasElement.style.position = 'fixed';
  gameCanvasElement.style.left = '0';
  gameCanvasElement.style.top = '0';
  gameCanvasElement.style.width = `${dispW}px`;
  gameCanvasElement.style.height = `${dispH}px`;
  gameCanvasElement.style.margin = '0';
  gameCanvasElement.style.transformOrigin = '0 0';
  gameCanvasElement.style.transform = homographyToCssMatrix3d(src, dst);
}

// --- ホモグラフィー(射影変換)の計算 --------------------------------

// 3x3 行列(長さ9の配列, 行優先)の余因子行列(adjugate)
function adj3(m) {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}

// 3x3 行列同士の積
function mul3x3(a, b) {
  const c = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[3 * i + k] * b[3 * k + j];
      c[3 * i + j] = s;
    }
  }
  return c;
}

// 3x3 行列 × 3次元ベクトル
function mul3v(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

// 「単位基底(3点)→与えられた4点」へ写す行列。4隅からホモグラフィーを組み立てる部品。
function basisToPoints(p) {
  const m = [
    p[0].x, p[1].x, p[2].x,
    p[0].y, p[1].y, p[2].y,
    1, 1, 1,
  ];
  const v = mul3v(adj3(m), [p[3].x, p[3].y, 1]);
  return mul3x3(m, [
    v[0], 0, 0,
    0, v[1], 0,
    0, 0, v[2],
  ]);
}

// src の4点を dst の4点へ写す 3x3 ホモグラフィー H を求める(H = D * adj(S))
function computeHomography(src, dst) {
  const s = basisToPoints(src);
  const d = basisToPoints(dst);
  return mul3x3(d, adj3(s));
}

// 3x3 ホモグラフィー H を CSS の matrix3d(列優先の4x4)文字列へ変換する。
// [x, y, 0, 1] に対し X=H0x+H1y+H2, Y=H3x+H4y+H5, W=H6x+H7y+H8 を与える4x4を、
// CSS が要求する列優先の順で並べる。
function homographyToCssMatrix3d(src, dst) {
  const H = computeHomography(src, dst);
  for (let i = 0; i < 9; i++) H[i] /= H[8]; // H8=1 に正規化
  const m = [
    H[0], H[3], 0, H[6],
    H[1], H[4], 0, H[7],
    0, 0, 1, 0,
    H[2], H[5], 0, H[8],
  ];
  return `matrix3d(${m.join(',')})`;
}

// =====================================================================
// カメラによる自動アライメント(プロカム自動調整)
//
// 原理: 正面に設置したカメラでホワイトボードを写した状態で、投影面へ黒→白の
// 全画面パターンを一瞬ずつ投影し、その差分からカメラに写った「投影領域の四隅」を
// 検出する。これはスクリーン(ビューポート)座標→カメラ座標の射影変換 F にあたる。
// カメラ(=正面)から見て長方形になるようキャンバスを補正したいので、
//   1) カメラ画角内に収まる 4:3 の軸並行長方形 R(カメラ座標)を目標に選ぶ
//   2) 各点を F の逆 (= computeHomography(カメラ, スクリーン)) でスクリーンへ写す
//   3) その4点を projectorCornerFractions として設定する(手動調整と同じ枠組み)
// これで「正面カメラから見て長方形」に投影され、斜め投影の台形歪みが補正される。
// =====================================================================

const AUTO_CALIB_SETTLE_MS = 450; // パターンを投影してからキャプチャするまでの待ち(投影・カメラの反映待ち)
let autoCalibrating = false;      // 多重実行防止フラグ

async function autoCalibrate() {
  if (autoCalibrating) return;

  if (!window.cvReady) {
    updateCalibStatus('OpenCVがまだ読み込まれていません', '#f88');
    return;
  }
  const video = document.getElementById('cameraPreview');
  if (!currentCameraStream || !video.videoWidth) {
    updateCalibStatus('先に「カメラ開始」でカメラを起動してください', '#f88');
    return;
  }

  autoCalibrating = true;
  const autoBtn = document.getElementById('autoCalibrateBtn');
  autoBtn.disabled = true;

  // 調整中はプレビューを隠しているが、非表示のvideoはフレームがデコードされない
  // ことがあるため、キャプチャの間だけ表示する(全画面パターンで覆われるので見えない)
  const wrap = document.getElementById('cameraPreviewWrap');
  const prevWrapDisplay = wrap.style.display;
  wrap.style.display = 'block';

  let matA = null;
  let matB = null;
  try {
    updateCalibStatus('自動調整中… 投影面を撮影しています', '#8cf');

    showCalibPattern('#000');
    await delay(AUTO_CALIB_SETTLE_MS);
    matA = await captureCalibrationMat(video);

    showCalibPattern('#fff');
    await delay(AUTO_CALIB_SETTLE_MS);
    matB = await captureCalibrationMat(video);

    hideCalibPattern();

    const quad = detectProjectedQuad(matA, matB);
    if (!quad) {
      updateCalibStatus('投影領域を検出できませんでした(部屋を暗くしカメラ位置を確認)', '#f88');
      return;
    }
    if (quad.touchesEdge) {
      updateCalibStatus('投影がカメラ画角からはみ出しています(投影を小さくして再試行)', '#fc8');
      return;
    }

    const corners = computeAutoCorners(quad.corners);
    if (!corners) {
      updateCalibStatus('補正を計算できませんでした(投影の傾きが大きすぎます)', '#f88');
      return;
    }

    projectorCornerFractions = corners;
    calibrationDirty = true;
    applyCanvasProjection();
    positionHandles();
    updateCalibStatus('自動調整しました(必要なら微調整し「保存」で確定)', '#8f8');
  } catch (err) {
    updateCalibStatus(`自動調整に失敗しました: ${err.message}`, '#f88');
  } finally {
    // キャプチャしたMatはGCされないので必ず解放する(検出関数は内部Matのみ解放する)
    if (matA) matA.delete();
    if (matB) matB.delete();
    hideCalibPattern();
    wrap.style.display = prevWrapDisplay;
    autoBtn.disabled = false;
    autoCalibrating = false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showCalibPattern(color) {
  const el = document.getElementById('calibPatternOverlay');
  el.style.background = color;
  el.classList.add('active');
}

function hideCalibPattern() {
  document.getElementById('calibPatternOverlay').classList.remove('active');
}

// カメラ映像を平均化キャプチャして cv.Mat(RGBA)として返す
async function captureCalibrationMat(video) {
  const scale = CAMERA_CAPTURE_WIDTH / video.videoWidth;
  const targetHeight = Math.round(video.videoHeight * scale);
  const canvas = await captureAveragedFrame(video, CAMERA_CAPTURE_WIDTH, targetHeight);
  return cv.imread(canvas);
}

// 黒フレームmatA・白フレームmatBの明るさ差分から、カメラに写った投影領域の四隅を求める。
// 戻り値: { corners: [tl, tr, br, bl](カメラpx), touchesEdge: 画角の縁に接しているか } / 検出失敗時 null
function detectProjectedQuad(matA, matB) {
  let grayA = null;
  let grayB = null;
  let diff = null;
  let mask = null;
  let kernel = null;
  let contours = null;
  let hierarchy = null;
  let largest = null;

  try {
    grayA = new cv.Mat();
    grayB = new cv.Mat();
    cv.cvtColor(matA, grayA, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(matB, grayB, cv.COLOR_RGBA2GRAY);

    // 白−黒の明るさ差が大きい画素=投影光が当たっている領域。Otsuで自動しきい値化する。
    diff = new cv.Mat();
    cv.absdiff(grayB, grayA, diff);
    mask = new cv.Mat();
    cv.threshold(diff, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

    // 穴埋め(CLOSE)→小さなノイズ除去(OPEN)でひとつながりの領域にする
    kernel = cv.Mat.ones(5, 5, cv.CV_8U);
    const anchor = new cv.Point(-1, -1);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel, anchor, 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());

    contours = new cv.MatVector();
    hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    if (contours.size() === 0) return null;

    // 最大面積の輪郭を投影領域とみなす
    let bestIndex = -1;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      c.delete();
      if (area > bestArea) {
        bestArea = area;
        bestIndex = i;
      }
    }

    const imgArea = mask.rows * mask.cols;
    if (bestIndex < 0 || bestArea < imgArea * 0.02) return null; // 小さすぎる=検出失敗

    largest = contours.get(bestIndex);

    // 四隅を極値法で求める(TL:x+y最小 / BR:x+y最大 / TR:x−y最大 / BL:x−y最小)
    let tl = null;
    let tr = null;
    let br = null;
    let bl = null;
    let minSum = Infinity;
    let maxSum = -Infinity;
    let minDiff = Infinity;
    let maxDiff = -Infinity;
    for (let r = 0; r < largest.rows; r++) {
      const x = largest.data32S[r * 2];
      const y = largest.data32S[r * 2 + 1];
      const sum = x + y;
      const d = x - y;
      if (sum < minSum) { minSum = sum; tl = { x, y }; }
      if (sum > maxSum) { maxSum = sum; br = { x, y }; }
      if (d > maxDiff) { maxDiff = d; tr = { x, y }; }
      if (d < minDiff) { minDiff = d; bl = { x, y }; }
    }
    if (!tl || !tr || !br || !bl) return null;

    const m = 3; // 画角の縁とみなす余白(px)
    const touchesEdge = [tl, tr, br, bl].some((p) =>
      p.x <= m || p.y <= m || p.x >= mask.cols - 1 - m || p.y >= mask.rows - 1 - m);

    return { corners: [tl, tr, br, bl], touchesEdge };
  } finally {
    if (grayA) grayA.delete();
    if (grayB) grayB.delete();
    if (diff) diff.delete();
    if (mask) mask.delete();
    if (kernel) kernel.delete();
    if (largest) largest.delete();
    if (contours) contours.delete();
    if (hierarchy) hierarchy.delete();
  }
}

// カメラ座標の投影領域四隅から、キャンバス補正用の四隅(ビューポート割合)を計算する。
// カメラ(正面)から見て 4:3 の軸並行長方形になるよう、スクリーン側の四隅を逆算する。
function computeAutoCorners(cameraCorners) {
  const iw = window.innerWidth;
  const ih = window.innerHeight;

  // スクリーン(ビューポート)四隅 ↔ カメラ四隅 の対応からカメラ→スクリーン変換を得る
  const screenCorners = [
    { x: 0, y: 0 },
    { x: iw, y: 0 },
    { x: iw, y: ih },
    { x: 0, y: ih },
  ];
  const Hcs = computeHomography(cameraCorners, screenCorners); // カメラpx → スクリーンpx

  const [tl, tr, br, bl] = cameraCorners;

  // 検出した(傾いた)四辺形の内側に必ず収まる、軸並行の最大長方形を取る
  const left = Math.max(tl.x, bl.x);
  const right = Math.min(tr.x, br.x);
  const top = Math.max(tl.y, tr.y);
  const bottom = Math.min(bl.y, br.y);
  if (right - left < 10 || bottom - top < 10) return null;

  // その枠内に 4:3(=CANVAS_W:CANVAS_H)を保った長方形 R を中央寄せで収める
  const boxW = right - left;
  const boxH = bottom - top;
  const aspect = CANVAS_W / CANVAS_H;
  let w;
  let h;
  if (boxW / boxH > aspect) {
    h = boxH;
    w = h * aspect;
  } else {
    w = boxW;
    h = w / aspect;
  }
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const targetRect = [
    { x: cx - w / 2, y: cy - h / 2 }, // 左上
    { x: cx + w / 2, y: cy - h / 2 }, // 右上
    { x: cx + w / 2, y: cy + h / 2 }, // 右下
    { x: cx - w / 2, y: cy + h / 2 }, // 左下
  ];

  // 目標長方形の各点をスクリーンへ写し、ビューポート割合として返す
  return targetRect.map((p) => {
    const s = projectPoint(Hcs, p);
    return { fx: s.x / iw, fy: s.y / ih };
  });
}

// 3x3 ホモグラフィー H を点 p={x,y} に適用する(同次座標で割り戻す)
function projectPoint(H, p) {
  const v = mul3v(H, [p.x, p.y, 1]);
  return { x: v[0] / v[2], y: v[1] / v[2] };
}

// =====================================================================
// 出力モニターの選択(Window Management API)
//
// 複数ディスプレイ環境で、投影(フルスクリーン)を出す先のモニターを選べる
// ようにする。対応ブラウザ(Chrome/Edge 等)では window.getScreenDetails() で
// 画面一覧を取得し、element.requestFullscreen({ screen }) で指定モニターへ
// フルスクリーン表示する。非対応環境では既定モニターへの通常フルスクリーンに
// フォールバックする。フルスクリーン後は onFullscreenChange → applyCanvasProjection
// が走るので、保存済みのキーストーン補正もそのまま適用される。
// =====================================================================

let screenDetailsObj = null; // getScreenDetails() の結果(ライブに更新される)

function setupProjection() {
  const supported = 'getScreenDetails' in window;
  document.getElementById('refreshMonitorsBtn').addEventListener('click', refreshMonitors);
  document.getElementById('projectFullscreenBtn').addEventListener('click', projectToSelectedMonitor);

  const status = document.getElementById('monitorStatus');
  if (!supported) {
    document.getElementById('refreshMonitorsBtn').disabled = true;
    document.getElementById('monitorSelect').disabled = true;
    status.textContent = 'このブラウザは出力先の指定に非対応(既定モニターへ投影します)';
  } else {
    status.textContent = '「モニター一覧を更新」で投影先を選べます';
  }
}

async function refreshMonitors() {
  const status = document.getElementById('monitorStatus');
  if (!('getScreenDetails' in window)) return;

  try {
    // 初回は権限ダイアログ(ウィンドウ管理)が出る。以後はライブ更新される同じ実体を使う。
    if (!screenDetailsObj) {
      screenDetailsObj = await window.getScreenDetails();
      // モニター構成が変わったら一覧を張り直す
      screenDetailsObj.addEventListener('screenschange', populateMonitorSelect);
    }
    populateMonitorSelect();
    status.textContent = `${screenDetailsObj.screens.length}台のモニターを検出`;
  } catch (err) {
    status.textContent = `モニター一覧を取得できませんでした: ${err.message}`;
  }
}

function populateMonitorSelect() {
  if (!screenDetailsObj) return;
  const select = document.getElementById('monitorSelect');
  const previous = select.value;
  select.innerHTML = '<option value="">既定のモニター</option>';

  screenDetailsObj.screens.forEach((screen, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    const marks = [];
    if (screen.isPrimary) marks.push('主');
    if (screen.isInternal) marks.push('内蔵');
    const label = screen.label || `モニター ${index + 1}`;
    option.textContent = `${label} (${screen.width}x${screen.height})${marks.length ? ' [' + marks.join('/') + ']' : ''}`;
    select.appendChild(option);
  });

  // 可能なら以前の選択を維持する
  if (previous && select.querySelector(`option[value="${previous}"]`)) {
    select.value = previous;
  }
}

async function projectToSelectedMonitor() {
  const status = document.getElementById('monitorStatus');
  const value = document.getElementById('monitorSelect').value;

  try {
    if (screenDetailsObj && value !== '') {
      const screen = screenDetailsObj.screens[Number(value)];
      await gameCanvasElement.requestFullscreen({ screen });
    } else {
      // 出力先未指定 or 非対応環境 → 既定モニターへ通常フルスクリーン
      await gameCanvasElement.requestFullscreen();
    }
  } catch (err) {
    status.textContent = `投影(フルスクリーン)に切り替えられませんでした: ${err.message}`;
  }
}

