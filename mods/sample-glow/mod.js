// mods/sample-glow/mod.js
// Phase 2 示例模组：把当前歌词做成会随音乐呼吸的「声光」文字。
// 它演示了模组系统的完整生命周期：register → activate → mount(container, ctx)
// → ctx.onFrame / onResize / getSettings → dispose。
UTAMods.register({
  id: 'sample-glow',
  name: '示例 · 声光歌词',
  version: '0.1.0',
  api: 1,
  author: 'MikuTap',
  description: '示例歌词模组：当前句居中显示，光晕随音频能量呼吸；可在设置面板里调光晕、缩放、字重与翻译开关。',
  settings: [
    { key: 'glow', type: 'number', label: '光晕强度', min: 0, max: 2, step: 0.05, defaultValue: 0.9 },
    { key: 'scale', type: 'number', label: '文字缩放', min: 0.7, max: 1.4, step: 0.05, defaultValue: 1 },
    { key: 'translation', type: 'boolean', label: '显示翻译', defaultValue: true },
    { key: 'color', type: 'color', label: '光晕颜色', defaultValue: '#00f0ff' },
    {
      key: 'weight',
      type: 'select',
      label: '字重',
      defaultValue: '300',
      options: [
        { value: '300', label: '细' },
        { value: '500', label: '中' },
        { value: '700', label: '粗' }
      ]
    }
  ],

  activate: function (folium) {
    folium.registries.visualizers.register({
      id: 'glow',
      label: '示例 · 声光',
      order: 900,

      mount: function (container, ctx) {
        var wrap = document.createElement('div');
        wrap.style.cssText = [
          'position:absolute',
          'left:6%',
          'right:6%',
          'bottom:17%',
          'display:flex',
          'flex-direction:column',
          'align-items:center',
          'gap:8px',
          'text-align:center',
          'opacity:0',
          'transition:opacity .25s ease',
          'will-change:opacity'
        ].join(';');

        var line = document.createElement('div');
        line.style.cssText = [
          'max-width:100%',
          'color:#fff',
          'font-weight:300',
          'letter-spacing:2px',
          'line-height:1.25',
          'white-space:pre-wrap',
          'word-break:break-word',
          'will-change:transform,text-shadow'
        ].join(';');

        var tr = document.createElement('div');
        tr.style.cssText = 'font-size:17px;color:rgba(255,255,255,.55);letter-spacing:1px;';

        wrap.appendChild(line);
        wrap.appendChild(tr);
        container.appendChild(wrap);

        var lastIdx = -2;
        var lastText = '';

        function applyFontSize() {
          var size = Math.max(24, Math.min(52, Math.round(window.innerHeight * 0.062)));
          line.style.fontSize = size + 'px';
        }
        applyFontSize();

        ctx.onResize(applyFontSize);

        ctx.onFrame(function (dt, s) {
          var set = ctx.getSettings() || {};
          var show = !!(s.visible && s.line);
          wrap.style.opacity = show ? '1' : '0';
          if (!show) return;

          if (s.index !== lastIdx || s.line.text !== lastText) {
            lastIdx = s.index;
            lastText = s.line.text || '';
            line.textContent = lastText;
          }
          var trText = (set.translation !== false && s.line.tr) ? s.line.tr : '';
          if (tr.textContent !== trText) tr.textContent = trText;
          tr.style.display = trText ? '' : 'none';

          var power = ctx.audio.getPower();
          var glow = Math.max(0, Number(set.glow) || 0);
          var scale = Math.max(0.5, Number(set.scale) || 1);
          var color = set.color || '#00f0ff';

          line.style.fontWeight = set.weight || '300';
          line.style.transform = 'scale(' + (scale * (1 + 0.035 * power)).toFixed(3) + ')';
          line.style.textShadow =
            '0 0 ' + (10 + glow * 28 * power).toFixed(1) + 'px ' + color + ',' +
            '0 0 ' + (3 + glow * 9).toFixed(1) + 'px rgba(255,255,255,.55)';
          tr.style.opacity = (0.45 + 0.35 * power).toFixed(2);
        });

        return function dispose() {
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        };
      }
    });
  }
});
