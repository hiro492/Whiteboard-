// =====================================================================
// 【出力】投影ウィンドウ(2画面出力)
//
// 複数ディスプレイ環境で、投影を出す先のモニターを選べるようにする。対応
// ブラウザ(Chrome/Edge 等)では window.getScreenDetails() で画面一覧を取得し、
// window.open() でそのモニターの位置・サイズに別ウィンドウを開く(ノートPC側は
// 操作画面のまま残せる、2画面出力対応)。非対応環境では既定位置にウィンドウを
// 開く。ゲームキャンバスの内容は start_projection_mirror() が毎フレーム転写する。
// =====================================================================

let ScreenDetailsObj = null; // getScreenDetails() の結果(ライブに更新される)

// 投影ウィンドウ(プロジェクタ側)関連。null = 投影していない。
let ProjectionWindow = null;       // window.open で開いた別ウィンドウ
let ProjectionMirrorCanvas = null; // 投影ウィンドウ内のミラー用canvas
let ProjectionMirrorRAF = null;    // ミラー転写ループのrequestAnimationFrame ID
let LayoutProjectionRAF = null;    // resize連続発火をまとめるrequestAnimationFrame ID

// 投影ウィンドウが開いていて、まだ閉じられていないか
function is_projecting() {
  return !!(ProjectionWindow && !ProjectionWindow.closed);
}

function init_projection() {
  const Supported = 'getScreenDetails' in window;
  document.getElementById('refreshMonitorsBtn').addEventListener('click', refresh_monitors);
  document.getElementById('projectFullscreenBtn').addEventListener('click', toggle_projection);

  const Status = document.getElementById('monitorStatus');
  if (!Supported) {
    document.getElementById('refreshMonitorsBtn').disabled = true;
    document.getElementById('monitorSelect').disabled = true;
    Status.textContent = 'このブラウザは出力先の指定に非対応(既定モニターへ投影します)';
  } else {
    Status.textContent = '「モニター一覧を更新」で投影先を選べます';
  }

  // メインウィンドウを閉じたら投影ウィンドウも閉じる(取り残し防止)。
  // stop_projection() を経由させ、RAF停止などの後始末も他の終了経路と揃える。
  window.addEventListener('beforeunload', () => {
    if (is_projecting()) stop_projection();
  });
}

async function refresh_monitors() {
  const Status = document.getElementById('monitorStatus');
  if (!('getScreenDetails' in window)) return;

  try {
    // 初回は権限ダイアログ(ウィンドウ管理)が出る。以後はライブ更新される同じ実体を使う。
    if (!ScreenDetailsObj) {
      ScreenDetailsObj = await window.getScreenDetails();
      // モニター構成が変わったら一覧を張り直す
      ScreenDetailsObj.addEventListener('screenschange', populate_monitor_select);
    }
    populate_monitor_select();
    Status.textContent = `${ScreenDetailsObj.screens.length}台のモニターを検出`;
  } catch (Err) {
    Status.textContent = `モニター一覧を取得できませんでした: ${Err.message}`;
  }
}

function populate_monitor_select() {
  if (!ScreenDetailsObj) return;
  const Select = document.getElementById('monitorSelect');
  const Previous = Select.value;
  Select.innerHTML = '<option value="">既定のモニター</option>';

  ScreenDetailsObj.screens.forEach((Screen, Index) => {
    const Option = document.createElement('option');
    Option.value = String(Index);
    const Marks = [];
    if (Screen.isPrimary) Marks.push('主');
    if (Screen.isInternal) Marks.push('内蔵');
    const Label = Screen.label || `モニター ${Index + 1}`;
    Option.textContent = `${Label} (${Screen.width}x${Screen.height})${Marks.length ? ' [' + Marks.join('/') + ']' : ''}`;
    Select.appendChild(Option);
  });

  // 可能なら以前の選択を維持する
  if (Previous && Select.querySelector(`option[value="${Previous}"]`)) {
    Select.value = Previous;
  }
}

