/**
 * 星海共振 - 主题配色方案
 * 颜色值使用 PIXI v6 的 number 格式（0xRRGGBB）
 */
var THEMES = {
  nebula: {
    name: '星海共振',
    background: 0x0a0420,
    backgrounds: [0x0a0420, 0x14084a, 0x1a0a5e, 0x200c70],
    particles: [0x00f0ff, 0xff00aa, 0x7fff00, 0xffcc00, 0x9b59ff, 0xff6b35],
    ripple: 0x00f0ff,
    spectrum: [0x00f0ff, 0xff00aa, 0x7fff00],
    accent: 0x00f0ff
  },
  aurora: {
    name: '极光之舞',
    background: 0x001a33,
    backgrounds: [0x001a33, 0x002a4a, 0x003a55, 0x004a60],
    particles: [0x00ff88, 0x00ccff, 0xff00ff, 0xffff00, 0x00ffcc],
    ripple: 0x00ff88,
    spectrum: [0x00ff88, 0x00ccff],
    accent: 0x00ff88
  },
  ember: {
    name: '熔岩星火',
    background: 0x1a0000,
    backgrounds: [0x1a0000, 0x2a0a00, 0x3a1400, 0x4a1e00],
    particles: [0xff3300, 0xffaa00, 0xff6600, 0xff0033, 0xffff66],
    ripple: 0xff6600,
    spectrum: [0xff3300, 0xffaa00],
    accent: 0xff6600
  },
  cyberpunk: {
    name: '赛博霓虹',
    background: 0x0d0d1a,
    backgrounds: [0x0d0d1a, 0x1a0d2e, 0x2a0d40, 0x3a0d50],
    particles: [0xff2d95, 0xff6b35, 0x9b59ff, 0x00ffaa, 0xffcc00],
    ripple: 0xff2d95,
    spectrum: [0xff2d95, 0x9b59ff],
    accent: 0xff2d95
  },
  deepocean: {
    name: '深海秘境',
    background: 0x001018,
    backgrounds: [0x001018, 0x002030, 0x003048, 0x004060],
    particles: [0x00bcd4, 0x4dd0e1, 0x00e5ff, 0x18ffff, 0x84ffff, 0x006064],
    ripple: 0x00e5ff,
    spectrum: [0x00bcd4, 0x00e5ff],
    accent: 0x00e5ff
  }
};

function getTheme(id) {
  return THEMES[id] || THEMES.nebula;
}
