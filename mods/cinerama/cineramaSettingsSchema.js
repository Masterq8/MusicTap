// mods/cinerama/cineramaSettingsSchema.mjs
// 巨幕的旋钮 schema：交给 Folium 宿主渲染表单、校验、持久化，并随视觉配置一起导入导出。
//
// 旋钮的 key / 范围 / 缺省 / 枚举都来自 cineramaOptions.mjs（解算层的唯一真源），
// 这里只补文案与分组——两边硬编码两份就会漂移成「面板显示缺省、画面却是另一个数」。
// 分组照「用户要调什么」排：先决定这一幕由哪几种排版轮着来，再决定字怎么处理、长什么样，
// 最后才是两条叠加上去的东西（跑马灯带、斜切丝带）。

import {
    CINERAMA_HERO_FILL_AXIS_VALUES,
    CINERAMA_MARQUEE_EDGE_COLOR_VALUES,
    CINERAMA_MARQUEE_EDGE_SIDES_VALUES,
    CINERAMA_MARQUEE_EDGE_VALUES,
    CINERAMA_MARQUEE_FILL_COLOR_VALUES,
    CINERAMA_MARQUEE_FILL_VALUES,
    CINERAMA_MARQUEE_VALUES,
} from './cineramaOptions.js';

// 多选一的取值直接引用解算层的枚举，不给字面量：漂移时选项会少一个，
// 总比给出一个解算层不认的值强（面板写进去，画面回落缺省）。
const CHOICE_OPTIONS = {
    marquee: CINERAMA_MARQUEE_VALUES,
    marqueeFill: CINERAMA_MARQUEE_FILL_VALUES,
    marqueeFillColor: CINERAMA_MARQUEE_FILL_COLOR_VALUES,
    marqueeEdge: CINERAMA_MARQUEE_EDGE_VALUES,
    marqueeEdgeColor: CINERAMA_MARQUEE_EDGE_COLOR_VALUES,
    marqueeEdgeSides: CINERAMA_MARQUEE_EDGE_SIDES_VALUES,
    heroFillAxis: CINERAMA_HERO_FILL_AXIS_VALUES,
};

// 取值文案：与枚举顺序一一对应，只写文案（值从 CHOICE_OPTIONS 取）。
const CHOICE_LABELS = {
    heroFillAxis: {
        both: {
            "zh-CN": "自动",
            en: "Auto"
        },
        x: {
            "zh-CN": "水平",
            en: "Horizontal"
        },
        y: {
            "zh-CN": "竖直",
            en: "Vertical"
        }
    },
    marquee: {
        off: {
            "zh-CN": "关",
            en: "Off"
        },
        auto: {
            "zh-CN": "自动",
            en: "Auto"
        },
        bands: {
            "zh-CN": "双带",
            en: "Two bands"
        },
        frame: {
            "zh-CN": "四边",
            en: "Four sides"
        }
    },
    marqueeFill: {
        none: {
            "zh-CN": "不填色",
            en: "None"
        },
        tint: {
            "zh-CN": "淡色底",
            en: "Tint"
        }
    },
    marqueeFillColor: {
        accent: {
            "zh-CN": "强调色",
            en: "Accent"
        },
        secondary: {
            "zh-CN": "辅助色",
            en: "Secondary"
        }
    },
    marqueeEdge: {
        none: {
            "zh-CN": "不画边",
            en: "None"
        },
        solid: {
            "zh-CN": "实线",
            en: "Solid"
        },
        glow: {
            "zh-CN": "辉光",
            en: "Glow"
        }
    },
    marqueeEdgeColor: {
        auto: {
            "zh-CN": "跟随",
            en: "Auto"
        },
        accent: {
            "zh-CN": "强调色",
            en: "Accent"
        },
        secondary: {
            "zh-CN": "辅助色",
            en: "Secondary"
        }
    },
    marqueeEdgeSides: {
        inner: {
            "zh-CN": "内侧",
            en: "Inner"
        },
        both: {
            "zh-CN": "双侧",
            en: "Both"
        }
    }
};

