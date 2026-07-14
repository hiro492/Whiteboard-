// =====================================================================
// 【入力】カメラキャプチャとリアルタイム検出
// カメラの列挙・開始、複数フレーム平均化キャプチャ、タイマーによる
// リアルタイム再検出を担当する。4隅補正の状態は input_camera_calib の
// アクセサ(get_camera_corners 等)経由で受け取る(データ結合)。
// =====================================================================

let CurrentCameraStream = null;
let RealtimeTimerId = null;       // setIntervalのID。null = 停止中
let IsRealtimeProcessing = false; // 検出処理中に次のタイマーが多重実行されないようにするフラグ

// カメラ系UIのイベント登録(mainのsetupから呼ばれる)
function init_camera_controls() {
  document.getElementById('startCameraBtn').addEventListener('click', start_camera);
  document.getElementById('captureCameraBtn').addEventListener('click', capture_camera_frame);
  document.getElementById('realtimeToggleBtn').addEventListener('click', toggle_realtime);
  document.getElementById('realtimeIntervalSlider').addEventListener('input', on_realtime_interval_changed);

  // 映像サイズが0x0のままなら映像が届いていないと判断できるデバッグ表示
  document.getElementById('cameraPreview').addEventListener('loadedmetadata', (Event) => {
    const Video = Event.target;
    show_camera_status(`映像サイズ: ${Video.videoWidth}x${Video.videoHeight}`);
    draw_camera_quad(); // 映像サイズ確定後に4隅ハンドル(あれば)の位置を描き直す
  });

  refresh_camera_list();
}

// カメラ一覧を取得してセレクトボックスに反映する(権限付与後はラベルも取得できる)
async function refresh_camera_list() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

  const Devices = await navigator.mediaDevices.enumerateDevices();
  const VideoInputs = Devices.filter((D) => D.kind === 'videoinput');

  const Select = document.getElementById('cameraSelect');
  const PreviousValue = Select.value;
  Select.innerHTML = '';
  VideoInputs.forEach((Device, Index) => {
    const Option = document.createElement('option');
    Option.value = Device.deviceId;
    Option.textContent = Device.label || `カメラ ${Index + 1}`;
    Select.appendChild(Option);
  });
  if (PreviousValue && VideoInputs.some((D) => D.deviceId === PreviousValue)) {
    Select.value = PreviousValue;
  }
}

async function start_camera() {
  const DeviceId = document.getElementById('cameraSelect').value;

  if (CurrentCameraStream) {
    CurrentCameraStream.getTracks().forEach((Track) => Track.stop());
  }

  try {
    const Constraints = {
      video: DeviceId ? { deviceId: { exact: DeviceId } } : true,
      audio: false,
    };
    CurrentCameraStream = await navigator.mediaDevices.getUserMedia(Constraints);

    const Video = document.getElementById('cameraPreview');
    Video.muted = true;
    Video.playsInline = true;
    Video.srcObject = CurrentCameraStream;
    // 非表示になっているのは video 自身ではなく親の #cameraPreviewWrap 側なので、そちらを表示する
    document.getElementById('cameraPreviewWrap').style.display = 'block';
    await Video.play();

    document.getElementById('captureCameraBtn').disabled = false;
    document.getElementById('realtimeToggleBtn').disabled = false;
    show_camera_status('カメラ映像を取得中です');

    await refresh_camera_list(); // 権限付与後はラベル付きで一覧を取り直す
  } catch (Err) {
    show_camera_status(`カメラを開始できませんでした: ${Err.message}`);
  }
}

// 複数フレームを平均化してキャプチャし(センサーノイズの揺らぎを抑える)、
// カメラ4隅が指定されていれば長方形へ透視補正してから検出へ渡す
async function capture_camera_frame() {
  const Video = document.getElementById('cameraPreview');
  if (!CurrentCameraStream || !Video.videoWidth) return;

  const Scale = CAMERA_CAPTURE_WIDTH / Video.videoWidth;
  const TargetHeight = Math.round(Video.videoHeight * Scale);
  const FullCanvas = await capture_averaged_frame(Video, CAMERA_CAPTURE_WIDTH, TargetHeight);

  const Prepared = warp_if_corners_set(FullCanvas);
  show_camera_status(Prepared.StatusText);

  store_source_image(Prepared.Canvas);
  run_detection(Prepared.Canvas);
}

// 4隅が指定されていれば、その四辺形を長方形(16:9固定)へ透視補正する。
// 4隅が退化している(2隅が近すぎる等)場合や、透視変換自体が失敗した場合は
// 例外を検出パイプライン全体へ伝播させず、未補正の映像にフォールバックする
// (でないとリアルタイム検出がここで無言のまま止まってしまう)。
function warp_if_corners_set(FullCanvas) {
  const Corners = get_camera_corners();
  if (!Corners) {
    return { Canvas: FullCanvas, StatusText: make_capture_status(false, FullCanvas) };
  }
  if (is_degenerate_quad(Corners)) {
    return {
      Canvas: FullCanvas,
      StatusText: '4隅が近すぎるため透視補正をスキップしました(カメラ4隅を合わせ直してください)',
    };
  }
  try {
    const Warped = warp_camera_to_rectangle(FullCanvas, Corners);
    return { Canvas: Warped, StatusText: make_capture_status(true, Warped) };
  } catch (Err) {
    return { Canvas: FullCanvas, StatusText: `透視補正に失敗したため元映像で検出します: ${Err.message}` };
  }
}