// セレクトボックスで選ばれているモニター(Screen)を返す。既定選択なら null
function get_selected_screen() {
  const Value = document.getElementById('monitorSelect').value;
  if (!ScreenDetailsObj || Value === '') return null;
  return ScreenDetailsObj.screens[Number(Value)];
}

// 「選択モニターに投影」= プロジェクタ側に別ウィンドウを開き、そこへゲーム画面を
// 毎フレーム転写(ミラー)する。元ウィンドウ(ノートPC)は操作画面のまま残る。
// もう一度押すと投影を終了する(トグル)。
function toggle_projection() {
  if (is_projecting()) {
    stop_projection();
    return;
  }

  const Target = get_selected_screen();
  if (!open_projection_window(Target)) return;

  wire_projection_window();
  start_projection_mirror();
  update_projection_button();
  document.getElementById('monitorStatus').textContent = Target
    ? `「${Target.label || '選択モニター'}」へ投影中(ウィンドウ内クリックで全画面)`
    : '投影ウィンドウを開きました(プロジェクタ画面へ移動し、クリックで全画面)';
}

// 投影ウィンドウを対象モニターの位置・サイズで開く。開けたら true
function open_projection_window(Target) {
  let Features = 'popup=yes';
  if (Target) {
    // 選択したモニターの位置・サイズにウィンドウを開く
    Features = `popup=yes,left=${Target.availLeft},top=${Target.availTop},` +
      `width=${Target.availWidth},height=${Target.availHeight}`;
  }

  ProjectionWindow = window.open('', 'whiteboardProjection', Features);
  if (!ProjectionWindow) {
    document.getElementById('monitorStatus').textContent =
      '投影ウィンドウを開けませんでした(ポップアップを許可してください)';
    return false;
  }

  // 選択モニターの座標へ確実に移動・最大化する(featuresが効かないブラウザ対策)
  if (Target) {
    try {
      ProjectionWindow.moveTo(Target.availLeft, Target.availTop);
      ProjectionWindow.resizeTo(Target.availWidth, Target.availHeight);
    } catch (E) { /* 一部ブラウザは移動/リサイズを禁止するが致命的ではない */ }
  }
  return true;
}

// 開いた投影ウィンドウへ中身を書き込み、イベント(クリック全画面・resize)を配線する
function wire_projection_window() {
  write_projection_document(ProjectionWindow);
  ProjectionMirrorCanvas = ProjectionWindow.document.getElementById('mirror');

  // 全画面化はそのウィンドウ内のユーザー操作が必要なので、自動化せずクリックに任せる
  ProjectionWindow.document.addEventListener('click', toggle_projection_window_fullscreen);
  ProjectionWindow.addEventListener('resize', schedule_layout_projection_canvas);

  // レイアウト確定を待ってからキーストーン等を適用(開いた直後はinnerWidthが0のことがある)
  setTimeout(layout_projection_canvas, 60);
}

// 投影ウィンドウ内でクリックすると全画面化(ブラウザのUIを消す)
function toggle_projection_window_fullscreen() {
  const Doc = ProjectionWindow.document;
  if (Doc.fullscreenElement) {
    Doc.exitFullscreen();
  } else if (Doc.documentElement.requestFullscreen) {
    Doc.documentElement.requestFullscreen().catch(() => {});
  }
  const Hint = Doc.getElementById('hint');
  if (Hint) Hint.style.display = 'none';
}

