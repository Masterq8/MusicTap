/**
 * Web Audio 合成引擎 - 零外部音频资源，纯实时合成
 * 6 种音色：正弦 / 方波 / 三角 / 锯齿 / 泛音叠加 / 白噪声
 * Y 轴 → 音高，X 轴 → 声像（Pan）
 *
 * WaveformOsc 是六种波形的共享工厂，djFxEngine 的旋律层共用同一套算法，
 * 保证设置面板的音色选择对演示路由与主点击路径一致生效。
 */

/**
 * 六种波形共享工厂（audioEngine 与 djFxEngine 共用）。
 * @param {AudioContext} ctx   音频上下文
 * @param {number} freq        基频（Hz）
 * @param {string} waveform    sine | square | triangle | sawtooth | harmonic | noise
 * @param {number} when        排程起始时间（ctx.currentTime 基准）
 * @returns {{outs: AudioNode[], sources: AudioNode[]}}
 *   outs    —— 接到包络增益的输出节点（harmonic 为每泛音一个增益节点）
 *   sources —— 可 stop() 的振荡器/声源；调用方负责在音符结束时 stop，防止泄漏
 */
var WaveformOsc = function (ctx, freq, waveform, when) {
  var outs = [];
  var sources = [];

  if (waveform === 'harmonic') {
    var HARMONICS = [
      { mult: 1, gain: 0.5 },
      { mult: 2, gain: 0.25 },
      { mult: 3, gain: 0.15 },
      { mult: 4, gain: 0.1 }
    ];
    for (var i = 0; i < HARMONICS.length; i++) {
      var h = HARMONICS[i];
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * h.mult;
      var g = ctx.createGain();
      g.gain.value = h.gain;
      osc.connect(g);
      osc.start(when);
      outs.push(g);
      sources.push(osc);
    }
  } else if (waveform === 'noise') {
    // 噪声缓冲按 ctx 缓存复用，避免每次发音重建
    var cache = WaveformOsc._noiseCache || (WaveformOsc._noiseCache = new WeakMap());
    var buf = cache.get(ctx);
    if (!buf) {
      var len = Math.floor(ctx.sampleRate * 0.2);
      buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var j = 0; j < len; j++) d[j] = Math.random() * 2 - 1;
      cache.set(ctx, buf);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    src.start(when);
    outs.push(src);
    sources.push(src);
  } else {
    var o = ctx.createOscillator();
    o.type = waveform;
    o.frequency.value = freq;
    o.start(when);
    outs.push(o);
    sources.push(o);
  }

  return { outs: outs, sources: sources };
};

if (typeof window !== 'undefined') window.WaveformOsc = WaveformOsc;
else if (typeof globalThis !== 'undefined') globalThis.WaveformOsc = WaveformOsc;

var AudioEngine = function () {
  this.ctx = null;
  this.masterGain = null;
  this.analyser = null;
  this.waveform = 'harmonic';
  this.volume = 0.6;
  this.activeNodes = {};
  this.nodeIdCounter = 0;
};

AudioEngine.prototype.init = function () {
  if (this.ctx) return;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { console.warn('浏览器不支持 Web Audio'); return; }
  this.ctx = new AC();
  this.masterGain = this.ctx.createGain();
  this.masterGain.gain.value = this.volume;
  this.masterGain.connect(this.ctx.destination);

  this.analyser = this.ctx.createAnalyser();
  this.analyser.fftSize = 256;
  this.analyser.smoothingTimeConstant = 0.8;
  this.masterGain.connect(this.analyser);
};

AudioEngine.prototype.setWaveform = function (type) {
  this.waveform = type;
};

AudioEngine.prototype.setVolume = function (v) {
  this.volume = Math.max(0, Math.min(1, v));
  if (this.masterGain && this.ctx) {
    this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }
};

AudioEngine.prototype.midiToFreq = function (midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
};

AudioEngine.prototype.playNote = function (note, pan) {
  if (!this.ctx || !this.masterGain) return -1;
  if (this.ctx.state === 'suspended') this.ctx.resume();

  var id = this.nodeIdCounter++;
  var freq = this.midiToFreq(note);
  var now = this.ctx.currentTime;

  var gain = this.ctx.createGain();
  var panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
  if (panner) panner.pan.value = pan || 0;

  var bundle = this.createOscillator(freq, now);
  bundle.outs.forEach(function (o) { o.connect(gain); });
  if (panner) { gain.connect(panner); panner.connect(this.masterGain); }
  else { gain.connect(this.masterGain); }

  // ADSR 包络：快速 Attack + 长 Release
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(this.volume * 0.4, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(this.volume * 0.1, now + 0.3);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

  this.activeNodes[id] = { bundle: bundle, gain: gain };
  // 包络 0.8s 结束后自动回收振荡器（stopNote 无常规调用者，不排程则永久泄漏）
  var stopAt = now + 0.9;
  bundle.sources.forEach(function (s) {
    try { s.stop(stopAt); } catch (e) {}
  });
  return id;
};

AudioEngine.prototype.createOscillator = function (freq, now) {
  return WaveformOsc(this.ctx, freq, this.waveform, now);
};

AudioEngine.prototype.stopNote = function (id) {
  if (!this.ctx) return;
  var entry = this.activeNodes[id];
  if (!entry) return;
  var now = this.ctx.currentTime;
  entry.gain.gain.cancelScheduledValues(now);
  entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
  entry.gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
  var sources = entry.bundle.sources;
  var outs = entry.bundle.outs;
  setTimeout(function () {
    sources.forEach(function (s) { try { s.stop(); } catch (e) {} });
    outs.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
    try { entry.gain.disconnect(); } catch (e) {}
  }, 100);
  delete this.activeNodes[id];
};

AudioEngine.prototype.getSpectrumData = function () {
  if (!this.analyser) return null;
  var data = new Uint8Array(this.analyser.frequencyBinCount);
  this.analyser.getByteFrequencyData(data);
  return data;
};
