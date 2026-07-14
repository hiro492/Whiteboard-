// =====================================================================
// 【出力】p5.jsによるキャンバス描画
// 物理ボディの見た目(線・ボール)と検出輪郭のデバッグ表示を描く。
// 描くデータは引数で受け取る(データ結合)。デバッグ用点列だけは
// このモジュールが所有し、set_contour_debug で差し替える。
// =====================================================================

let ContourDebugPaths = []; // 検出輪郭のデバッグ表示用点列(キャンバス座標系)

// 検出側から輪郭点列(ポリゴンの配列)を受け取って差し替える。[]でクリア
function set_contour_debug(Paths) {
  ContourDebugPaths = Paths;
}

function draw_lines(BodyList) {
  noStroke();
  fill(200);
  for (const Body of BodyList) {
    draw_line_body(Body);
  }
}

// 当たり判定(body本体)より細い見た目(LINE_THICKNESS)で描画する
function draw_line_body(Body) {
  push();
  translate(Body.position.x, Body.position.y);
  rotate(Body.angle);
  rectMode(CENTER);
  rect(0, 0, Body.renderLength, LINE_THICKNESS);
  pop();
}

function draw_balls(BallList) {
  for (const Body of BallList) {
    const { x, y } = Body.position;
    push();
    translate(x, y);
    rotate(Body.angle);
    noStroke();
    fill(255, 100, 80);
    circle(0, 0, BALL_RADIUS * 2);
    stroke(255);
    line(0, 0, BALL_RADIUS, 0); // 回転が見えるように印を付ける
    pop();
  }
}

function draw_contour_debug() {
  noFill();
  stroke(0, 255, 0);
  strokeWeight(2);
  for (const Points of ContourDebugPaths) {
    beginShape();
    for (const P of Points) {
      vertex(P.x, P.y);
    }
    endShape(CLOSE);
  }
  noStroke();
}