// 投影ウィンドウの中身(黒背景+ミラー用canvas+案内)を書き込む
function write_projection_document(Win) {
  Win.document.open();
  Win.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<title>投影出力</title>
<style>
  html, body { margin: 0; padding: 0; background: #000; overflow: hidden; height: 100%; cursor: none; }
  #mirror { position: fixed; left: 0; top: 0; transform-origin: 0 0; }
  #hint {
    position: fixed; left: 50%; top: 12px; transform: translateX(-50%);
    color: #888; font: 13px sans-serif; background: rgba(0,0,0,0.6);
    padding: 6px 14px; border-radius: 6px; z-index: 10; cursor: pointer;
  }
</style></head><body>
  <canvas id="mirror" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
  <div id="hint">クリックで全画面 / このウィンドウをプロジェクタ画面へ</div>
</body></html>`);
  Win.document.close();
}

// 投影ウィンドウのネイティブresizeイベントは連続発火するため、投影ウィンドウ自身の
// rAFで1フレームに1回へまとめてから layout_projection_canvas を呼ぶ。
function schedule_layout_projection_canvas() {
  if (!is_projecting() || LayoutProjectionRAF !== null) return;
  LayoutProjectionRAF = ProjectionWindow.requestAnimationFrame(() => {
    LayoutProjectionRAF = null;
    layout_projection_canvas();
  });
}

// 投影ウィンドウのcanvasを、そのウィンドウのサイズに合わせて配置し、
// 保存済みのキーストーン補正(なければアスペクト維持で中央寄せ)を適用する。
function layout_projection_canvas() {
  if (!is_projecting() || !ProjectionMirrorCanvas) return;

  const Vw = ProjectionWindow.innerWidth || ProjectionWindow.document.documentElement.clientWidth;
  const Vh = ProjectionWindow.innerHeight || ProjectionWindow.document.documentElement.clientHeight;
  if (!Vw || !Vh) return;

  // apply_canvas_projection と同じ共通ヘルパーを使い、投影ウィンドウ自身のサイズを渡す。
  // 保存済みキーストーンがあればそれを、なければそのウィンドウのアスペクト比で
  // 中央寄せした既定4隅(default_corner_fractions)を使う — メインウィンドウ側と
  // 計算式を二重に持たない。
  const { DispW, DispH, Src } = compute_display_rect(Vw, Vh);
  const Dst = corner_fractions_to_px(current_corner_fractions(Vw, Vh), Vw, Vh);

  ProjectionMirrorCanvas.style.width = `${DispW}px`;
  ProjectionMirrorCanvas.style.height = `${DispH}px`;
  ProjectionMirrorCanvas.style.transform = homography_to_css_matrix3d(Src, Dst);
}

// ゲームキャンバスの内容を投影ウィンドウのcanvasへ毎フレーム転写するループ。
// requestAnimationFrame は必ず ProjectionWindow 側のものを使う — メインウィンドウの
// rAFはそのウィンドウがバックグラウンドタブになるとブラウザにスロットリングされ、
// 投影先(別ウィンドウ)がまだ前面に見えていても転写が止まってしまうため。
function start_projection_mirror() {
  const Tick = () => {
    if (!is_projecting()) {
      stop_projection(); // ユーザーが投影ウィンドウを閉じたら停止して状態を戻す
      return;
    }
    if (ProjectionMirrorCanvas && get_game_canvas()) {
      const Ctx = ProjectionMirrorCanvas.getContext('2d');
      Ctx.drawImage(get_game_canvas(), 0, 0, CANVAS_W, CANVAS_H);
    }
    ProjectionMirrorRAF = ProjectionWindow.requestAnimationFrame(Tick);
  };
  ProjectionMirrorRAF = ProjectionWindow.requestAnimationFrame(Tick);
}

function stop_projection() {
  if (ProjectionMirrorRAF) {
    if (is_projecting()) ProjectionWindow.cancelAnimationFrame(ProjectionMirrorRAF);
    ProjectionMirrorRAF = null;
  }
  if (LayoutProjectionRAF !== null) {
    if (is_projecting()) ProjectionWindow.cancelAnimationFrame(LayoutProjectionRAF);
    LayoutProjectionRAF = null;
  }
  if (is_projecting()) {
    ProjectionWindow.close();
  }
  ProjectionWindow = null;
  ProjectionMirrorCanvas = null;
  update_projection_button();
  const Status = document.getElementById('monitorStatus');
  if (Status) Status.textContent = '投影を終了しました';
}

// 投影中かどうかでボタンの文言を切り替える
function update_projection_button() {
  const Btn = document.getElementById('projectFullscreenBtn');
  if (!Btn) return;
  Btn.textContent = is_projecting() ? '投影を終了' : '選択モニターに投影';
}
