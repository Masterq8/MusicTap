/**
 * Web Audio 合成引擎 - 零外部音频资源，纯实时合成
 * 6 种音色：正弦 / 方波 / 三角 / 锯齿 / 泛音叠加 / 白噪声
 * Y 轴 → 音高，X 轴 → 声像（Pan）
 */
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

  var osc = this.createOscillator(freq, now);

  var nodes = Array.isArray(osc) ? osc : [osc];
  var self = this;
  nodes.forEach(function (o) { o.connect(gain); });
  if (panner) { gain.connect(panner); panner.connect(this.masterGain); }
  else { gain.connect(this.masterGain); }

  // ADSR 包络：快速 Attack + 长 Release
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(this.volume * 0.4, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(this.volume * 0.1, now + 0.3);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

  this.activeNodes[id] = { osc: osc, gain: gain };
  return id;
};

AudioEngine.prototype.createOscillator = function (freq, now) {
  var self = this;
  if (this.waveform === 'harmonic') {
    var harmonics = [
      { mult: 1, gain: 0.5 },
      { mult: 2, gain: 0.25 },
      { mult: 3, gain: 0.15 },
      { mult: 4, gain: 0.1 }
    ];
    return harmonics.map(function (h) {
      var osc = self.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * h.mult;
      var g = self.ctx.createGain();
      g.gain.value = h.gain;
      osc.connect(g);
      osc.start(now);
      return g;
    });
  }
  if (this.waveform === 'noise') {
    var bufferSize = this.ctx.sampleRate * 0.2;
    var buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    var source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.start(now);
    return source;
  }
  var osc = this.ctx.createOscillator();
  osc.type = this.waveform;
  osc.frequency.value = freq;
  osc.start(now);
  return osc;
};

AudioEngine.prototype.stopNote = function (id) {
  if (!this.ctx) return;
  var entry = this.activeNodes[id];
  if (!entry) return;
  var now = this.ctx.currentTime;
  entry.gain.gain.cancelScheduledValues(now);
  entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
  entry.gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
  var self = this;
  setTimeout(function () {
    if (!Array.isArray(entry.osc)) { try { entry.osc.stop(); } catch (e) {} }
    else entry.osc.forEach(function (o) { try { o.stop(); } catch (e) {} });
    try { entry.gain.disconnect(); } catch (e) {}
    if (Array.isArray(entry.osc)) entry.osc.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
    else { try { entry.osc.disconnect(); } catch (e) {} }
  }, 100);
  delete this.activeNodes[id];
};

AudioEngine.prototype.getSpectrumData = function () {
  if (!this.analyser) return null;
  var data = new Uint8Array(this.analyser.frequencyBinCount);
  this.analyser.getByteFrequencyData(data);
  return data;
};
