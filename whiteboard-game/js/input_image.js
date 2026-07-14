// =====================================================================
// 【入力】画像ファイルと検出パラメータUI
// 画像ファイルの選択、再検出用の元画像(SourceImage)の保持、
// スライダー/セレクト類からの検出パラメータ読み取り(read_detection_params)を担当。
// 検出処理そのものは統括(main.js の run_detection)に任せる。
// =====================================================================

let SourceImage = null;         // 再検出用に保持する元画像(<img> またはキャプチャしたcanvas)
let ReprocessScheduled = false; // 再検出をrequestAnimationFrameへ予約済みか

// 画像・検出パラメータ系UIのイベント登録(mainのsetupから呼ばれる)
function init_image_input() {
  document.getElementById('imageInput').addEventListener('change', on_image_selected);

  document.getElementById('methodSelect').addEventListener('change', () => {
    update_hsv_controls_visibility();
    schedule_reprocess();
  });
  document.getElementById('morphOpenToggle').addEventListener('change', schedule_reprocess);

  bind_slider('satMaxSlider', 'satMaxValue');
  bind_slider('valMaxSlider', 'valMaxValue');
  bind_slider('minLengthSlider', 'minLengthValue');
  bind_slider('minAreaSlider', 'minAreaValue');
  bind_slider('dilateIterSlider', 'dilateIterValue');
  bind_slider('closeKernelSlider', 'closeKernelValue');
  bind_slider('diffThresholdSlider', 'diffThresholdValue');

  update_hsv_controls_visibility();
  bind_source_mode_radios();
}

// 画面のスライダー/セレクト類から検出パラメータを1つのオブジェクトへまとめて読み取る。
// 変換処理(transform_*)はDOMを直接読まず、この戻り値だけを受け取る(データ結合)。
function read_detection_params() {
  return {
    Method: document.getElementById('methodSelect').value,
    SatMax: Number(document.getElementById('satMaxSlider').value),
    ValMax: Number(document.getElementById('valMaxSlider').value),
    MinLength: Number(document.getElementById('minLengthSlider').value),
    MinArea: Number(document.getElementById('minAreaSlider').value),
    UseMorphOpen: document.getElementById('morphOpenToggle').checked,
    DilateIterations: Number(document.getElementById('dilateIterSlider').value),
    CloseKernelSize: Number(document.getElementById('closeKernelSlider').value),
    DiffThreshold: Number(document.getElementById('diffThresholdSlider').value),
  };
}

// 画像が選択されたら読み込んで検出を実行する
function on_image_selected(Event) {
  const File = Event.target.files && Event.target.files[0];
  Event.target.value = ''; // 同じファイルを連続で選んでも change が発火するようにする
  if (!File || !window.cvReady) return;

  const Reader = new FileReader();
  Reader.onload = (E) => {
    const Img = new Image();
    Img.onload = () => {
      store_source_image(Img);
      run_detection(Img);
    };
    Img.src = E.target.result;
  };
  Reader.readAsDataURL(File);
}

// 再検出用の元画像を差し替える(カメラキャプチャ側からも呼ばれる)
function store_source_image(Img) {
  SourceImage = Img;
}

// スライダー/検出方式の変更時に、同じ画像で再検出する(連続操作でも1フレームにまとめる)
function schedule_reprocess() {
  if (!SourceImage || !window.cvReady || ReprocessScheduled) return;
  ReprocessScheduled = true;
  requestAnimationFrame(() => {
    ReprocessScheduled = false;
    run_detection(SourceImage);
  });
}

// スライダーを動かすたびに数値表示を更新し、リアルタイムに再検出する
function bind_slider(SliderId, ValueLabelId) {
  const Slider = document.getElementById(SliderId);
  const ValueLabel = document.getElementById(ValueLabelId);
  Slider.addEventListener('input', () => {
    ValueLabel.textContent = Slider.value;
    schedule_reprocess();
  });
}

function update_hsv_controls_visibility() {
  const Method = document.getElementById('methodSelect').value;
  document.getElementById('hsvControls').style.display = Method === 'hsv' ? '' : 'none';
}

function bind_source_mode_radios() {
  const Radios = document.querySelectorAll('input[name="sourceMode"]');
  Radios.forEach((Radio) => Radio.addEventListener('change', update_source_mode_visibility));
  update_source_mode_visibility();
}

function update_source_mode_visibility() {
  const Mode = document.querySelector('input[name="sourceMode"]:checked').value;
  document.getElementById('fileControls').style.display = Mode === 'file' ? '' : 'none';
  document.getElementById('cameraControls').style.display = Mode === 'camera' ? '' : 'none';
  if (Mode !== 'camera') {
    stop_realtime(); // カメラから離れたらバックグラウンドでの自動更新は止める
  }
}

// OpenCV.js(WASM)の初期化完了までアップロードUIを無効化しておき、完了したら開放する。
// index.html のインラインスクリプトから window.handle_cv_ready 経由で呼ばれる。
function enable_image_upload() {
  document.getElementById('imageInput').disabled = false;
  document.getElementById('imageLabel').classList.remove('disabled');
  document.getElementById('cvStatus').textContent = '画像をアップロードできます';
}

window.handle_cv_ready = enable_image_upload;
