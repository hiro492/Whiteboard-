// =====================================================================
// 【共通】ホモグラフィー(射影変換)の計算
// 4点対応から 3x3 ホモグラフィー行列を解き、CSSのmatrix3dへ変換する純関数群。
// カメラ補正(入力側)とプロジェクタ補正(出力側)の両方から使われる共通機能。
// DOMや他モジュールの状態には一切触れない。
// =====================================================================

// 3x3 行列(長さ9の配列, 行優先)の余因子行列(adjugate)
function adj3(M) {
  return [
    M[4] * M[8] - M[5] * M[7], M[2] * M[7] - M[1] * M[8], M[1] * M[5] - M[2] * M[4],
    M[5] * M[6] - M[3] * M[8], M[0] * M[8] - M[2] * M[6], M[2] * M[3] - M[0] * M[5],
    M[3] * M[7] - M[4] * M[6], M[1] * M[6] - M[0] * M[7], M[0] * M[4] - M[1] * M[3],
  ];
}

// 3x3 行列同士の積
function mul3x3(A, B) {
  const C = new Array(9);
  for (let I = 0; I < 3; I++) {
    for (let J = 0; J < 3; J++) {
      let Sum = 0;
      for (let K = 0; K < 3; K++) Sum += A[3 * I + K] * B[3 * K + J];
      C[3 * I + J] = Sum;
    }
  }
  return C;
}

// 3x3 行列 × 3次元ベクトル
function mul3v(M, V) {
  return [
    M[0] * V[0] + M[1] * V[1] + M[2] * V[2],
    M[3] * V[0] + M[4] * V[1] + M[5] * V[2],
    M[6] * V[0] + M[7] * V[1] + M[8] * V[2],
  ];
}

// 「単位基底(3点)→与えられた4点」へ写す行列。4隅からホモグラフィーを組み立てる部品。
function basis_to_points(P) {
  const M = [
    P[0].x, P[1].x, P[2].x,
    P[0].y, P[1].y, P[2].y,
    1, 1, 1,
  ];
  const V = mul3v(adj3(M), [P[3].x, P[3].y, 1]);
  return mul3x3(M, [
    V[0], 0, 0,
    0, V[1], 0,
    0, 0, V[2],
  ]);
}

// src の4点を dst の4点へ写す 3x3 ホモグラフィー H を求める(H = D * adj(S))
function compute_homography(Src, Dst) {
  const S = basis_to_points(Src);
  const D = basis_to_points(Dst);
  return mul3x3(D, adj3(S));
}

// 3x3 ホモグラフィー H を CSS の matrix3d(列優先の4x4)文字列へ変換する。
// [x, y, 0, 1] に対し X=H0x+H1y+H2, Y=H3x+H4y+H5, W=H6x+H7y+H8 を与える4x4を、
// CSS が要求する列優先の順で並べる。
function homography_to_css_matrix3d(Src, Dst) {
  const H = compute_homography(Src, Dst);
  for (let I = 0; I < 9; I++) H[I] /= H[8]; // H8=1 に正規化
  const M = [
    H[0], H[3], 0, H[6],
    H[1], H[4], 0, H[7],
    0, 0, 1, 0,
    H[2], H[5], 0, H[8],
  ];
  return `matrix3d(${M.join(',')})`;
}
