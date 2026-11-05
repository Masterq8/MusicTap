/**
 * lyricTunings.js — 歌词演出参数（通用 + 各模式）
 * ============================================================
 * 参考 Folia 的调参体系，为 uta-tap 的 13 个内置歌词模式提供统一参数存储。
 * 所有值持久化到 localStorage；模式渲染层通过 LyricTunings.get(modeId) 读取。
 */
var LyricTunings = (function () {
  'use strict';

  var STORAGE_KEY = 'uta.lyricTunings.v1';
  var listeners = [];
  var versions = {};
  var store = load();

  var COMMON_SCHEMA = [
    {
      key: 'font', type: 'select', label: '字体', defaultValue: 'sans',
      options: [
        { value: 'sans', label: '无衬线 · 干净' },
        { value: 'serif', label: '衬线 · 书卷' },
        { value: 'rounded', label: '圆体 · 柔和' },
        { value: 'mono', label: '等宽 · 科技' }
      ]
    },
    {
      key: 'fontScale', type: 'number', label: '字号', min: 0.7, max: 1.6, step: 0.05, defaultValue: 1
    },
    {
      key: 'opacity', type: 'number', label: '整体透明度', min: 0.2, max: 1, step: 0.05, defaultValue: 1
    }
  ];

  var MODE_SCHEMAS = {
    'folia-stream': [
      {
        title: '流光参数', fields: [
          { key: 'wordRotate', type: 'boolean', label: '逐字旋转', defaultValue: false },
          { key: 'layout', type: 'select', label: '排版模式', defaultValue: 'auto', options: [{ value: 'auto', label: '自适应' }, { value: 'legacy', label: '旧版排版' }] },
          { key: 'breath', type: 'number', label: '呼吸浮动范围', min: 0, max: 20, step: 1, defaultValue: 6 },
          { key: 'wordGap', type: 'number', label: '单词间距', min: 0, max: 12, step: 0.5, defaultValue: 2 }
        ]
      }
    ],
    'folia-partita': [
      {
        title: '云阶参数', fields: [
          { key: 'guide', type: 'boolean', label: '引导线', defaultValue: true },
          { key: 'semantic', type: 'boolean', label: '语义排列', defaultValue: true },
          { key: 'offsetMin', type: 'number', label: '错位最小值', min: 0, max: 180, step: 1, defaultValue: 20 },
          { key: 'offsetMax', type: 'number', label: '错位最大值', min: 0, max: 180, step: 1, defaultValue: 80 }
        ]
      }
    ],
    'folia-fume': [
      {
        title: '场景与镜头', fields: [
          { key: 'hideBoxes', type: 'boolean', label: '隐藏打印方块', defaultValue: false },
          { key: 'showGeometry', type: 'boolean', label: '通用几何图形', defaultValue: true },
          { key: 'objectOpacity', type: 'number', label: '背景物体透明度', min: 0, max: 1, step: 0.05, defaultValue: 0.6 },
          { key: 'textDwell', type: 'number', label: '文字停留比例', min: 0.2, max: 1, step: 0.05, defaultValue: 0.8 },
          { key: 'cameraSpeed', type: 'number', label: '摄影机移动速度', min: 0.2, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'cameraFollow', type: 'select', label: '摄影机跟随方式', defaultValue: 'smooth', options: [{ value: 'smooth', label: '顺滑' }, { value: 'snap', label: '利落' }] }
        ]
      },
      {
        title: '文字', fields: [
          { key: 'glow', type: 'number', label: '发光强度', min: 0, max: 2, step: 0.05, defaultValue: 0.7 },
          { key: 'titleScale', type: 'number', label: '大标题比例', min: 0.8, max: 1.8, step: 0.05, defaultValue: 1 }
        ]
      }
    ],
    'folia-cappella': [
      {
        title: '角色与表情', fields: [
          { key: 'showEmoji', type: 'boolean', label: '显示表情包', defaultValue: true },
          { key: 'avatarSource', type: 'select', label: '头像来源', defaultValue: 'builtin', options: [{ value: 'builtin', label: '内置角色' }, { value: 'theme', label: '主题配色' }, { value: 'cover', label: '封面图片' }, { value: 'custom', label: '自定义图片' }] },
          { key: 'customAvatar', type: 'file', label: '上传自定义头像', accept: 'image/*' },
          { key: 'clearAvatar', type: 'action', action: 'clear', target: 'customAvatar', label: '清空自定义头像' },
          { key: 'emojiSource', type: 'select', label: '表情包来源', defaultValue: 'builtin', options: [{ value: 'builtin', label: '内置表情' }, { value: 'custom', label: '自定义图片' }] },
          { key: 'customEmoji', type: 'file', label: '上传自定义表情包', accept: 'image/*' },
          { key: 'clearEmoji', type: 'action', action: 'clear', target: 'customEmoji', label: '清空自定义表情包' }
        ]
      }
    ],
    'folia-tilt': [
      {
        title: '倾诉参数', fields: [
          { key: 'colorMode', type: 'select', label: '配色方案', defaultValue: 'duo', options: [{ value: 'duo', label: '主题双色' }, { value: 'mono', label: '单色' }, { value: 'gradient', label: '渐变' }] },
          { key: 'breakChance', type: 'number', label: '分行概率', min: 0, max: 1, step: 0.05, defaultValue: 0.75 },
          { key: 'italicChance', type: 'number', label: '斜体强调概率', min: 0, max: 1, step: 0.05, defaultValue: 0.35 }
        ]
      }
    ],
    'folia-monet': [
      {
        title: '歌词与排版', fields: [
          { key: 'fontScale', type: 'number', label: '字体缩放', min: 0.7, max: 1.4, step: 0.05, defaultValue: 1 },
          { key: 'keyword', type: 'boolean', label: '关键字着色', defaultValue: true },
          { key: 'showDesc', type: 'boolean', label: '显示歌曲描述', defaultValue: false }
        ]
      },
      {
        title: '肖像展示', fields: [
          { key: 'portraitSource', type: 'select', label: '右侧肖像来源', defaultValue: 'cover', options: [{ value: 'cover', label: '封面' }, { value: 'custom', label: '自定义图片' }] },
          { key: 'coverShape', type: 'select', label: '封面形状', defaultValue: 'tall', options: [{ value: 'tall', label: '长幅构图' }, { value: 'square', label: '方形构图' }] },
          { key: 'portraitDragOn', type: 'boolean', label: '拖拽调整按钮', defaultValue: false },
          { key: 'customPortrait', type: 'file', label: '上传肖像图', accept: 'image/*' },
          { key: 'clearPortrait', type: 'action', action: 'clear', target: 'customPortrait', label: '清空肖像图' }
        ]
      },
      {
        title: '频谱反馈', fields: [
          { key: 'audioBars', type: 'boolean', label: '音频图案', defaultValue: true },
          { key: 'barStyle', type: 'select', label: '频谱样式', defaultValue: 'bars', options: [{ value: 'bars', label: '柱状' }, { value: 'lines', label: '线条' }] }
        ]
      },
      {
        title: '背景来源', fields: [
          { key: 'backgroundSource', type: 'select', label: '背景来源', defaultValue: 'cover', options: [{ value: 'cover', label: '封面' }, { value: 'custom', label: '自定义图片' }] },
          { key: 'customBackground', type: 'file', label: '上传背景图', accept: 'image/*' },
          { key: 'clearBackground', type: 'action', action: 'clear', target: 'customBackground', label: '清空背景图' }
        ]
      },
      {
        title: '布局与对齐', fields: [
          { key: 'layoutMode', type: 'select', label: '布局模式', defaultValue: 'full', options: [{ value: 'half', label: '半屏渐变' }, { value: 'full', label: '全屏叠色' }] },
          { key: 'imageOffset', type: 'number', label: '图片水平偏移', min: -30, max: 30, step: 1, defaultValue: 0 }
        ]
      },
      {
        title: '视觉增强与滤镜', fields: [
          { key: 'blur', type: 'number', label: '背景模糊', min: 0, max: 40, step: 1, defaultValue: 18 },
          { key: 'saturation', type: 'number', label: '饱和度', min: 0, max: 2, step: 0.05, defaultValue: 1.1 },
          { key: 'desaturate', type: 'number', label: '去色', min: 0, max: 1, step: 0.05, defaultValue: 0 },
          { key: 'themeTint', type: 'number', label: '主题叠色强度', min: 0, max: 1, step: 0.05, defaultValue: 0.3 },
          { key: 'wash', type: 'boolean', label: '水洗重着色', defaultValue: false },
          { key: 'washSource', type: 'select', label: '水洗色彩', defaultValue: 'theme', options: [{ value: 'theme', label: '主题色' }, { value: 'custom', label: '自定义' }] },
          { key: 'washColor', type: 'color', label: '自定义水洗色', defaultValue: '#5f7cff' }
        ]
      }
    ],
    'folia-claddagh': [
      {
        title: '回环参数', fields: [
          { key: 'focusScale', type: 'number', label: '主歌词放大倍率', min: 1, max: 1.8, step: 0.05, defaultValue: 1.25 },
          { key: 'radius', type: 'number', label: '轨道半径', min: 0.2, max: 0.55, step: 0.01, defaultValue: 0.42 },
          { key: 'tilt', type: 'number', label: '轨道倾斜度', min: -90, max: 90, step: 1, defaultValue: 45 },
          { key: 'letterGap', type: 'number', label: '字符间距', min: 0, max: 12, step: 0.5, defaultValue: 0 },
          { key: 'axis', type: 'boolean', label: '中间轴线', defaultValue: true }
        ]
      }
    ],
    'folia-diorama': [
      {
        title: '场景与镜头', fields: [
          { key: 'geometry', type: 'select', label: '几何形态', defaultValue: 'points', options: [{ value: 'points', label: '点云' }, { value: 'corridor', label: '长廊' }] },
          { key: 'shape', type: 'select', label: '点云几何', defaultValue: 'ring', options: [{ value: 'ring', label: '圆环' }, { value: 'cylinder', label: '圆柱体' }, { value: 'cube', label: '立方体' }, { value: 'crystal', label: '三角晶体' }] },
          { key: 'cameraSpeed', type: 'number', label: '镜头速度', min: 0.1, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'motion', type: 'number', label: '运动幅度', min: 0, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'bgParticles', type: 'boolean', label: '背景粒子', defaultValue: true }
        ]
      },
      {
        title: '点云外观', fields: [
          { key: 'density', type: 'number', label: '点云密度', min: 0.3, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'ringDensity', type: 'number', label: '圆周密度', min: 0.3, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'radialDensity', type: 'number', label: '径向密度', min: 0.3, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'volume', type: 'number', label: '点云整体体积', min: 0.5, max: 2.5, step: 0.05, defaultValue: 1 },
          { key: 'glow', type: 'boolean', label: '点云整体辉光', defaultValue: true },
          { key: 'glowStrength', type: 'number', label: '辉光强度', min: 0, max: 2, step: 0.05, defaultValue: 0.8 },
          { key: 'audioResponse', type: 'boolean', label: '点云音频响应', defaultValue: true }
        ]
      },
      {
        title: '歌词特效', fields: [
          { key: 'keyword', type: 'boolean', label: '关键字着色', defaultValue: true },
          { key: 'glowFollow', type: 'boolean', label: '普通辉光跟唱', defaultValue: true },
          { key: 'gradientFollow', type: 'boolean', label: '渐变跟唱', defaultValue: false },
          { key: 'soulFollow', type: 'boolean', label: '灵魂出窍跟唱', defaultValue: false },
          { key: 'charSoul', type: 'boolean', label: '当前字出窍', defaultValue: false },
          { key: 'strength', type: 'select', label: '强度', defaultValue: 'mid', options: [{ value: 'weak', label: '弱' }, { value: 'mid', label: '中' }, { value: 'strong', label: '强' }, { value: 'custom', label: '自定义' }] },
          { key: 'customStrength', type: 'number', label: '自定义强度', min: 0, max: 2, step: 0.05, defaultValue: 1 }
        ]
      }
    ],
    'folia-pendolo': [
      {
        title: '轮盘与刻度', fields: [
          { key: 'wheelX', type: 'number', label: '轮盘水平位置', min: 0, max: 100, step: 1, defaultValue: 0 },
          { key: 'wheelR', type: 'number', label: '轮盘半径', min: 0.12, max: 0.35, step: 0.01, defaultValue: 0.3 },
          { key: 'arc', type: 'number', label: '弧度角度', min: 40, max: 160, step: 10, defaultValue: 100 },
          { key: 'focusScale', type: 'number', label: '聚焦句缩放', min: 1, max: 1.8, step: 0.05, defaultValue: 1.25 },
          { key: 'escapement', type: 'number', label: '擒纵咬合力度', min: 0, max: 1, step: 0.05, defaultValue: 0.4 }
        ]
      },
      {
        title: '机械与表盘', fields: [
          { key: 'gearStyle', type: 'select', label: '机械齿轮饰线', defaultValue: 'half', options: [{ value: 'none', label: '无' }, { value: 'half', label: '半透明' }, { value: 'full', label: '完整' }] },
          { key: 'centerGradient', type: 'boolean', label: '齿轮中央深色渐变', defaultValue: true },
          { key: 'showCover', type: 'boolean', label: '表盘显示专辑封面', defaultValue: true },
          { key: 'lineGlow', type: 'boolean', label: '线条发光效果', defaultValue: true }
        ]
      }
    ],
    'folia-sonnet': [
      {
        title: '显示内容', fields: [
          { key: 'showMain', type: 'boolean', label: '主场景', defaultValue: true },
          { key: 'decorations', type: 'boolean', label: '背景装饰', defaultValue: true },
          { key: 'lineDensity', type: 'number', label: '背景短线密度', min: 0, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'floatingText', type: 'boolean', label: '文字浮标', defaultValue: true },
          { key: 'hollowTitle', type: 'boolean', label: '巨型装饰镂空文字', defaultValue: true },
          { key: 'trail', type: 'boolean', label: '轨迹线', defaultValue: true },
          { key: 'frameStyle', type: 'select', label: '外层边框', defaultValue: 'frame', options: [{ value: 'full', label: '完全显示' }, { value: 'frame', label: '仅框架' }, { value: 'none', label: '完全隐藏' }] },
          { key: 'textOnly', type: 'boolean', label: '仅显示文字', defaultValue: false }
        ]
      },
      {
        title: '动态与构图', fields: [
          { key: 'cameraMotion', type: 'number', label: '镜头运动强度', min: 0, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'textMotion', type: 'number', label: '文字动势', min: 0, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'sceneTransition', type: 'boolean', label: '场景转场', defaultValue: true }
        ]
      },
      {
        title: '后处理', fields: [
          { key: 'postFx', type: 'boolean', label: '整体后处理滤镜', defaultValue: true },
          { key: 'vignette', type: 'boolean', label: '暗角', defaultValue: true },
          { key: 'grain', type: 'boolean', label: '胶片颗粒', defaultValue: true },
          { key: 'halftone', type: 'boolean', label: '半调网点', defaultValue: false },
          { key: 'contrast', type: 'boolean', label: '对比度增强', defaultValue: true },
          { key: 'rgbShift', type: 'boolean', label: 'RGB 色差', defaultValue: false },
          { key: 'lensDistort', type: 'boolean', label: '透镜扭曲', defaultValue: false },
          { key: 'lensDispersion', type: 'boolean', label: '透镜色散', defaultValue: false }
        ]
      },
      {
        title: '渲染质量', fields: [
          { key: 'textureRes', type: 'select', label: '纹理分辨率', defaultValue: '1', options: [{ value: '1', label: '1x' }, { value: '1.5', label: '1.5x' }, { value: '2', label: '2x' }] }
        ]
      }
    ],
    'folia-tempera': [
      {
        title: '动态与调色', fields: [
          { key: 'cameraMotion', type: 'number', label: '镜头运动强度', min: 0, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'charMotion', type: 'number', label: '逐字动势', min: 0, max: 2, step: 0.05, defaultValue: 1 },
          { key: 'charTiming', type: 'number', label: '逐字入场时序', min: 0, max: 1, step: 0.05, defaultValue: 0.5 },
          { key: 'colorMode', type: 'select', label: '色彩模式', defaultValue: 'duo', options: [{ value: 'duo', label: '主题双色' }, { value: 'mono', label: '黑白灰' }, { value: 'gradient', label: '封面渐变' }] }
        ]
      },
      {
        title: '显示内容', fields: [
          { key: 'blocks', type: 'boolean', label: '色块场景', defaultValue: true },
          { key: 'decorations', type: 'boolean', label: '装饰元素', defaultValue: true },
          { key: 'invert', type: 'boolean', label: '文字动态反色', defaultValue: true },
          { key: 'sceneTransition', type: 'boolean', label: '场景转场', defaultValue: true },
          { key: 'wholeLine', type: 'boolean', label: '整句显示歌词', defaultValue: true }
        ]
      },
      {
        title: '画布图片池', fields: [
          { key: 'imagePool', type: 'imagePool', label: '图片池' },
          { key: 'imageFrequency', type: 'number', label: '出现频率', min: 0, max: 1, step: 0.05, defaultValue: 0.3 },
          { key: 'imageAlign', type: 'alignGrid', label: '对齐倾向', defaultValue: 'random', options: [
            { value: 'random', label: '九宫格随机' },
            { value: 'randomH', label: '横向随机' },
            { value: 'randomV', label: '纵向随机' },
            { value: 'tl', label: '左上' }, { value: 'tc', label: '中上' }, { value: 'tr', label: '右上' },
            { value: 'ml', label: '左中' }, { value: 'mc', label: '正中' }, { value: 'mr', label: '右中' },
            { value: 'bl', label: '左下' }, { value: 'bc', label: '中下' }, { value: 'br', label: '右下' }
          ] },
          { key: 'imageSize', type: 'number', label: '大小', min: 0.2, max: 1.2, step: 0.05, defaultValue: 0.5 },
          { key: 'imageOpacity', type: 'number', label: '不透明度', min: 0, max: 1, step: 0.05, defaultValue: 0.6 },
          { key: 'imageLayer', type: 'select', label: '图层位置', defaultValue: 'below', options: [{ value: 'below', label: '歌词之前' }, { value: 'above', label: '歌词之后' }] },
          { key: 'exportPool', type: 'action', action: 'exportPool', label: '导出备份（zip）' },
          { key: 'importPool', type: 'action', action: 'importPool', label: '导入备份（替换）' },
          { key: 'appendPool', type: 'action', action: 'appendPool', label: '追加备份' }
        ]
      },
      {
        title: '后处理与渲染质量', fields: [
          { key: 'postFx', type: 'boolean', label: '整体后处理滤镜', defaultValue: true },
          { key: 'grain', type: 'boolean', label: '胶片颗粒', defaultValue: true },
          { key: 'contrast', type: 'boolean', label: '对比度增强', defaultValue: true },
          { key: 'rgbShift', type: 'boolean', label: 'RGB 色差', defaultValue: false },
          { key: 'vignette', type: 'boolean', label: '暗角', defaultValue: true },
          { key: 'lensDistort', type: 'boolean', label: '透镜扭曲', defaultValue: false },
          { key: 'textureCompress', type: 'boolean', label: '后处理纹理压缩', defaultValue: true },
          { key: 'textureRes', type: 'select', label: '纹理分辨率', defaultValue: '1', options: [{ value: '1', label: '1x' }, { value: '1.5', label: '1.5x' }, { value: '2', label: '2x' }] }
        ]
      }
    ]
  };

  var FONT_STACKS = {
    sans: '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    serif: 'Georgia, "Songti SC", "SimSun", serif',
    rounded: '"Yuanti SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    mono: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
  };

  function load() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        common: raw.common || {},
        modes: raw.modes || {}
      };
    } catch (e) {
      return { common: {}, modes: {} };
    }
  }

  function save() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* 图片过大时仅保留内存值 */ }
  }

  function clampField(field, value) {
    if (field.type === 'number') {
      var n = Number(value);
      if (!isFinite(n)) n = field.defaultValue || 0;
      if (field.min != null) n = Math.max(field.min, n);
      if (field.max != null) n = Math.min(field.max, n);
      return n;
    }
    if (field.type === 'boolean') return !!value;
    if (field.type === 'select') {
      var vals = (field.options || []).map(function (o) { return o.value; });
      return vals.indexOf(String(value)) >= 0 ? String(value) : String(field.defaultValue);
    }
    if (field.type === 'color') {
      return (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) ? value.toLowerCase() : (field.defaultValue || '#5f7cff');
    }
    return value == null ? '' : value;
  }

  function defaultsFor(schema) {
    var out = {};
    schema.forEach(function (section) {
      (section.fields || []).forEach(function (f) {
        if (f.type === 'action') return;
        if (f.type === 'imagePool') { out[f.key] = []; return; }
        out[f.key] = f.defaultValue;
      });
    });
    return out;
  }

  var modeDefaults = {};
  Object.keys(MODE_SCHEMAS).forEach(function (id) {
    modeDefaults[id] = defaultsFor(MODE_SCHEMAS[id]);
  });

  // 模组注册的附加参数（如 k3panel 给商籁加的倍率），按 modeId → groupId 存放
  var EXTERNAL = {};

  function combinedSchema(modeId) {
    var base = MODE_SCHEMAS[modeId] || [];
    var ext = EXTERNAL[modeId];
    if (!ext) return base.length ? base : null;
    var out = base.slice();
    Object.keys(ext).forEach(function (id) { out.push(ext[id]); });
    return out;
  }

  function rebuildDefaults(modeId) {
    var schema = combinedSchema(modeId);
    if (!schema) { delete modeDefaults[modeId]; return; }
    modeDefaults[modeId] = defaultsFor(schema);
  }

  function registerExternal(modeId, groupId, group) {
    if (!modeId || !groupId || !group) return;
    if (!EXTERNAL[modeId]) EXTERNAL[modeId] = {};
    EXTERNAL[modeId][groupId] = group;
    rebuildDefaults(modeId);
    bump(modeId);
  }

  function unregisterExternal(modeId, groupId) {
    if (!EXTERNAL[modeId] || !EXTERNAL[modeId][groupId]) return;
    delete EXTERNAL[modeId][groupId];
    if (!Object.keys(EXTERNAL[modeId]).length) delete EXTERNAL[modeId];
    rebuildDefaults(modeId);
    bump(modeId);
  }

  function getCommon() {
    var out = {};
    COMMON_SCHEMA.forEach(function (f) {
      out[f.key] = Object.prototype.hasOwnProperty.call(store.common, f.key)
        ? clampField(f, store.common[f.key]) : f.defaultValue;
    });
    return out;
  }

  function get(modeId) {
    var def = modeDefaults[modeId];
    if (!def) return {};
    var saved = store.modes[modeId] || {};
    var out = {};
    Object.keys(def).forEach(function (k) {
      out[k] = Object.prototype.hasOwnProperty.call(saved, k) ? saved[k] : def[k];
    });
    return out;
  }

  function bump(modeId) {
    versions[modeId] = (versions[modeId] || 0) + 1;
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](modeId || 'common'); } catch (e) { /* ignore */ }
    }
  }

  function setCommon(key, value) {
    var field = null;
    COMMON_SCHEMA.forEach(function (f) { if (f.key === key) field = f; });
    if (!field) return;
    store.common[key] = clampField(field, value);
    save();
    bump(null);
  }

  function set(modeId, key, value) {
    var def = modeDefaults[modeId];
    if (!def) return;
    var field = null;
    (combinedSchema(modeId) || []).forEach(function (section) {
      (section.fields || []).forEach(function (f) { if (f.key === key) field = f; });
    });
    if (!field || field.type === 'action') return;
    if (!store.modes[modeId]) store.modes[modeId] = {};
    store.modes[modeId][key] = field.type === 'imagePool' ? (value || []) : clampField(field, value);
    save();
    bump(modeId);
  }

  function reset(modeId) {
    if (modeId) delete store.modes[modeId];
    else store.common = {};
    save();
    bump(modeId || null);
  }

  function onChange(cb) {
    listeners.push(cb);
    return function () {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function fontStack() {
    return FONT_STACKS[getCommon().font] || FONT_STACKS.sans;
  }

  function schemaFor(modeId) {
    return combinedSchema(modeId);
  }

  function hasMode(modeId) {
    return !!combinedSchema(modeId);
  }

  return {
    commonSchema: COMMON_SCHEMA,
    schemaFor: schemaFor,
    hasMode: hasMode,
    getCommon: getCommon,
    get: get,
    setCommon: setCommon,
    set: set,
    reset: reset,
    onChange: onChange,
    registerExternal: registerExternal,
    unregisterExternal: unregisterExternal,
    fontStack: fontStack,
    version: function (modeId) { return versions[modeId] || 0; }
  };
})();
