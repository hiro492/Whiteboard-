// =====================================================================
// 【出力】フルスクリーン表示
// ゲームキャンバスだけをFullscreen APIで全画面表示する。
// resizeCanvasはせず、CSSで見た目だけ拡大するので物理演算の座標系はそのまま。
// 保存済みのキーストーン補正(output_projector)があればそれも適用される。
// =====================================================================

let SavedDisplayValues = {}; // フルスクリーン中に隠したUIの元のdisplay値
let HideExitBtnTimer = null; // 「終了」ボタンを自動で隠すタイマー

function init_fullscreen() {
  document.getElementById('fullscreenBtn').addEventListener('click', toggle_fullscreen);
  document.getElementById('fullscreenExitBtn').addEventListener('click', () => {
    document.exitFullscreen();
  });

  document.addEventListener('fullscreenchange', on_fullscreen_change);
  window.addEventListener('resize', () => {
    if (document.fullscreenElement === get_game_canvas()) {
      apply_canvas_projection();
    }
  });

  // フルスクリーン中、マウスを画面上部に近づけると「終了」ボタンを表示する
  document.addEventListener('mousemove', on_fullscreen_mousemove);
}

function toggle_fullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    get_game_canvas().requestFullscreen().catch((Err) => {
      console.error('フルスクリーンに切り替えられませんでした', Err);
    });
  }
}

function on_fullscreen_change() {
  const IsFullscreen = document.fullscreenElement === get_game_canvas();

  if (IsFullscreen) {
    hide_ui_for_fullscreen();
    apply_canvas_projection();
  } else {
    restore_ui_after_fullscreen();
    reset_canvas_scale();
    document.getElementById('fullscreenExitBtn').classList.remove('visible');
  }
}

// マウスが画面上部に近づいたら「終了」ボタンを出し、離れたら1秒後に隠す
function on_fullscreen_mousemove(Event) {
  if (document.fullscreenElement !== get_game_canvas()) return;

  const ExitBtn = document.getElementById('fullscreenExitBtn');
  if (Event.clientY < 60) {
    ExitBtn.classList.add('visible');
    if (HideExitBtnTimer) {
      clearTimeout(HideExitBtnTimer);
      HideExitBtnTimer = null;
    }
  } else if (ExitBtn.classList.contains('visible') && !HideExitBtnTimer) {
    HideExitBtnTimer = setTimeout(() => {
      ExitBtn.classList.remove('visible');
      HideExitBtnTimer = null;
    }, 1000);
  }
}

// フルスクリーン中はスライダー類やプレビューを隠す(元の表示状態を保存しておき、解除時に復元する)
function hide_ui_for_fullscreen() {
  FULLSCREEN_HIDDEN_ELEMENT_IDS.forEach((Id) => {
    const El = document.getElementById(Id);
    SavedDisplayValues[Id] = El.style.display;
    El.style.display = 'none';
  });
}

function restore_ui_after_fullscreen() {
  FULLSCREEN_HIDDEN_ELEMENT_IDS.forEach((Id) => {
    const El = document.getElementById(Id);
    El.style.display = SavedDisplayValues[Id] || '';
  });
}
