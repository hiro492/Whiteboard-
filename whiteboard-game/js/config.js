// =====================================================================
// 【共通】設定定数
// 全モジュールから参照される定数のみを置く。状態(let変数)はここには置かず、
// それを所有する各モジュールのファイルに閉じ込める(情報隠蔽)。
// =====================================================================

// --- キャンバス/物理演算(座標系800x600は不可侵。CSSでのみ拡大縮小する) ---
const CANVAS_W = 800;
const CANVAS_H = 600;
const LINE_THICKNESS = 8;             // 見た目の線の太さ
const LINE_COLLISION_THICKNESS = 18;  // 当たり判定用の太さ(見た目より太くして小さな隙間でも落ちにくくする)
const BALL_RADIUS = 16;
const MIN_SEGMENT_LEN = 4; // これより短い移動は線分を作らない

// --- 画像検出 ---
const EDGE_MARGIN = 2; // 画像の縁とみなす余白(px)

// --- カメラ入力 ---
const CAMERA_CAPTURE_WIDTH = 960; // カメラ映像は処理前にこの幅まで縮小して負荷を下げる
const AVERAGE_FRAME_COUNT = 4;    // センサーノイズの揺らぎを抑えるため平均化するフレーム数(3~5程度)

// --- カメラ手動4隅補正(入力画像側の透視補正) ---
const CAMERA_CORNERS_STORAGE_KEY = 'camera_corners_v1';
const CAMERA_WARP_W = 1280; // 透視補正後の出力サイズ(16:9固定・定数で変更可)
const CAMERA_WARP_H = 720;
const CAMERA_HANDLE_HIT_RADIUS = 18; // 隅ハンドルのクリック判定半径(プレビュー表示px)

// --- フルスクリーン ---
const FULLSCREEN_HIDDEN_ELEMENT_IDS = ['toolbar', 'cameraPreviewWrap', 'maskPreviewCanvas'];

// --- プロジェクタ調整(出力キャンバス側のキーストーン補正) ---
const PROJCAM_STORAGE_KEY = 'projcam_corners_v1';
const CALIB_HIDDEN_IDS = ['toolbar', 'cameraPreviewWrap', 'maskPreviewCanvas'];
