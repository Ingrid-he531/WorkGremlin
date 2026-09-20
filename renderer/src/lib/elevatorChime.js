/**
 * 到层提示音 —— 电梯到站那一声"叮"。
 *
 * 为什么用 WebAudio 现场合成，而不是 <audio> + 音频文件：
 *   1. 零资源、零依赖（工程里没有音频资产，也不想为一声铃加一个 mp3）；
 *   2. 对齐可控 —— 音频文件要解码，第一趟常常来不及响，或者响在门开完以后；
 *      现场合成是"门一开就响"，时间上跟 `phase: opening` 同帧。
 *
 * 音色是怎么做的（第一版只叠了两个正弦，听感像电子提示音，不像电梯）：
 *   真电梯那声"叮" = **金属钟被敲响**，三件事缺一不可：
 *     ① 非谐泛音：钟的泛音不是整数倍（1 / 2.0 / 2.76 / 4.07 / 5.43），
 *        整数倍叠加听起来就是风琴/电子音，非谐才是"金属"；
 *     ② 敲击噪声：开头 20ms 的高频气声，那一下"金属被敲到"的触感；
 *     ③ 各泛音衰减不同：高频很快没、低频拖长尾（1.0 那条能响一秒多），
 *        于是听起来是"叮——"而不是"哔"。
 *   另外每次响都加一点点随机失谐（±0.2%），连按不会两声一模一样 —— 真钟也不会。
 *
 * 三档音色（`localStorage['wg.elevatorChime']`，改完立刻生效，不用刷新）：
 *   `off`   → 静音
 *   `bell`  → 单声钟"叮"（**默认**，最接近真电梯到站那一下）
 *   `chime` → 两音门铃"叮-咚"（E6→C6 下行，老式客梯的门铃）
 *   其它任何值 / 没设 → 按 `bell` 走。
 *
 * 另外两条规矩：
 *   1. **懒建 AudioContext**：浏览器 / Electron 都要求"用户手势之后"才允许出声。
 *      呼梯本身就是一次点击，所以放到第一次要响的时候建最稳；被挂起时顺手 resume。
 *   2. 250ms 内重复触发只响一次（连点楼层不会变成一串铃）。
 */

/** 钟体基音 C6（≈1046.5Hz）：接近真电梯那声铃，明亮但不尖 */
const BASE_HZ = 1046.5;
/** 峰值增益：整条链路的唯一音量旋钮，嫌吵改这一个数 */
const PEAK_GAIN = 0.12;
/** 同一时间内只响一次的最小间隔（ms） */
const MIN_GAP_MS = 250;

/** 单声钟：比例 / 相对音量 / 衰减秒数。非谐比例是"金属感"的来源，低频那几条衰减最慢（尾音） */
const BELL_PARTIALS = [
  [1, 1, 1.05],
  [2.0, 0.5, 0.75],
  [2.76, 0.33, 0.55],
  [4.07, 0.19, 0.34],
  [5.43, 0.11, 0.2],
];

/** 两音门铃：频率 + 相对第一声的延迟（秒），下行三度（E6 → C6），像老客梯的门铃 */
const CHIME_NOTES = [
  [1318.5, 0],
  [1046.5, 0.17],
];
/** 门铃泛音比钟少一档：两声叠在一起，泛音太多会糊 */
const CHIME_PARTIALS = [
  [1, 1, 0.85],
  [2.0, 0.35, 0.5],
  [3.01, 0.12, 0.3],
];

let ctx = null;
let lastAt = 0;

/** 读音色档：off / bell / chime（读不到就按 bell） */
function mode() {
  let v = '';
  try {
    v = localStorage.getItem('wg.elevatorChime') || '';
  } catch {
    return 'bell'; // 隐私模式 / 禁用存储：按默认走
  }
  if (v === 'off') return 'off';
  if (v === 'chime' || v === 'twotone') return 'chime';
  return 'bell';
}

/** 拿到可用的 AudioContext；环境不支持（或无 window）返回 null，调用方静默跳过 */
function ensureCtx() {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * 敲一下钟：按泛音表铺一串正弦，逐个给"起音 → 指数衰减"的包络。
 * @param {AudioContext} ac
 * @param {GainNode} master 总线
 * @param {number} t0 起始时刻（AudioContext 时间轴，秒）
 * @param {number} f0 基音频率
 * @param {number[][]} partials [比例, 相对音量, 衰减秒数]
 * @param {number} detune 整体失谐比例（每次响略微不同）
 */
function voice(ac, master, t0, f0, partials, detune) {
  const base = f0 * (1 + detune);
  for (const [ratio, amp, decay] of partials) {
    const hz = base * ratio;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    // 敲响瞬间音高略高、很快落回：钟被敲到时"紧一下再松"的物理感，几音分就够
    osc.frequency.setValueAtTime(hz * 1.006, t0);
    osc.frequency.exponentialRampToValueAtTime(hz, t0 + 0.05);
    // 指数包络：起音 2ms（敲击感），尾巴自然衰减（指数不能用 0，用 0.0001 兜底）
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(amp, t0 + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }
}

/**
 * 敲击噪声：20ms 的衰减白噪声 + 2.5kHz 高通，给"金属被敲到"的那一下。
 * 没有它，再多的泛音也像电子音（这是第一版最缺的东西）。
 */
function strikeNoise(ac, master, t0, gainValue) {
  const len = Math.max(1, Math.floor(ac.sampleRate * 0.02));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len); // 线性衰减
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const gain = ac.createGain();
  gain.gain.value = gainValue;
  src.connect(hp).connect(gain).connect(master);
  src.start(t0);
}

/**
 * 响一声。到层（`phase` 进入 `opening`，门开始开）时调用。
 * 不能出声的环境里静默返回 —— 提示音失败绝不能影响动画。
 */
export function playArrivalChime() {
  const m = mode();
  if (m === 'off') return;
  const now = Date.now();
  if (now - lastAt < MIN_GAP_MS) return;
  lastAt = now;

  const ac = ensureCtx();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + 0.01;
    const master = ac.createGain();
    master.gain.value = PEAK_GAIN;
    master.connect(ac.destination);
    const detune = (Math.random() - 0.5) * 0.004;
    if (m === 'chime') {
      for (const [hz, delay] of CHIME_NOTES) {
        strikeNoise(ac, master, t0 + delay, 0.035);
        voice(ac, master, t0 + delay, hz, CHIME_PARTIALS, detune);
      }
    } else {
      strikeNoise(ac, master, t0, 0.05);
      voice(ac, master, t0, BASE_HZ, BELL_PARTIALS, detune);
    }
  } catch {
    /* 合成失败就当没这回事 */
  }
}
