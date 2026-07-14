// =====================================================================
// 【入力】マウス描画
// p5.jsのマウスコールバック(関数名はp5.jsの仕様で固定・改名不可)を受け取り、
// ドラッグの軌跡を線分として出力側(output_physics)へ渡す。
// =====================================================================

let IsDrawing = false;
let LastPoint = null; // 直前のドラッグ位置 {x, y}。null = ドラッグしていない

function is_inside_canvas(X, Y) {
  return X >= 0 && X <= CANVAS_W && Y >= 0 && Y <= CANVAS_H;
}

function mousePressed() {
  if (!is_inside_canvas(mouseX, mouseY)) return;
  IsDrawing = true;
  LastPoint = { x: mouseX, y: mouseY };
}

function mouseDragged() {
  if (!IsDrawing || !LastPoint) return;

  const Current = { x: mouseX, y: mouseY };
  if (Math.hypot(Current.x - LastPoint.x, Current.y - LastPoint.y) < MIN_SEGMENT_LEN) return;

  add_hand_line_segment(LastPoint, Current);
  LastPoint = Current;
}

function mouseReleased() {
  IsDrawing = false;
  LastPoint = null;
}
