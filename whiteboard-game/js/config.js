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

// --- 効果音(WebAudioで合成。音声ファイルは使わない) ---
const SOUND_STORAGE_KEY = 'sound_settings_v1'; // ミュート/音量の永続化
const SOUND_IMPACT_MIN_SPEED = 1.5;  // この接近速度未満の接触は無音(置いただけ/微小バウンドを除去)
const SOUND_IMPACT_MAX_SPEED = 14;   // 衝突音が最大音量になる接近速度
const SOUND_IMPACT_COOLDOWN_MS = 90; // 同じボールが衝突音を鳴らせる最小間隔(着地時のチャタリング防止)
const SOUND_IMPACT_DECAY_SEC = 0.07; // 衝突音(コツン)の減衰時間
const SOUND_IMPACT_MAX_GAIN = 0.7;   // 衝突音の最大ゲイン
const SOUND_IMPACT_FILTER_MIN_HZ = 500;  // 弱い衝突の音程(バンドパスの中心周波数)
const SOUND_IMPACT_FILTER_MAX_HZ = 2200; // 強い衝突の音程
const SOUND_IMPACT_BALL_HIT_SCALE = 1.6; // ボール同士の衝突は音程を上げて線との衝突と区別する
const SOUND_ROLL_MIN_SPEED = 0.6;    // この接線速度未満では転がり音を鳴らさない(静止中は無音)
const SOUND_ROLL_MAX_SPEED = 12;     // 転がり音が最大になる接線速度
const SOUND_ROLL_MAX_GAIN = 0.25;    // 転がり音の最大ゲイン(衝突音より控えめにして埋もれさせない)
const SOUND_ROLL_SMOOTH_SEC = 0.05;  // 転がり音のゲイン/音色の追従時定数(急変を避ける)
const SOUND_ROLL_FILTER_MIN_HZ = 200;  // ゆっくり転がるときの音色(ローパスの遮断周波数)
const SOUND_ROLL_FILTER_MAX_HZ = 1800; // 速く転がるときの音色
const SOUND_DEFAULT_VOLUME = 0.6;
