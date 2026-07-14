// =====================================================================
// 【出力】効果音(WebAudioで合成。音声ファイルは使わない)
// 判定済みの「音の強さ(0〜1)」だけを引数で受け取って鳴らす吸収点。
// matter.js・ボール・p5.js のことは一切知らない(データ結合)。
// 何を鳴らすかの判定は変換側(transform/contact.js)の仕事。
//
// 音は2種類:
//   衝突音   … 使い捨てのノイズバースト(コツン)。1回の接触につき1回だけ
//   転がり音 … 全ボール共通の1ボイス。ノイズをループさせ続け、音量と音色だけを強さで動かす
// =====================================================================

let AudioCtx = null;     // 最初のユーザー操作まで null(ブラウザが操作前の再生を禁止しているため)
let MasterGain = null;   // ミュート/音量はここだけを触る
let RollGain = null;     // 転がり音の音量
let RollFilter = null;   // 転がり音の音色(速いほど高くする)
let IsSoundEnabled = true;
let MasterVolume = SOUND_DEFAULT_VOLUME;

// 設定の復元と自分のDOMリスナーの登録。AudioContext はまだ作らない。
function init_sound() {
  load_sound_settings();

  document.getElementById('soundToggle').addEventListener('change', handle_sound_toggle);
  document.getElementById('soundVolumeSlider').addEventListener('input', handle_volume_change);

  // ブラウザはユーザー操作前の音声再生を禁止しているので、最初の操作で音の準備をする。
  // 線を描く(pointerdown)かボールを落とす(keydown)が必ず先に起きるため、
  // ボールが存在する時点では常に準備済みになる。
  window.addEventListener('pointerdown', ensure_audio_ready, { once: true });
  window.addEventListener('keydown', ensure_audio_ready, { once: true });
}

// 最初のユーザー操作で1回だけ音の準備をする(タブ復帰などで停止していたら再開する)
function ensure_audio_ready() {
  if (AudioCtx) {
    if (AudioCtx.state === 'suspended') AudioCtx.resume();
    return;
  }

  AudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  MasterGain = AudioCtx.createGain();
  MasterGain.gain.value = IsSoundEnabled ? MasterVolume : 0;
  MasterGain.connect(AudioCtx.destination);

  build_roll_voice();
}

// 転がり音のボイス(全ボール共通の1本)を組み立てる。
// 音源は鳴らしっぱなしにして音量だけで制御する(start/stopを繰り返すとプチノイズが出るため)。
function build_roll_voice() {
  RollFilter = AudioCtx.createBiquadFilter();
  RollFilter.type = 'lowpass';
  RollFilter.frequency.value = SOUND_ROLL_FILTER_MIN_HZ;

  RollGain = AudioCtx.createGain();
  RollGain.gain.value = 0;

  const Source = AudioCtx.createBufferSource();
  Source.buffer = make_noise_buffer(2);
  Source.loop = true;

  Source.connect(RollFilter);
  RollFilter.connect(RollGain);
  RollGain.connect(MasterGain);
  Source.start();
}

// 効果音の唯一の公開窓口。毎フレーム main.js から呼ばれる。
// Events = { Impacts: [{Strength: 0〜1, IsBallHit}], RollLevel: 0〜1 }
function play_contact_sounds(Events) {
  if (!AudioCtx) return; // 最初のユーザー操作がまだ = 音を出せない

  if (!IsSoundEnabled) {
    set_roll_level(0);
    return;
  }

  for (const Impact of Events.Impacts) {
    play_impact_voice(Impact.Strength, Impact.IsBallHit);
  }
  set_roll_level(Events.RollLevel);
}

