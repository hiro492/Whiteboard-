// =====================================================================
// 【変換】接触音の判定(衝突音か、転がり音か)
// 最大抽象入力点 = 物理から取り出した接触の素データ(Contacts)。
// 最大抽象出力点 = 鳴らすべき音の強さ(Impacts と RollLevel、いずれも0〜1)。
// matter.js・DOM・WebAudio には一切触れない純変換。結果はすべて戻り値で渡す。
//
// ■ 衝突音と転がり音が重複しない理由(この設計の核心)
// 線は1本の連続した線ではなく、独立した矩形ボディが数十個連なったものである
// (output/physics.js の add_line_segment がドラッグの1刻み・ポリゴンの1辺ごとに作る)。
// そのため「新しいペアができたら衝突音」とすると、転がっているだけのボールが
// セグメントを跨ぐたびに衝突音が連射されてしまう。
// そこで判定をペア単位ではなく【ボール単位の状態遷移】で行う:
//   衝突音 = そのボールが「どこにも触れていない → 何かに触れた」と遷移したフレームだけ
//   転がり音 = 接触が2フレーム以上「継続している」ボールの、面に沿った速度(接線成分)だけ
// 転がり中はセグメントを乗り継いでも接触が途切れないため遷移が起きず、衝突音は鳴りようがない。
// 逆に衝突したフレームは接触が継続していないため、転がり音には寄与しない。
// 同じ1つの状態機械の相互排他な2つの枝なので、構造的に重複しない。
//
// 前フレームの記憶だけはこのモジュールが所有する(transform/detect.js の PreviousMask と同じ)。
// 記憶は毎フレーム現在のボール一覧から作り直すため、消えたボールは自動的に忘れられる。
// =====================================================================

let PreviousBallStates = new Map(); // Id → {IsTouching, Vx, Vy}(前フレームの状態)
let PreviousPairKeys = new Set();   // 前フレームに接触していたボール同士のペアキー
let LastImpactTimes = new Map();    // Id → 最後に衝突音を鳴らした時刻(ms)

// 判定の統括。戻り値: { Impacts: [{Strength: 0〜1, IsBallHit}], RollLevel: 0〜1 }
function evaluate_contact_sounds(Contacts) {
  const Now = performance.now();
  const Impacts = [];
  const NextStates = new Map();
  let RollLevel = 0;

  for (const Ball of Contacts.Balls) {
    const Previous = PreviousBallStates.get(Ball.Id) || null;

    const Strength = evaluate_impact(Ball, Previous, Now);
    if (Strength !== null) {
      Impacts.push({ Strength, IsBallHit: false });
    }
    // 転がり音は全ボールの最大値を採る(合算すると多数のボールで音が破綻するため)
    RollLevel = Math.max(RollLevel, evaluate_roll(Ball, Previous));

    NextStates.set(Ball.Id, { IsTouching: Ball.IsTouching, Vx: Ball.Vx, Vy: Ball.Vy });
  }

  collect_ball_pair_impacts(Contacts.BallPairs, Impacts); // 前フレーム速度を読むので差し替えより先に呼ぶ

  PreviousBallStates = NextStates;
  prune_impact_times(NextStates);
  return { Impacts, RollLevel };
}

// ボールと静的な線の衝突判定。鳴らすなら強さ(0〜1)、鳴らさないなら null を返す。
function evaluate_impact(Ball, Previous, Now) {
  if (!Ball.IsTouching) return null;
  if (!Previous) return null;                    // 出現直後は前フレーム速度がなく判定材料がない
  if (Previous.IsTouching) return null;          // 接触が継続中 = 転がり。セグメント乗り継ぎの連射はここで消える

  // 接近速度は【前フレームの速度】を法線へ射影して求める。Engine.update 後の現在速度は
  // 衝突が解決された後(跳ね返り済み)なので、接近の勢いを過小評価してしまう。
  const ApproachSpeed = Math.abs(Previous.Vx * Ball.NormalX + Previous.Vy * Ball.NormalY);
  if (ApproachSpeed < SOUND_IMPACT_MIN_SPEED) return null; // 置いただけ/微小バウンドは無音

  const LastTime = LastImpactTimes.get(Ball.Id) || 0;
  if (Now - LastTime < SOUND_IMPACT_COOLDOWN_MS) return null; // 着地時のチャタリング防止
  LastImpactTimes.set(Ball.Id, Now);

  return normalize_speed(ApproachSpeed, SOUND_IMPACT_MIN_SPEED, SOUND_IMPACT_MAX_SPEED);
}

// 転がり音の強さ(0〜1)。接触が継続しているボールだけが鳴らす。
// 面に沿った速さ(接線成分 = 速度と法線の外積)だけを見るので、面に垂直な跳ね返りは転がり音にならない。
function evaluate_roll(Ball, Previous) {
  if (!Ball.IsTouching) return 0;
  if (!Previous || !Previous.IsTouching) return 0; // 触れた最初のフレームは衝突音の担当

  const TangentSpeed = Math.abs(Ball.Vx * Ball.NormalY - Ball.Vy * Ball.NormalX);
  if (TangentSpeed < SOUND_ROLL_MIN_SPEED) return 0; // 静止/ほぼ停止しているボールは無音
  return normalize_speed(TangentSpeed, SOUND_ROLL_MIN_SPEED, SOUND_ROLL_MAX_SPEED);
}

// ボール同士の衝突。ボールは分割されていない単体ボディなので、ペア単位の遷移判定で正しい。
// 見つけた衝突音は Impacts へ追加する。
function collect_ball_pair_impacts(BallPairs, Impacts) {
  const NextKeys = new Set();

  for (const Pair of BallPairs) {
    const Key = make_pair_key(Pair.IdA, Pair.IdB);
    NextKeys.add(Key);
    if (PreviousPairKeys.has(Key)) continue; // 接触が継続中 = 押し合い。衝突音は鳴らさない

    const Strength = evaluate_pair_impact(Pair);
    if (Strength !== null) {
      Impacts.push({ Strength, IsBallHit: true });
    }
  }
  PreviousPairKeys = NextKeys;
}

// ボール同士の新規接触の強さ。両ボールの前フレーム速度の差(相対速度)を法線へ射影して求める。
function evaluate_pair_impact(Pair) {
  const A = PreviousBallStates.get(Pair.IdA);
  const B = PreviousBallStates.get(Pair.IdB);
  if (!A || !B) return null;

  const ApproachSpeed = Math.abs((A.Vx - B.Vx) * Pair.NormalX + (A.Vy - B.Vy) * Pair.NormalY);
  if (ApproachSpeed < SOUND_IMPACT_MIN_SPEED) return null;
  return normalize_speed(ApproachSpeed, SOUND_IMPACT_MIN_SPEED, SOUND_IMPACT_MAX_SPEED);
}

// ペアの識別キー。ボディの順序に依らず同じキーになるよう小さいID順に並べる。
function make_pair_key(IdA, IdB) {
  return IdA < IdB ? `${IdA}-${IdB}` : `${IdB}-${IdA}`;
}

// 消えたボールのクールダウン記録を捨てる(記憶が際限なく増えないようにする)
function prune_impact_times(CurrentStates) {
  for (const Id of LastImpactTimes.keys()) {
    if (!CurrentStates.has(Id)) {
      LastImpactTimes.delete(Id);
    }
  }
}

// 速度をしきい値の範囲で 0〜1 に正規化する
function normalize_speed(Speed, MinSpeed, MaxSpeed) {
  const Level = (Speed - MinSpeed) / (MaxSpeed - MinSpeed);
  return Math.max(0, Math.min(1, Level));
}