// キャプチャ状態の表示文言を組み立てる
function make_capture_status(WarpActive, Canvas) {
  return `透視補正: ${WarpActive ? '有効' : '無効'} / 処理解像度: ${Canvas.width}x${Canvas.height} / ${AVERAGE_FRAME_COUNT}フレーム平均`;
}

// 連続数フレームをキャプチャし、cv.addWeightedによる累積平均でセンサーノイズを平滑化する。
// OpenCV Mat はGCされないため、単一のtry/finallyでまとめて解放する(CLAUDE.mdのメモリ規律)。
async function capture_averaged_frame(Video, TargetWidth, TargetHeight) {
  const TempCanvas = document.createElement('canvas');
  TempCanvas.width = TargetWidth;
  TempCanvas.height = TargetHeight;
  const TempCtx = TempCanvas.getContext('2d');

  let Avg = null; // cv.Mat(CV_32F)。フレームを重ねるごとに累積平均を更新する

  try {
    for (let I = 0; I < AVERAGE_FRAME_COUNT; I++) {
      TempCtx.drawImage(Video, 0, 0, TargetWidth, TargetHeight);

      const Frame = cv.imread(TempCanvas);
      const FrameFloat = new cv.Mat();
      Frame.convertTo(FrameFloat, cv.CV_32F);
      Frame.delete();

      if (Avg === null) {
        Avg = FrameFloat;
      } else {
        // 累積平均の更新式: avg = avg*(i/(i+1)) + frame*(1/(i+1))
        cv.addWeighted(Avg, I / (I + 1), FrameFloat, 1 / (I + 1), 0, Avg);
        FrameFloat.delete();
      }

      if (I < AVERAGE_FRAME_COUNT - 1) {
        await wait_for_next_video_frame(Video);
      }
    }

    const Averaged8u = new cv.Mat();
    Avg.convertTo(Averaged8u, cv.CV_8U);

    const OutCanvas = document.createElement('canvas');
    OutCanvas.width = TargetWidth;
    OutCanvas.height = TargetHeight;
    cv.imshow(OutCanvas, Averaged8u);
    Averaged8u.delete();

    return OutCanvas;
  } finally {
    if (Avg) Avg.delete();
  }
}

// 実際に新しい映像フレームが描画されるまで待つ(対応ブラウザではrequestVideoFrameCallbackを使用)
function wait_for_next_video_frame(Video) {
  return new Promise((Resolve) => {
    if (typeof Video.requestVideoFrameCallback === 'function') {
      Video.requestVideoFrameCallback(() => Resolve());
    } else {
      requestAnimationFrame(() => requestAnimationFrame(Resolve));
    }
  });
}

function toggle_realtime() {
  if (RealtimeTimerId) {
    stop_realtime();
  } else {
    start_realtime();
  }
}

function start_realtime() {
  if (RealtimeTimerId || !CurrentCameraStream) return;

  const IntervalMs = Number(document.getElementById('realtimeIntervalSlider').value) * 1000;
  RealtimeTimerId = setInterval(run_realtime_tick, IntervalMs);
  update_realtime_ui();
  run_realtime_tick(); // 開始した瞬間にも1回実行する
}

function stop_realtime() {
  if (RealtimeTimerId) {
    clearInterval(RealtimeTimerId);
    RealtimeTimerId = null;
  }
  update_realtime_ui();
}

// スライダーで間隔を変えたら、動作中なら新しい間隔でタイマーを張り直す
function on_realtime_interval_changed() {
  const Seconds = Number(document.getElementById('realtimeIntervalSlider').value);
  document.getElementById('realtimeIntervalValue').textContent = Seconds.toFixed(1);

  if (RealtimeTimerId) {
    clearInterval(RealtimeTimerId);
    RealtimeTimerId = setInterval(run_realtime_tick, Seconds * 1000);
  }
}

// 検出処理中に次のタイマーが発火しても多重実行しない。
// カメラ4隅をドラッグ中の場合も、確定前の中間状態を検出に使わないようスキップする。
async function run_realtime_tick() {
  if (IsRealtimeProcessing || is_camera_calib_dragging()) return;
  IsRealtimeProcessing = true;
  try {
    await capture_camera_frame();
  } catch (Err) {
    // 想定外の例外でもリアルタイムループを無言で止めず、状態をユーザーに伝える
    show_camera_status(`検出中にエラーが発生しました: ${Err.message}`);
  } finally {
    IsRealtimeProcessing = false;
  }
  update_realtime_ui();
}

function update_realtime_ui() {
  const Btn = document.getElementById('realtimeToggleBtn');
  const Seconds = Number(document.getElementById('realtimeIntervalSlider').value);
  const Active = !!RealtimeTimerId;

  Btn.textContent = Active ? 'リアルタイム停止' : 'リアルタイム開始';
  Btn.classList.toggle('active', Active);

  const LastRun = Active ? `(最終検出: ${new Date().toLocaleTimeString()})` : '';
  document.getElementById('realtimeStatus').textContent =
    `リアルタイム: ${Active ? `動作中(間隔${Seconds}秒)` : '停止中'} ${LastRun}`;
}