// 衝突音(コツン)。使い捨てのノイズバースト → バンドパス → 指数減衰のゲイン。
// 強く当たるほど音量が上がり音程も高くなる。ボール同士はさらに高くして線との衝突と区別する。
function play_impact_voice(Strength, IsBallHit) {
  const Now = AudioCtx.currentTime;

  const Source = AudioCtx.createBufferSource();
  Source.buffer = make_noise_buffer(SOUND_IMPACT_DECAY_SEC * 2);

  const Filter = AudioCtx.createBiquadFilter();
  Filter.type = 'bandpass';
  Filter.Q.value = 2;
  const BaseHz = mix_value(SOUND_IMPACT_FILTER_MIN_HZ, SOUND_IMPACT_FILTER_MAX_HZ, Strength);
  Filter.frequency.value = IsBallHit ? BaseHz * SOUND_IMPACT_BALL_HIT_SCALE : BaseHz;

  const Gain = AudioCtx.createGain();
  Gain.gain.setValueAtTime(SOUND_IMPACT_MAX_GAIN * Strength + 0.05, Now);
  Gain.gain.exponentialRampToValueAtTime(0.0001, Now + SOUND_IMPACT_DECAY_SEC);

  Source.connect(Filter);
  Filter.connect(Gain);
  Gain.connect(MasterGain);
  Source.onended = () => Gain.disconnect();
  Source.start(Now);
  Source.stop(Now + SOUND_IMPACT_DECAY_SEC);
}

// 転がり音を目標の強さへ滑らかに追従させる。急変させないことで、衝突音の直後に
// 転がり音が刺さり込むことも自然に防げる。強さ0でも音源は止めず、ゲインを0にするだけ。
function set_roll_level(Level) {
  if (!RollGain) return;

  const Now = AudioCtx.currentTime;
  const TargetHz = mix_value(SOUND_ROLL_FILTER_MIN_HZ, SOUND_ROLL_FILTER_MAX_HZ, Level);
  RollGain.gain.setTargetAtTime(SOUND_ROLL_MAX_GAIN * Level, Now, SOUND_ROLL_SMOOTH_SEC);
  RollFilter.frequency.setTargetAtTime(TargetHz, Now, SOUND_ROLL_SMOOTH_SEC);
}

// ホワイトノイズのバッファを作る(衝突音・転がり音の共通素材)
function make_noise_buffer(Seconds) {
  const Length = Math.floor(AudioCtx.sampleRate * Seconds);
  const Buffer = AudioCtx.createBuffer(1, Length, AudioCtx.sampleRate);
  const Data = Buffer.getChannelData(0);

  for (let I = 0; I < Length; I++) {
    Data[I] = Math.random() * 2 - 1;
  }
  return Buffer;
}

function mix_value(From, To, Level) {
  return From + (To - From) * Level;
}

// --- 設定(ミュート/音量): DOMとlocalStorageの吸収 ---

function handle_sound_toggle(Event) {
  IsSoundEnabled = Event.target.checked;
  apply_master_gain();
  save_sound_settings();
}

function handle_volume_change(Event) {
  MasterVolume = Number(Event.target.value) / 100;
  document.getElementById('soundVolumeValue').textContent = Event.target.value;
  apply_master_gain();
  save_sound_settings();
}

function apply_master_gain() {
  if (!MasterGain) return;
  const Target = IsSoundEnabled ? MasterVolume : 0;
  MasterGain.gain.setTargetAtTime(Target, AudioCtx.currentTime, SOUND_ROLL_SMOOTH_SEC);
}

// 保存済みの設定を読み、コントロールの表示に反映する
function load_sound_settings() {
  const Saved = read_saved_sound_settings();
  IsSoundEnabled = Saved.enabled;
  MasterVolume = Saved.volume;

  const Slider = document.getElementById('soundVolumeSlider');
  Slider.value = Math.round(MasterVolume * 100);
  document.getElementById('soundToggle').checked = IsSoundEnabled;
  document.getElementById('soundVolumeValue').textContent = Slider.value;
}

// localStorage から設定を読む。未保存や壊れている場合は既定値を返す。
function read_saved_sound_settings() {
  const Defaults = { enabled: true, volume: SOUND_DEFAULT_VOLUME };

  try {
    const Raw = localStorage.getItem(SOUND_STORAGE_KEY);
    const Saved = Raw ? JSON.parse(Raw) : null;
    if (!Saved || typeof Saved.volume !== 'number') return Defaults;
    return { enabled: Saved.enabled !== false, volume: Saved.volume };
  } catch (Error) {
    return Defaults;
  }
}

function save_sound_settings() {
  localStorage.setItem(
    SOUND_STORAGE_KEY,
    JSON.stringify({ enabled: IsSoundEnabled, volume: MasterVolume })
  );
}