// 分组标题与提示。
const GROUPS = {
    "内容与概率": {
        "title": {
            "zh-CN": "内容与概率",
            "en": "Content & odds"
        },
        "hint": {
            "zh-CN": "屏幕上出现什么，以及各占多少。排版本体每句按三项之比抽一个，排版落点同理：只看比例，不必加起来是 1；拖到 0 就是不再出现它。",
            "en": "What appears on screen, and in what proportion. A layout body is drawn per line from the three weights, and the placement weights work the same way: only the ratio matters, and they need not add up to 1. Drag one to 0 to drop it."
        }
    },
    "歌词处理": {
        "title": {
            "zh-CN": "歌词处理",
            "en": "Lyric treatment"
        },
        "hint": {
            "zh-CN": "整首歌词怎么被切分与处理。前三项每句掷点，同一首歌每次播放结果一致。",
            "en": "How the lyrics get split and treated. The first three are drawn per line and stay identical across replays of the same song."
        }
    },
    "文字样式": {
        "title": {
            "zh-CN": "文字样式",
            "en": "Type style"
        },
        "hint": {
            "zh-CN": "大字报与小字报共用的一份字形与疏密，1 就是设计默认。斜切丝带与跑马灯带上的字另有自己的尺度，不受这组影响。",
            "en": "One shared type treatment for hero and small type, where 1 is the design default. Ribbon and marquee text keep their own scales and are not affected."
        }
    },
    "跑马灯带": {
        "title": {
            "zh-CN": "跑马灯带",
            "en": "Marquee bands"
        },
        "hint": {
            "zh-CN": "叠加大字报与小字报的一层，斜切丝带不与它同现。可以是一条横带，也可以绕屏一圈。",
            "en": "A layer added on top of hero and small type, never combined with ribbons. Either two bands across the screen or one ring around it."
        }
    },
    "斜切丝带": {
        "title": {
            "zh-CN": "斜切丝带",
            "en": "Ribbons"
        },
        "hint": {
            "zh-CN": "抽到斜切丝带时这一叠胶带长什么样。丝带整句上带、自己上下漂移，文字沿带滚动，两个速度互不牵动。",
            "en": "What the tape stack looks like when the ribbon body is drawn. A whole line per ribbon; the stack drifts up and down while the text scrolls along it, and the two speeds are independent."
        }
    }
};

