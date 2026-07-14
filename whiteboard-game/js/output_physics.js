// =====================================================================
// 【出力】物理演算(matter.js)
// 線(静的ボディ)とボール(動的ボディ)の生成・削除・更新を一手に引き受ける。
// ボディの配列(HandLines/ImageLines/Balls)はこのモジュールが所有し、
// 他モジュールとは点列や座標の引数・戻り値だけで連携する(データ結合)。
// =====================================================================

const { Engine, World, Bodies } = Matter;

let PhysicsEngine = null;
let PhysicsWorld = null;
let HandLines = [];  // マウスドラッグで描いた線(静的ボディ)
let ImageLines = []; // 画像検出で生成した線(静的ボディ、検出のたびに作り直す)
let Balls = [];      // 落としたボール

function init_physics() {
  PhysicsEngine = Engine.create();
  PhysicsWorld = PhysicsEngine.world;
}

// 物理演算を1ステップ進める(毎フレーム呼ばれる)
function update_physics() {
  Engine.update(PhysicsEngine);
}

// 描画側(output_render)へボディ一覧を渡すためのアクセサ
function get_hand_lines() {
  return HandLines;
}

function get_image_lines() {
  return ImageLines;
}

function get_balls() {
  return Balls;
}

// 2点間の線分を静的ボディとして追加する。
// 当たり判定は見た目より太くする(renderLengthは見た目の描画で使う)
function add_line_segment(P1, P2, TargetList) {
  const MidX = (P1.x + P2.x) / 2;
  const MidY = (P1.y + P2.y) / 2;
  const Length = Math.hypot(P2.x - P1.x, P2.y - P1.y);
  const Angle = Math.atan2(P2.y - P1.y, P2.x - P1.x);

  const Segment = Bodies.rectangle(MidX, MidY, Length, LINE_COLLISION_THICKNESS, {
    isStatic: true,
    friction: 0.05,
    angle: Angle,
  });
  Segment.renderLength = Length;

  World.add(PhysicsWorld, Segment);
  TargetList.push(Segment);
}

// マウス描画の1線分を追加する(入力側から呼ばれる公開窓口)
function add_hand_line_segment(P1, P2) {
  add_line_segment(P1, P2, HandLines);
}

// 検出ポリゴン(点列の配列)から画像由来の地形を作り直す(手描き線は残す)
function rebuild_image_terrain(Polygons) {
  World.remove(PhysicsWorld, ImageLines);
  ImageLines = [];

  for (const Points of Polygons) {
    for (let I = 0; I < Points.length; I++) {
      add_line_segment(Points[I], Points[(I + 1) % Points.length], ImageLines);
    }
  }
}

function drop_ball(X, Y) {
  const ClampedX = Math.max(0, Math.min(CANVAS_W, X));
  const ClampedY = Math.max(0, Math.min(CANVAS_H, Y));

  const Ball = Bodies.circle(ClampedX, ClampedY, BALL_RADIUS, {
    restitution: 0.3,
    friction: 0.02,
    frictionAir: 0.0005,
  });

  World.add(PhysicsWorld, Ball);
  Balls.push(Ball);
}

// 全ボディ(手描き線・画像線・ボール)を消す
function clear_physics() {
  World.remove(PhysicsWorld, HandLines);
  World.remove(PhysicsWorld, ImageLines);
  World.remove(PhysicsWorld, Balls);
  HandLines = [];
  ImageLines = [];
  Balls = [];
}

// 画面外に落ちたボールを削除してメモリを圧迫しないようにする(毎フレーム呼ばれる)
function remove_fallen_balls() {
  Balls = Balls.filter((Body) => {
    if (Body.position.y > CANVAS_H + 300) {
      World.remove(PhysicsWorld, Body);
      return false;
    }
    return true;
  });
}