export const CINERAMA_SETTINGS_SCHEMA = [
    {
        key: "heroWeight",
        type: 'number',
        group: GROUPS["内容与概率"].title,
        label: {"zh-CN":"大字报","en":"Hero type"},
        description: {"zh-CN":"整行按词切块、逐块闪现，每块都在屏内。","en":"The line is cut into word chunks and flashes chunk by chunk; every chunk stays on screen."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.4,
    },
    {
        key: "smallWeight",
        type: 'number',
        group: GROUPS["内容与概率"].title,
        label: {"zh-CN":"小字报","en":"Small type"},
        description: {"zh-CN":"兜底样式，任何行都排得下，整行一个字号。","en":"The fallback: any line fits, one size for the whole line."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.2,
    },
    {
        key: "ribbonWeight",
        type: 'number',
        group: GROUPS["内容与概率"].title,
        label: {"zh-CN":"斜切丝带","en":"Ribbons"},
        description: {"zh-CN":"整句上带、斜切拼贴，不与跑马灯带同现。","en":"The whole line on skewed ribbons; never shown together with the marquee."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.4,
    },
    {
        key: "layoutEarlyWeight",
        type: 'number',
        group: GROUPS["内容与概率"].title,
        label: {"zh-CN":"偏置落点","en":"Off-centre placement"},
        description: {"zh-CN":"上/下三分之一、左右两栏这几档合在一起的权重。它们都离开画面正中，给多了整屏居中的那一档就少。","en":"Weight of the upper / lower third and the left / right bands grouped together. They all leave the centre, so more of them means fewer fully-centred lines."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 1,
    },
    {
        key: "layoutLetterboxWeight",
        type: 'number',
        group: GROUPS["内容与概率"].title,
        label: {"zh-CN":"宽银幕字幕条","en":"Letterbox strip"},
        description: {"zh-CN":"电影字幕那一档：字号更小、字距更宽，压在屏体下缘。","en":"The cinema-subtitle tier: smaller type, wider tracking, pressed against the bottom edge."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.5,
    },
    {
        key: "heroChunkChance",
        type: 'number',
        group: GROUPS["歌词处理"].title,
        label: {"zh-CN":"并词强度","en":"Word-join"},
        description: {"zh-CN":"大字报按词分词，收一个词后按此概率再并下一个。0 最碎，一词一闪；1 装得下就并到底。","en":"Hero type segments by word: after each word it keeps joining at this chance. 0 is the most fragmented, one word per flash; 1 joins while it fits."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.55,
    },
    {
        key: "unitStagger",
        type: 'number',
        group: GROUPS["歌词处理"].title,
        label: {"zh-CN":"逐段落位节奏","en":"Segment cadence"},
        description: {"zh-CN":"整行各段落位的快慢。调大各段叠得多，像一道扫过去；调小一段一段点着来。不改出词的时刻。","en":"How fast the segments settle in. Higher overlaps them into one sweep, lower ticks them out one by one. The moments themselves never move."},
        min: 0.4,
        max: 2,
        step: 0.05,
        defaultValue: 0.6,
    },
    {
        key: "heroMotion",
        type: 'number',
        group: GROUPS["歌词处理"].title,
        label: {"zh-CN":"块级运动强度","en":"Chunk motion"},
        description: {"zh-CN":"大字报每块挂住时的持续动作幅度：推近、拉远、横移、摊开一起缩。0 落定后完全不动，1 是设计默认。填色的块本来就不动。","en":"Amplitude of the sustained per-chunk motion: push, pull, slide and spread scale together. 0 freezes chunks once settled, 1 is the design default. Filled chunks never move anyway."},
        min: 0,
        max: 1.5,
        step: 0.05,
        defaultValue: 1,
    },
    {
        key: "heroFillAxis",
        type: 'select',
        group: GROUPS["歌词处理"].title,
        label: {"zh-CN":"填色方向","en":"Fill direction"},
        description: {"zh-CN":"大字报填色推进的方向。自动按块抽横或竖，相邻两块不重复；钉死之后整首只走一个方向。","en":"Direction the fill sweeps. Auto draws it per chunk, horizontal or vertical and never twice in a row; pinning it locks the whole song to one direction."},
        defaultValue: "both",
        options: CHOICE_OPTIONS.heroFillAxis.map((value) => ({ value, label: CHOICE_LABELS.heroFillAxis[value] })),
    },
    {
        key: "fillChance",
        type: 'number',
        group: GROUPS["歌词处理"].title,
        label: {"zh-CN":"填色概率","en":"Fill odds"},
        description: {"zh-CN":"填色的出现概率倍率，1 是设计默认，本来就只在长块上偶尔出现。拖到 0 整首不填色，那些块改做运动。","en":"Multiplier on the odds of the fill, which is already rare and only on longer chunks at the design default of 1. At 0 nothing fills and those chunks take a motion instead."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 1,
    },
    {
        key: "fontScale",
        type: 'number',
        group: GROUPS["文字样式"].title,
        label: {"zh-CN":"字号","en":"Type size"},
        description: {"zh-CN":"在不把词挤出屏的安全字号上再乘一次。调大就可能出屏，大字报被裁掉、小字报顶上屏沿，这是刻意的：安全字号是保底不是上限。","en":"Multiplies the safe size that keeps every chunk on screen. Going over 1 can overflow, clipping hero chunks or pushing small type into the edge, and that is on purpose: the safe size is a floor, not a cap."},
        min: 0.8,
        max: 1.3,
        step: 0.02,
        defaultValue: 1,
    },
    {
        key: "letterSpacing",
        type: 'number',
        group: GROUPS["文字样式"].title,
        label: {"zh-CN":"字距","en":"Tracking"},
        description: {"zh-CN":"字与字之间多松。整块会跟着变宽，拖大之后字号可能要收一点。","en":"How loose the glyphs sit. The block widens with it, so you may want to pull the type size back when raising it."},
        min: 0.6,
        max: 1.6,
        step: 0.05,
        defaultValue: 1,
    },
    {
        key: "lineHeight",
        type: 'number',
        group: GROUPS["文字样式"].title,
        label: {"zh-CN":"行距","en":"Line height"},
        description: {"zh-CN":"折行时两行之间多紧。调小两行贴得更近，长句折出的几行收成一块密字。","en":"How tight wrapped lines sit. Lower pulls them together, so a long line reads as one dense block."},
        min: 0.85,
        max: 1.25,
        step: 0.01,
        defaultValue: 1,
    },
    {
        key: "italicChance",
        type: 'number',
        group: GROUPS["文字样式"].title,
        label: {"zh-CN":"斜体比例","en":"Italics"},
        description: {"zh-CN":"大字报里有多少块用斜体，按块抽，0 是一块都不斜。中文字体没有真斜体，浏览器只能合成倾斜，开高会读成渲染出错。","en":"Share of hero chunks drawn in italic, drawn per chunk. 0 means none. CJK has no true italic face, so the browser synthesises the slant, and turning this up reads as a rendering bug."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.35,
    },
    {
        key: "marquee",
        type: 'select',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"带型","en":"Bands"},
        description: {"zh-CN":"自动按句抽双带或四边，同一首歌每次一致。怀疑某一档没出现时，直接选它即可验证。","en":"Auto draws two bands or the ring per line, stable across replays. Pick one explicitly to force it for verification."},
        defaultValue: "auto",
        options: CHOICE_OPTIONS.marquee.map((value) => ({ value, label: CHOICE_LABELS.marquee[value] })),
    },
    {
        key: "marqueeSpeed",
        type: 'number',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"带速","en":"Band speed"},
        description: {"zh-CN":"带上文字横向滚动的速度。与歌词长短无关，短句长句一样快。","en":"How fast the band text scrolls. Independent of lyric length: short and long lines move alike."},
        min: 0.2,
        max: 3,
        step: 0.05,
        defaultValue: 1,
    },
    {
        key: "marqueeBandPct",
        type: 'number',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"带高（屏高%）","en":"Band height (% of screen)"},
        description: {"zh-CN":"固定值，不随歌词变化。双带各占这么多，四边四条边都占。","en":"Fixed, and does not follow the lyric. Each of the two bands takes this much; the ring takes it on all four sides."},
        min: 6,
        max: 20,
        step: 0.5,
        defaultValue: 12,
    },
    {
        key: "marqueeFontRatio",
        type: 'number',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"带内字高（占带高）","en":"Text size (of band height)"},
        description: {"zh-CN":"固定值，按带高的比例取字号，长短句不会忽大忽小。","en":"Fixed as a share of the band height, so it never jumps between lines."},
        min: 0.3,
        max: 0.8,
        step: 0.05,
        defaultValue: 0.55,
    },
    {
        key: "marqueeTitleChance",
        type: 'number',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"歌名出现概率","en":"Song-title odds"},
        description: {"zh-CN":"带上跑当前行、译文还是歌曲标题，这一项是歌名被抽中的系数。歌名是装饰，默认压得比较低。","en":"What runs on the band: the line, the translation or the song title. This is the title's share, and being a decoration it defaults low."},
        min: 0,
        max: 1,
        step: 0.05,
        defaultValue: 0.25,
    },
    {
        key: "marqueeFill",
        type: 'select',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"带身填色","en":"Band fill"},
        description: {"zh-CN":"带子那块区域着不着色。默认不填：带子本身就是屏体，靠边线那道灯与带上的字读出来，铺色底反而会压成一块色条。","en":"Whether the band area is tinted. Off by default: the band is the screen itself, read from its edge light and the text, while a wash flattens it into a coloured bar."},
        defaultValue: "none",
        options: CHOICE_OPTIONS.marqueeFill.map((value) => ({ value, label: CHOICE_LABELS.marqueeFill[value] })),
    },
    {
        key: "marqueeFillColor",
        type: 'select',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"填色色彩","en":"Fill color"},
        description: {"zh-CN":"淡色底取哪个色轴。强调色是底与带上的字同一个光源，辅助色是两层。只影响填色，不动边线。","en":"Which color axis the fill uses. Accent puts the fill and the band text under one light source, secondary splits them into two layers. Fill only; the edge is separate."},
        defaultValue: "accent",
        options: CHOICE_OPTIONS.marqueeFillColor.map((value) => ({ value, label: CHOICE_LABELS.marqueeFillColor[value] })),
    },
    {
        key: "marqueeEdge",
        type: 'select',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"边线","en":"Band edge"},
        description: {"zh-CN":"带子那两条长边怎么画。实线是 1px 硬边，勾出范围；辉光只有光晕没有硬边。","en":"How the band's long edges are drawn. Solid is a 1px hairline that outlines the band; glow is a halo with no hairline."},
        defaultValue: "glow",
        options: CHOICE_OPTIONS.marqueeEdge.map((value) => ({ value, label: CHOICE_LABELS.marqueeEdge[value] })),
    },
    {
        key: "marqueeGlow",
        type: 'number',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"边线辉光","en":"Edge glow"},
        description: {"zh-CN":"边子那道灯的强度：缩放亮芯与光晕的扩散，缺省 0.3 就够浓。0 整档淡出，1 各层满扩散。不管带上的字。","en":"Strength of the lamp along the edge: how far the bright core and halo spread. 0.3 already reads; 0 fades it out, 1 is full spread. Does not touch the text."},
        min: 0,
        max: 1.5,
        step: 0.05,
        defaultValue: 0.3,
    },
    {
        key: "marqueeTextGlow",
        type: 'number',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"文字辉光","en":"Text glow"},
        description: {"zh-CN":"带上的字那圈同色光的大小与浓度。缺省 0.2 只留一点弱影：带子的亮主要来自边线那道灯。拖到 2 字自己在发光。","en":"Size and density of the same-colour glow around the band text. The 0.2 default keeps only a faint halo, since the edge lamp carries the brightness; 2 makes the text glow on its own."},
        min: 0,
        max: 2,
        step: 0.05,
        defaultValue: 0.2,
    },
    {
        key: "marqueeEdgeColor",
        type: 'select',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"边线色彩","en":"Edge color"},
        description: {"zh-CN":"边线取哪个色轴。跟随是实线取辅助色、辉光取强调色，即旧观感。亮色主题下辉光是一道压进屏面的暗槽，槽色由这一轴压暗而成。","en":"Which color axis the edge uses. Auto gives the hairline the secondary color and the glow the accent, matching the previous look. On light themes the glow is a pressed groove whose colour is this axis darkened."},
        defaultValue: "auto",
        options: CHOICE_OPTIONS.marqueeEdgeColor.map((value) => ({ value, label: CHOICE_LABELS.marqueeEdgeColor[value] })),
    },
    {
        key: "marqueeEdgeSides",
        type: 'select',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"边线范围","en":"Edge sides"},
        description: {"zh-CN":"画在哪几条边上。内侧只画朝屏幕中心的那条或那几条，双侧连贴着屏沿的也画；左右两端一律不画。","en":"Which sides get the edge. Inner draws only the side facing the screen center, one for each band or four for the ring, and both also draws the side hugging the screen edge. The two short ends are never drawn."},
        defaultValue: "inner",
        options: CHOICE_OPTIONS.marqueeEdgeSides.map((value) => ({ value, label: CHOICE_LABELS.marqueeEdgeSides[value] })),
    },
    {
        key: "marqueeEdgeDrift",
        type: 'number',
        group: GROUPS["跑马灯带"].title,
        label: {"zh-CN":"边线流动","en":"Edge flow"},
        description: {"zh-CN":"边线那道灯沿带子流动的快慢。缺省 0：带上的字本来就贴着边线，灯一流动就会穿过字身、读成第二条线。","en":"How fast the edge light travels along the band. 0 by default: the band text sits against the edge, so a moving light crosses the glyphs and reads as a second line."},
        min: 0,
        max: 3,
        step: 0.05,
        defaultValue: 0,
    },
    {
        key: "ribbonCount",
        type: 'number',
        group: GROUPS["斜切丝带"].title,
        label: {"zh-CN":"条数","en":"Count"},
        description: {"zh-CN":"一叠几条。角度与位置都不重复，所以条数越多越密。","en":"How many strips. Angles and positions never repeat, so more means a denser stack."},
        min: 3,
        max: 9,
        step: 1,
        defaultValue: 6,
    },
    {
        key: "ribbonAngle",
        type: 'number',
        group: GROUPS["斜切丝带"].title,
        label: {"zh-CN":"倾角","en":"Skew"},
        description: {"zh-CN":"整体斜切幅度，超过 1.2 接近竖排，字仍保持正交，只是落点歪了。","en":"Overall skew, where past 1.2 it reads near-vertical; the glyphs stay upright and only the baseline tilts."},
        min: 0.4,
        max: 1.4,
        step: 0.05,
        defaultValue: 1,
    },
    {
        key: "ribbonDrift",
        type: 'number',
        group: GROUPS["斜切丝带"].title,
        label: {"zh-CN":"上下漂移","en":"Drift"},
        description: {"zh-CN":"整叠丝带上下漂移的快慢，0 是不动。文字在带上的滚动速度不受这项影响。","en":"How fast the stack drifts up and down, with 0 for still. The text scroll speed is independent."},
        min: 0,
        max: 3,
        step: 0.05,
        defaultValue: 1,
    },
];

// 分组提示（面板标题下的那段说明）；Folium 的 schema 没有分组提示字段，
// 这里导出给 README 与测试用，不参与注册。
export const CINERAMA_SETTINGS_GROUPS = GROUPS;

