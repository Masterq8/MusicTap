// mods/wave-light/mod.js
// Ported from wave-light 1.5.1 by pomepii (MIT License, Copyright (c) 2026 pomepii).
// See LICENSE in this folder for the full license text.
// Adapted to uta-tap Mini-Folium API v1: classic script, host-driven frame loop.
(function () {
'use strict';

const SETTINGS = [
        {
            key: 'waveSource', type: 'select', defaultValue: 'cover',
            label: '波光配色',
            description: '背景与波纹、歌词的颜色来源；跟随封面会提取当前封面的主色',
            options: [
                { value: 'cover', label: '跟随封面' },
                { value: 'theme', label: '主题色' },
            ],
        },
        {
            key: 'brightness', type: 'number', defaultValue: 1, min: 0.3, max: 2, step: 0.05,
            label: '波光亮度',
            description: '波纹与光晕的整体强度',
        },
        {
            key: 'speed', type: 'number', defaultValue: 1, min: 0.2, max: 3, step: 0.1,
            label: '流动速度',
            description: '波纹移动的整体快慢',
        },
        {
            key: 'keyword', type: 'boolean', defaultValue: true,
            label: '关键字水印',
            description: '歌词背后的超大水印：取当前句里最有分量的那个词',
        },
        {
            key: 'textScale', type: 'number', defaultValue: 1, min: 0.6, max: 1.8, step: 0.05,
            label: '歌词字号',
        },
    ];

function activate(folium) {
    folium.registries.visualizers.register({
        id: 'wave-light',
        label: '动感波光',
        order: 431,
        scope: 'immersive',
        settings: SETTINGS,
        mount: (container, ctx) => mountWaveLight(folium, container, ctx),
    });
}

// ---------------------------------------------------------------------------
// The mode. Background is a DOM gradient tinted by the cover colour; the two
// ripple clusters are one canvas animated with requestAnimationFrame (additive
// blending, cheap); lyrics, keyword watermark and translation are DOM.
// ---------------------------------------------------------------------------

function mountWaveLight(folium, container, ctx) {
    container.style.cssText = 'position:absolute;inset:0;overflow:hidden;';

    const style = document.createElement('style');
    style.textContent = [
        // The line and keyword are absolutely centred (left/top 50% +
        // translate(-50%,-50%)); entrance animations must carry the same
        // transform.
        '.wave-keyword-in { animation: wave-keyword-in 0.55s cubic-bezier(0.2, 0.8, 0.3, 1) both; }',
        '@keyframes wave-keyword-in {',
        '  from { opacity: 0; transform: translate(-50%, -50%) scale(1.06); filter: blur(18px); }',
        '  to { opacity: 1; transform: translate(-50%, -50%) scale(1); filter: blur(var(--kw-blur, 0px)); }',
        '}',
        '.wave-fade-in { animation: wave-fade-in 0.5s ease-out both; }',
        '@keyframes wave-fade-in {',
        '  from { opacity: 0; filter: blur(4px); }',
        '  to { opacity: 1; filter: blur(0); }',
        '}',
        // Per-character entrance for the active line: the centre character
        // surfaces first, the outer characters converge from their own side
        // (translateX from --dx to 0), everything sharpening from blur.
        '.wave-ch { display:inline-block; will-change:transform,filter,opacity;',
        '  animation: wave-ch-in 0.52s cubic-bezier(0.2, 0.8, 0.3, 1) both; }',
        '.wave-ch-static { display:inline-block; }',
        '@keyframes wave-ch-in {',
        '  from { opacity: 0; filter: blur(14px); transform: translateX(var(--dx, 0em)); }',
        '  to { opacity: 1; filter: blur(0); transform: translateX(0); }',
        '}',
    ].join('\n');
    container.appendChild(style);

    // ---- background --------------------------------------------------------
    // A deep radial wash in the artwork's colour; the canvas above it adds the
    // moving ripples. Both are re-tinted when the cover colour arrives.
    const bg = document.createElement('div');
    bg.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    container.appendChild(bg);

    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    container.appendChild(cv);
    const g = cv.getContext('2d');

    // ---- keyword watermark -------------------------------------------------
    // The line's heaviest word (see keywordOf), huge and dark, floating behind
    // the lyric text — exactly co-centred with it.
    const keywordEl = document.createElement('div');
    keywordEl.style.cssText = [
        'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
        'font-weight:800;line-height:1;pointer-events:none;user-select:none;',
        'opacity:0.92;letter-spacing:0.02em;white-space:nowrap;',
    ].join('');
    container.appendChild(keywordEl);

    // ---- current line ------------------------------------------------------
    // A centred flex column holding ONLY the active line, so the lyric is
    // always exactly centred on its own (the translation lives outside, see
    // below — keeping it in-flow would shift the lyric off-centre).
    const centreCol = document.createElement('div');
    centreCol.style.cssText = [
        'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
        'box-sizing:border-box;padding:0 7%;pointer-events:none;',
    ].join('');
    container.appendChild(centreCol);

    const lineEl = document.createElement('div');
    lineEl.style.cssText = 'max-width:100%;text-wrap:balance;line-height:1.3;font-weight:700;text-align:center;';
    centreCol.appendChild(lineEl);

    // ---- translation -------------------------------------------------------
    // A separate block in the lower part of the screen: horizontally centred,
    // vertically at the midpoint between the watermark's lower edge and the
    // bottom of the screen (top is computed in renderText from the watermark
    // size). Never part of the lyric column.
    const translationEl = document.createElement('div');
    translationEl.style.cssText = [
        'position:absolute;left:50%;top:82%;transform:translate(-50%,-50%);',
        'max-width:70%;text-align:center;line-height:1.5;font-weight:400;',
        'pointer-events:none;text-shadow:0 1px 8px rgba(0,0,0,0.35);',
    ].join('');
    container.appendChild(translationEl);

    // ---- state -------------------------------------------------------------
    let disposed = false;
    let width = Math.max(1, container.clientWidth || window.innerWidth || 1);
    let height = Math.max(1, container.clientHeight || window.innerHeight || 1);
    let dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    let lastLineIndex = null;
    let lastTextKey = '';
    let heldIdx = -1; // last real line shown, kept across interlude gaps
    // Text-layer alignment. The host does not always give us a clean
    // full-page containing block: in the settings preview the mode is mounted
    // inside a small card, and absolute children may resolve against some
    // larger ancestor. So no anchor is assumed: every text layer is first put
    // back at its natural position, measured on screen, and nudged by the
    // difference between where it landed and where it belongs — the visible
    // centre of OUR container. When the containing block is already correct
    // every delta is zero and this is a no-op.
    let kFontPx = 0;
    // The cover's dominant colour drives everything; null until extracted
    // (or when the artwork cannot be read), then the theme accent is used.
    let coverColor = null;
    let coverUrlForColor = null;

    const settings = () => {
        const v = ctx.getSettings() || {};
        return {
            waveSource: v.waveSource === 'theme' ? 'theme' : 'cover',
            brightness: clampNum(v.brightness, 0.3, 2, 1),
            speed: clampNum(v.speed, 0.2, 3, 1),
            keyword: v.keyword !== false,
            textScale: clampNum(v.textScale, 0.6, 1.8, 1),
        };
    };

    // ---- palette -----------------------------------------------------------
    // One base colour (cover or theme) is expanded into: the dark background
    // wash, the ripple colour, a bright low-saturation tint for the lyric, and
    // a dark shade for the keyword watermark.
    let palette = null;

    const baseColor = () => {
        const s = settings();
        if (s.waveSource === 'cover' && coverColor) return coverColor;
        const accent = ctx.getTheme() && ctx.getTheme().accentColor;
        if (typeof accent === 'number') {
            return '#' + ('000000' + (accent >>> 0).toString(16)).slice(-6);
        }
        return hexOr(accent, '#5f7cff');
    };

    const computePalette = (hex) => {
        const rgb = hexToRgb(hex);
        if (!rgb) return null;
        const [h, sat, li] = rgbToHsl(rgb.r, rgb.g, rgb.b);
        const wave = hslToRgb(h, Math.min(0.9, Math.max(0.45, sat * 1.15 + 0.06)), 0.58);
        const tint = hslToRgb(h, Math.min(0.45, sat * 0.35 + 0.06), 0.92);
        return {
            h,
            sat,
            base: rgb,
            wave: { r: wave[0], g: wave[1], b: wave[2] },
            tint: { r: tint[0], g: tint[1], b: tint[2] },
            // watermark: black overlaid with the cover colour (~40% cover)
            keyword: scaleRgb(rgb, 0.4),
            bgMid: scaleRgb(rgb, 0.24),
            bgEdge: scaleRgb(rgb, 0.07),
            bgDeep: scaleRgb(rgb, 0.04),
        };
    };

    const applyPalette = () => {
        palette = computePalette(baseColor()) || palette;
        if (!palette) return;
        const { wave, tint } = palette;
        bg.style.background = 'radial-gradient(135% 100% at 50% 44%, '
            + `${cssRgb(palette.bgMid)} 0%, ${cssRgb(palette.bgEdge)} 58%, ${cssRgb(palette.bgDeep)} 100%)`;
        keywordEl.style.color = cssRgba(palette.keyword, 0.88);
        keywordEl.style.textShadow = `0 0 ${Math.max(8, height * 0.02)}px ${cssRgba(palette.keyword, 0.3)}`;
        lineEl.style.color = cssRgba(tint, 0.97);
        lineEl.style.textShadow = `0 1px ${Math.max(10, height * 0.03)}px ${cssRgba(palette.keyword, 0.5)}`;
        translationEl.style.color = cssRgba(tint, 0.68);
        void wave;
    };

    // ---- canvas: two moving ripple clusters --------------------------------
    const resizeCanvas = () => {
        dpr = Math.min(window.devicePixelRatio || 1, 1.75);
        const w = Math.max(1, Math.round(width * dpr));
        const h = Math.max(1, Math.round(height * dpr));
        if (cv.width !== w || cv.height !== h) {
            cv.width = w;
            cv.height = h;
        }
    };

    // Deterministic pseudo-random per index, so the composition is stable
    // across frames instead of re-rolled every tick.
    const frac = (v) => v - Math.floor(v);
    const rand = (i, salt) => frac(Math.sin((i + 1) * 127.1 + salt * 311.7) * 43758.5453);

    // One cluster: a soft core glow plus concentric rings whose brightness is
    // banded vertically (bright at the middle, fading up/down — light on
    // water), and a few brighter arcs slowly rotating. cx sits at (or just
    // inside) the screen edge, so half of each ring is off-screen.
    const drawCluster = (cx, cy, baseR, t, seed, alphaScale) => {
        const w = cv.width;
        const h = cv.height;
        const { wave } = palette;

        // core glow
        const coreR = baseR * 0.9;
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, coreR));
        rg.addColorStop(0, cssRgba(wave, (0.15 * alphaScale).toFixed(3)));
        rg.addColorStop(0.55, cssRgba(wave, (0.06 * alphaScale).toFixed(3)));
        rg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = rg;
        g.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

        // concentric rings with an outward-travelling swell — successive rings
        // enlarge and shrink in turn, like the cone of a speaker pushing the
        // wave outwards
        const n = 9;
        for (let i = 1; i <= n; i++) {
            const r1 = rand(i + seed * 13, 1);
            const r2 = rand(i + seed * 13, 2);
            const swell = 1 + 0.15 * Math.sin(t * (0.65 + 0.15 * r1) - i * 0.62 + seed * 2.1);
            const rr = baseR * (0.16 + 0.92 * (i / n)) * swell;
            const breathe = 0.6 + 0.4 * Math.sin(t * (0.45 + 0.1 * r2) - i * 0.55 + seed);
            const alpha = Math.max(0.008, alphaScale * (0.03 + 0.095 * (1 - i / n)) * breathe);

            // vertical banding: fade the ring out toward its top and bottom
            const grad = g.createLinearGradient(0, cy - rr, 0, cy + rr);
            grad.addColorStop(0, `rgba(${wave.r},${wave.g},${wave.b},0)`);
            grad.addColorStop(0.3, `rgba(${wave.r},${wave.g},${wave.b},${(alpha * 0.6).toFixed(3)})`);
            grad.addColorStop(0.5, `rgba(${wave.r},${wave.g},${wave.b},${alpha.toFixed(3)})`);
            grad.addColorStop(0.7, `rgba(${wave.r},${wave.g},${wave.b},${(alpha * 0.6).toFixed(3)})`);
            grad.addColorStop(1, `rgba(${wave.r},${wave.g},${wave.b},0)`);
            g.strokeStyle = grad;
            g.lineWidth = Math.max(0.8, h * (0.0012 + 0.005 * r2));
            g.shadowColor = cssRgba(wave, Math.min(0.55, alpha * 1.3));
            g.shadowBlur = h * 0.018;
            g.beginPath();
            g.arc(cx, cy, rr, 0, Math.PI * 2);
            g.stroke();
        }

        // sound-wave emission: bright rings born at the core, expanding
        // outward and fading as they go — the "speaker pulse"
        for (let k = 0; k < 3; k++) {
            const phase = (t * (0.1 + 0.018 * rand(seed, 7)) + k / 3 + seed * 0.21) % 1;
            const rr = baseR * (0.1 + 1.04 * phase);
            const fade = Math.pow(1 - phase, 1.6);
            const alpha = Math.max(0, alphaScale * 0.17 * fade);
            if (alpha > 0.004) {
                const grad = g.createLinearGradient(0, cy - rr, 0, cy + rr);
                grad.addColorStop(0, `rgba(${wave.r},${wave.g},${wave.b},0)`);
                grad.addColorStop(0.3, `rgba(${wave.r},${wave.g},${wave.b},${(alpha * 0.6).toFixed(3)})`);
                grad.addColorStop(0.5, `rgba(${wave.r},${wave.g},${wave.b},${alpha.toFixed(3)})`);
                grad.addColorStop(0.7, `rgba(${wave.r},${wave.g},${wave.b},${(alpha * 0.6).toFixed(3)})`);
                grad.addColorStop(1, `rgba(${wave.r},${wave.g},${wave.b},0)`);
                g.strokeStyle = grad;
                g.lineWidth = Math.max(0.8, h * (0.0018 + 0.0035 * (1 - phase)));
                g.shadowColor = cssRgba(wave, Math.min(0.6, alpha * 1.5));
                g.shadowBlur = h * 0.022;
                g.beginPath();
                g.arc(cx, cy, rr, 0, Math.PI * 2);
                g.stroke();
            }
        }

        // slowly rotating bright arcs — the "动" in 动感波光
        for (let k = 0; k < 3; k++) {
            const r1 = rand(k + seed * 31, 4);
            const r2 = rand(k + seed * 31, 6);
            const rr = baseR * (0.28 + 0.72 * r1) * (1 + 0.02 * Math.sin(t * 0.2 + k));
            const a0 = t * (0.05 + 0.07 * r1) * (k % 2 ? -1 : 1) + k * 2.4 + seed * 1.7;
            const span = 0.9 + 1.5 * r2;
            const alpha = Math.max(0.01, alphaScale * (0.09 + 0.08 * rand(k + seed * 31, 5))
                * (0.7 + 0.3 * Math.sin(t * 0.3 + k * 2.2)));

            const grad = g.createLinearGradient(0, cy - rr, 0, cy + rr);
            grad.addColorStop(0, `rgba(${wave.r},${wave.g},${wave.b},0)`);
            grad.addColorStop(0.5, `rgba(${wave.r},${wave.g},${wave.b},${alpha.toFixed(3)})`);
            grad.addColorStop(1, `rgba(${wave.r},${wave.g},${wave.b},0)`);
            g.strokeStyle = grad;
            g.lineWidth = Math.max(1, h * (0.0018 + 0.0035 * r1));
            g.shadowColor = cssRgba(wave, Math.min(0.6, alpha * 1.5));
            g.shadowBlur = h * 0.02;
            g.beginPath();
            g.arc(cx, cy, rr, a0, a0 + span);
            g.stroke();
        }
        void w;
    };

    const draw = (now) => {
        const w = cv.width;
        const h = cv.height;
        if (!w || !h || !palette) return;
        const s = settings();
        const t = (now / 1000) * s.speed;
        const { wave } = palette;

        g.clearRect(0, 0, w, h);
        g.globalCompositeOperation = 'lighter';

        // two ripple clusters hugging the left and right edges
        const baseR = Math.min(w, h) * 0.62;
        const cy = h * (0.45 + 0.02 * Math.sin(t * 0.09));
        const cxL = w * 0.015 + w * 0.012 * Math.sin(t * 0.06 + 1.2);
        const cxR = w * 0.985 + w * 0.012 * Math.sin(t * 0.055 + 3.9);
        drawCluster(cxL, cy, baseR, t, 1, 1);
        drawCluster(cxR, cy * 0.98, baseR * 1.04, t * 1.06, 2, 0.92);

        // a faint drifting glow between them, for depth
        const px = w * (0.5 + 0.18 * Math.sin(t * 0.08 + 0.7));
        const py = h * (0.42 + 0.08 * Math.cos(t * 0.06 + 2.1));
        const pr = h * 0.4;
        const pga = g.createRadialGradient(px, py, 0, px, py, pr);
        pga.addColorStop(0, cssRgba(wave, (0.05 * s.brightness).toFixed(3)));
        pga.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = pga;
        g.fillRect(px - pr, py - pr, pr * 2, pr * 2);

        g.shadowBlur = 0;
        g.globalCompositeOperation = 'source-over';
    };

    let lastMeasure = 0;
    let elapsed = 0;
    const onFrame = (dt) => {
        if (disposed) return;
        elapsed += Math.min(dt || 0, 0.05);
        const now = elapsed * 1000;
        // Re-anchor periodically in case the host moves or resizes the
        // container while we are mounted.
        if (now - lastMeasure > 500) {
            lastMeasure = now;
            alignTextLayers();
        }
        draw(now);
    };

    // ---- typography --------------------------------------------------------
    // Align the text layers to the visible centre of our own container.
    // Called after kFontPx is known, and re-run every 500ms + on every render
    // so a host that moves, resizes or reparents the container stays correct.
    const alignTextLayers = () => {
        // 1. Reset every layer to its natural placement, so the measurement
        //    below reflects where the browser puts it on its own.
        keywordEl.style.left = '50%';
        keywordEl.style.top = '50%';
        centreCol.style.transform = '';
        const baseTop = Math.round(height * 0.75 + kFontPx / 4);
        translationEl.style.left = '50%';
        translationEl.style.top = `${baseTop}px`;

        // 2. Measure. Without layout there is nothing to correct yet.
        const cr = container.getBoundingClientRect();
        if (!cr.width || !cr.height) return;
        // If the host scales the container, on-screen deltas are in scaled
        // pixels; divide them back out so the correction is exact.
        const scale = cr.width / Math.max(1, container.offsetWidth || cr.width) || 1;
        const cx = cr.left + cr.width / 2;
        const layerCenter = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, empty: !r.width && !r.height };
        };
        const px = (v) => `${Math.round(v)}px`;

        // 3. Watermark: belongs at the container centre, positioned with
        //    left/top (+ translate(-50%,-50%), also baked into its entrance
        //    keyframes — nudging left/top never fights the animation).
        const kw = layerCenter(keywordEl);
        if (!kw.empty) {
            keywordEl.style.left = `calc(50% + ${px((cx - kw.x) / scale)})`;
            keywordEl.style.top = `calc(50% + ${px((cr.top + cr.height / 2 - kw.y) / scale)})`;
        }

        // 4. Lyric column: inset:0 flex centring, corrected with a transform
        //    nudge measured on the line itself (spans converge symmetrically,
        //    so the line's centre is stable even mid-entrance).
        const line = layerCenter(lineEl);
        if (!line.empty) {
            const dx = Math.round((cx - line.x) / scale);
            const dy = Math.round((cr.top + cr.height / 2 - line.y) / scale);
            centreCol.style.transform = dx || dy ? `translate(${px(dx)}, ${px(dy)})` : '';
        }

        // 5. Translation: horizontally centred, vertically at the midpoint
        //    between the watermark's lower edge and the bottom of the screen.
        const tr = layerCenter(translationEl);
        if (!tr.empty) {
            translationEl.style.left = `calc(50% + ${px((cx - tr.x) / scale)})`;
            translationEl.style.top = `calc(${baseTop}px + ${px((cr.top + cr.height * 0.75 + kFontPx / 4 - tr.y) / scale)})`;
        }
    };

    const applyTypography = () => {
        const theme = ctx.getTheme();
        const s = settings();
        const display = ctx.getDisplay();
        const stack = safeFontStack(folium, theme);
        const weight = safeWeight(folium, theme, 700);
        // The active line is the centrepiece: noticeably larger than a normal
        // lyric layout (the reference runs it at roughly a tenth of the page).
        const base = Math.round(Math.min(Math.max(height * 0.085, 18), 110) * s.textScale * display.lyricsFontScale);

        container.style.fontFamily = stack;
        lineEl.style.fontSize = `${base}px`;
        lineEl.style.fontWeight = String(weight);
        // Watermark size depends on the length of the picked run and is set in
        // renderText; only the scale factor matters here.
        translationEl.style.fontSize = `${Math.round(base * 0.4)}px`;
    };

    // ---- text --------------------------------------------------------------
    // FNV-1a string hash → stable per line, so the same line always picks the
    // same keyword while different lines pick different ones.
    const strHash = (s) => {
        let h = 2166136261;
        for (const c of s) {
            h ^= c.codePointAt(0);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    };
    const rand01 = (n) => frac(Math.sin(n * 12.9898) * 43758.5453);

    /**
     * The watermark is the line's *hero word*, chosen the way the host's own
     * lyric typography engine (`sonnet`, the mode the official K3Panel mod
     * exposes sliders for) chooses which word of a line to draw huge:
     *
     *   1. split the line into WORDS, not characters — `Intl.Segmenter` with
     *      word granularity, which is the same fallback the host itself uses
     *      (it prefers an LLM segmentation, unavailable to a mod);
     *   2. score every content word
     *          score = min(chars, 8) × 14 + min(2.5 s, sungFor) × 18
     *      so a long word held for a while beats a short one that flashes past:
     *      in 「再度重相逢」 that is 「相逢」/「再度」, never the lone 「重」 that
     *      merely happens to sit in the middle;
     *   3. the heaviest word carries the line. Equal weights are broken by a
     *      hash of the line, so consecutive lines do not all land on the same
     *      position but a line never re-picks while it is on screen.
     *
     * The host also refuses to promote a hero in lines with fewer than four
     * content words, and requires two characters minimum; a one-character
     * winner borrows its neighbour so the run stays contiguous.
     *
     * Credit lines ("作词：… 作曲：…") are special-cased: the watermark shows
     * the value after the last colon (usually a name), not the label.
     */
    const CREDIT_RE = /(作词|作詞|作曲|编曲|編曲|填词|填詞|谱曲|譜曲|监制|監製|和声|和聲|混音|混響|母带|母帶|录音|錄音|制作|製作|出品|发行|發行|改编|改編|翻唱|原唱|演唱|主唱|词|曲|op|sp|吉他|钢琴|鋼琴|贝斯|貝斯|鼓|提琴|lyrics?|compos\w*|arrang\w*|written\s+by|produced\s+by|mix\w*|master\w*|record\w*|vocal\w*|perform\w*|remix\w*|guitar|bass|piano|drum\w*|violin)/i;

    // The host's scoring constants, kept as they are so the two agree.
    const HERO = { charPoints: 14, charCap: 8, timePoints: 18, timeCap: 2.5, minChars: 2, tie: 0.94 };

    let wordSegmenter; // lazily built; null when the runtime has none

    const wordLikeRe = /[\p{L}\p{N}]/u;

    // Words, each flagged `wordLike` (punctuation and spaces are not words).
    const segmentWords = (text) => {
        if (!text) return [];
        if (wordSegmenter === undefined) {
            try {
                wordSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
                    ? new Intl.Segmenter(undefined, { granularity: 'word' })
                    : null;
            } catch {
                wordSegmenter = null;
            }
        }
        if (wordSegmenter) {
            try {
                return Array.from(wordSegmenter.segment(text), (part, i) => ({
                    text: part.segment,
                    k: i,
                    wordLike: part.isWordLike !== undefined ? part.isWordLike : wordLikeRe.test(part.segment),
                }));
            } catch {
                wordSegmenter = null;
            }
        }
        // No Intl.Segmenter: latin runs stay whole, CJK/kana is one character per
        // unit, punctuation and whitespace are their own units. Coarser, but it
        // keeps the watermark sane on older runtimes.
        const out = [];
        const re = /([\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff])|([\p{L}\p{N}'’&.-]+)|([\s\p{P}\p{S}]+)/gu;
        let m = re.exec(text);
        while (m) {
            out.push({ text: m[0], k: out.length, wordLike: m[3] === undefined });
            m = re.exec(text);
        }
        return out;
    };

    const wordChars = (text) => Array.from(text).filter((ch) => ch.trim() !== '').length;

    // A line hands us only its own span, so each word's sung time is its share
    // of the characters — long words take longer to sing, which is the ordering
    // the score cares about. `lineSeconds <= 0` falls back to a slow-ish read.
    const scoreWords = (words, lineSeconds) => {
        const content = words.filter((w) => w.wordLike && wordChars(w.text) > 0);
        const total = content.reduce((sum, w) => sum + wordChars(w.text), 0) || 1;
        const span = Math.max(0.4, Math.min(16, Number(lineSeconds) || total * 0.32));
        content.forEach((w) => {
            w.chars = wordChars(w.text);
            const sung = Math.min(HERO.timeCap, (span * w.chars) / total);
            w.score = Math.min(w.chars, HERO.charCap) * HERO.charPoints + sung * HERO.timePoints;
        });
        return content;
    };

    const pickHero = (words, lineSeconds) => {
        const content = scoreWords(words, lineSeconds);
        if (!content.length) return null;
        let best = content[0];
        content.forEach((w) => { if (w.score > best.score) best = w; });
        // Words of the same length score the same; the line hash picks one of
        // them stably, so the watermark moves around between lines without
        // ever changing under a line that is already on screen.
        const near = content.filter((w) => w.score >= best.score * HERO.tie);
        if (near.length < 2) return best;
        const seed = strHash(words.map((w) => w.text).join('|'));
        return near[Math.floor(rand01(seed + 7) * near.length) % near.length] || best;
    };

    // A single character cannot carry a giant watermark; borrow the heavier
    // neighbour so the run still reads as one contiguous piece of the line.
    const growHero = (hero, words) => {
        let lo = hero.k;
        let hi = hero.k;
        let text = hero.text;
        while (wordChars(text) < HERO.minChars) {
            const prev = lo > 0 && words[lo - 1].wordLike ? words[lo - 1] : null;
            const next = hi < words.length - 1 && words[hi + 1].wordLike ? words[hi + 1] : null;
            if (!prev && !next) break;
            if (prev && (!next || (prev.score || 0) >= (next.score || 0))) {
                lo -= 1;
                text = prev.text + text;
            } else {
                hi += 1;
                text += next.text;
            }
        }
        return text;
    };

    const cleanKeyword = (text) => text.replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 12);

    // Punctuation and stray spaces at the edges only — inner spacing of a latin
    // name stays, so 「Justin Timberlake」 does not run together.
    const trimMarks = (text) => text.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');

    const lineSeconds = (line) => {
        const start = Number(line?.startTime);
        const end = Number(line?.endTime);
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start;
        if (Number.isFinite(end) && end > 0) return end;
        return 0;
    };

    const keywordOf = (text, span) => {
        const t = text.trim();
        if (!t) return '';

        if (CREDIT_RE.test(t) && /[:：]/.test(t)) {
            const raw = t.split(/[:：]/).pop().trim();
            const exact = trimMarks(raw);
            if (exact) {
                // A short value reads best whole: 「方文山」, 「周杰伦」. Anything
                // longer would have to shrink below the lyric to fit, so it is
                // reduced to its heaviest word instead.
                if (Array.from(exact).length <= 8) return exact;
                const words = segmentWords(raw);
                const hero = pickHero(words, span);
                return hero ? cleanKeyword(growHero(hero, words)) : exact.slice(0, 8);
            }
            // nothing after the colon — fall through to the normal rules
        }

        if (!cleanKeyword(t)) return '';
        const words = segmentWords(t);
        const hero = pickHero(words, span);
        return hero ? cleanKeyword(growHero(hero, words)) : cleanKeyword(t).slice(0, 4);
    };

    /**
     * Build the active line out of per-token spans so the entrance can be
     * choreographed: the centre token surfaces in place first, tokens further
     * out slide in from their own side (left half from the left, right half
     * from the right) and everything sharpens from blur. A token is one CJK
     * character, or a whole latin word (so words never split mid-way).
     */
    const buildLine = (text) => {
        lineEl.textContent = '';
        // Tokenise: each Han/kana char stands alone; latin/digit runs stay
        // whole (words never split); whitespace and punctuation are their own
        // tokens. (A \p{L} regex would swallow CJK — Han is a letter too.)
        const tokens = [];
        let run = '';
        const flush = () => { if (run) { tokens.push(run); run = ''; } };
        for (const ch of text) {
            if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff]/.test(ch)) {
                flush();
                tokens.push(ch);
            } else if (/[\p{L}\p{N}'’&.-]/u.test(ch)) {
                run += ch;
            } else {
                flush();
                tokens.push(ch);
            }
        }
        flush();

        const mid = (tokens.length - 1) / 2;
        tokens.forEach((tok, i) => {
            const sp = document.createElement('span');
            sp.textContent = tok;
            if (/^\s+$/.test(tok)) {
                sp.style.whiteSpace = 'pre';
                lineEl.appendChild(sp);
                return;
            }
            const dist = Math.abs(i - mid);
            const dir = Math.sign(i - mid);
            // Live mode always plays the entrance — whichever host path
            // triggered the rebuild (lyric clock, snapshot change, remount).
            sp.className = ctx.staticMode ? 'wave-ch-static' : 'wave-ch';
            // start offset grows with distance from the centre, capped so very
            // long lines do not fly in from absurdly far away
            sp.style.setProperty('--dx', `${(dir * Math.min(dist, 4) * 0.7).toFixed(2)}em`);
            // centre first, then a gentle outward stagger
            sp.style.animationDelay = `${Math.round(100 + dist * 80)}ms`;
            lineEl.appendChild(sp);
        });
    };

    const renderText = (animate) => {
        const display = ctx.getDisplay();
        const s = settings();
        const showText = display.showText !== false;
        // NOTE: '' would *remove* the inline display:flex set in cssText and
        // collapse the column to a plain block (lyric pinned to the top), so
        // the visible state must restore 'flex' explicitly.
        centreCol.style.display = showText ? 'flex' : 'none';
        keywordEl.style.display = showText && s.keyword ? '' : 'none';
        if (!showText) {
            // Keep the line index in sync so `onLyricTime` does not keep
            // re-entering here on every clock tick while the text is hidden.
            lastLineIndex = ctx.getLineIndex();
            return;
        }

        const song = ctx.song;
        const index = ctx.staticMode && ctx.staticLineIndex !== null
            ? ctx.staticLineIndex
            : ctx.getLineIndex();

        // Effective content: hold the most recent non-empty line through
        // interlude gaps (empty lines, or the clock dipping to -1 between
        // lines) — flashing "title - artist" mid-song reads as a bug. The
        // title is only for the intro, before the first line has appeared.
        let effIdx = -1;
        let effLine = null;
        let text = '';
        const searchFrom = index >= 0 ? index : heldIdx;
        for (let j = searchFrom; j >= 0; j--) {
            const t = ctx.lines[j]?.fullText?.trim();
            if (t) {
                effIdx = j;
                effLine = ctx.lines[j];
                text = t;
                break;
            }
        }
        if (effIdx >= 0) heldIdx = effIdx;
        let translation = effLine?.translation?.trim() || '';
        if (!text) {
            // Intro: only the song title, never "title - artist".
            text = song?.title || '♪';
            translation = '';
        }
        const keyword = s.keyword ? keywordOf(text, lineSeconds(effLine)) : '';

        // Re-animate only when the displayed content really changed (the clock
        // ticks far more often than lines change). Holding a line through a
        // gap yields the same key and therefore no rebuild.
        const key = `${effIdx}|${text}|${translation}|${keyword}`;
        const changed = key !== lastTextKey;
        lastTextKey = key;

        // Rebuild the line only when it changed: the characters are spans so
        // they can converge in with per-character stagger.
        if (changed) buildLine(text);

        keywordEl.textContent = keyword;
        keywordEl.style.display = keyword && showText && s.keyword ? '' : 'none';
        // Fit the watermark: shrink it when the hero word is long, so even a
        // twelve-letter word never runs off the page. The size also anchors the
        // translation's vertical position, so it is computed even when the
        // watermark is off.
        const kLen = keyword.length || 3;
        // Overall watermark scale is 80% of the old size — big enough to
        // dominate, small enough to leave the translation room below.
        kFontPx = Math.max(28, Math.min(height * 0.42, (width * 0.8) / kLen)
            * (0.55 + 0.45 * s.textScale)) * 0.8;
        if (keyword) {
            keywordEl.style.fontSize = `${kFontPx}px`;
            // Constant soft focus: the watermark is never razor sharp. The
            // entrance animation ends at the same blur (via --kw-blur) because
            // a finished fill:both animation would otherwise pin blur(0).
            const kwBlur = Math.max(2, Math.round(kFontPx * 0.025));
            keywordEl.style.setProperty('--kw-blur', `${kwBlur}px`);
            keywordEl.style.filter = `blur(${kwBlur}px)`;
        }
        alignTextLayers();
        translationEl.textContent = translation;
        translationEl.style.display = translation && showText ? '' : 'none';

        // The keyword leads (it is the focal character), the line's characters
        // converge behind it; the translation just fades. The spans animate by
        // themselves on insertion — only keyword and translation need a rerun.
        if (changed && !ctx.staticMode) {
            keywordEl.classList.remove('wave-keyword-in');
            void keywordEl.offsetWidth;
            keywordEl.classList.add('wave-keyword-in');
            translationEl.classList.remove('wave-fade-in');
            void translationEl.offsetWidth;
            translationEl.classList.add('wave-fade-in');
        }
        lastLineIndex = index;
    };

    // ---- cover -------------------------------------------------------------
    const applyCover = () => {
        if (disposed) return;
        const s = settings();
        const cover = ctx.getCoverUrl();
        if (s.waveSource === 'cover' && cover) {
            if (coverUrlForColor !== cover) {
                coverUrlForColor = cover;
                coverColor = null;
                void dominantColor(cover).then((color) => {
                    if (disposed || coverUrlForColor !== cover) return;
                    coverColor = color;
                    applyPalette();
                });
            }
        } else {
            coverUrlForColor = null;
            coverColor = null;
        }
        applyPalette();
    };

    const refreshAll = (animate) => {
        resizeCanvas();
        applyCover();
        applyTypography();
        renderText(animate);
    };

    resizeCanvas();
    applyCover();
    applyTypography();
    renderText(false);
    const offFrame = ctx.onFrame(onFrame);

    // ---- subscriptions -----------------------------------------------------
    const offResize = ctx.onResize((w, h) => {
        width = Math.max(1, w);
        height = Math.max(1, h);
        refreshAll(false);
    });

    const offChange = ctx.onChange(() => {
        refreshAll(false);
    });

    // Line changes come with the lyric clock; only redraw the text when the
    // active line actually moved. The ripples keep flowing regardless of
    // pause — the surface stays alive, as in the reference.
    const offTime = ctx.onLyricTime(() => {
        const index = ctx.staticMode && ctx.staticLineIndex !== null
            ? ctx.staticLineIndex
            : ctx.getLineIndex();
        if (index === lastLineIndex) return;
        renderText(true);
    });

    return () => {
        disposed = true;
        offFrame();
        offResize();
        offChange();
        offTime();
    };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const clampNum = (value, min, max, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
};

const hexOr = (value, fallback) =>
    (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback);

const hexToRgb = (hex) => {
    if (typeof hex !== 'string') return null;
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
    if (!m) return null;
    const value = parseInt(m[1], 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
};

const rgbToHsl = (r, g, b) => {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
    return [h, s, l];
};

const hueToRgb = (p, q, t) => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
};

const hslToRgb = (h, s, l) => {
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)]
        .map((v) => Math.round(v * 255));
};

const scaleRgb = (rgb, k) => ({
    r: Math.round(rgb.r * k),
    g: Math.round(rgb.g * k),
    b: Math.round(rgb.b * k),
});

const cssRgb = (rgb) => `rgb(${rgb.r},${rgb.g},${rgb.b})`;
const cssRgba = (rgb, a) => `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;

// One entry per cover URL, so switching back and forth costs nothing.
const COLOR_CACHE = new Map();

/**
 * Dominant colour of an image, as a `#rrggbb` string (or null).
 * A 24×24 downscale is sampled, each pixel weighted by saturation and by how
 * close its lightness is to mid-grey (a big white border or a black sleeve
 * should not wash the result out), then the average is pushed back into a
 * usable saturation/lightness.
 *
 * Reading the canvas can throw on a tainted canvas (a cross-origin cover
 * without CORS headers); that is expected and simply means "no colour".
 */
const dominantColor = (url) => new Promise((resolve) => {
    if (COLOR_CACHE.has(url)) {
        resolve(COLOR_CACHE.get(url));
        return;
    }
    let settled = false;
    const finish = (color) => {
        if (settled) return;
        settled = true;
        if (color) COLOR_CACHE.set(url, color);
        resolve(color);
    };

    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        try {
            const size = 24;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const g2 = canvas.getContext('2d', { willReadFrequently: true });
            g2.drawImage(img, 0, 0, size, size);
            const { data } = g2.getImageData(0, 0, size, size);

            let sum = 0;
            let r = 0;
            let gr = 0;
            let b = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] < 160) continue;
                const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
                const weight = (0.08 + s * s) * Math.max(0, 1 - Math.abs(l - 0.5) * 1.3);
                if (weight <= 0) continue;
                r += data[i] * weight;
                gr += data[i + 1] * weight;
                b += data[i + 2] * weight;
                sum += weight;
            }
            if (sum <= 0) {
                finish(null);
                return;
            }
            const [h, s, l] = rgbToHsl(r / sum, gr / sum, b / sum);
            const [rr, gg, bb] = hslToRgb(h, Math.min(0.85, Math.max(0.42, s * 1.2 + 0.08)), Math.min(0.62, Math.max(0.46, l)));
            finish(`#${[rr, gg, bb].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`);
        } catch {
            finish(null);
        }
    };
    img.onerror = () => finish(null);
    // A cover that never loads must not leave the palette waiting forever.
    setTimeout(() => finish(null), 4000);
    img.src = url;
});

// Theme helpers are Folium 1.3+; fall back to the theme's own family fields.
const safeFontStack = (folium, theme) => {
    try {
        const stack = folium.theme?.resolveFontStack?.(theme);
        if (typeof stack === 'string' && stack) return stack;
    } catch { /* older host */ }
    return theme?.fontFamily || 'system-ui, -apple-system, "PingFang SC", sans-serif';
};

const safeWeight = (folium, theme, fallback) => {
    try {
        const weight = folium.theme?.resolveFontWeight?.(theme, fallback);
        if (Number.isFinite(weight)) return weight;
    } catch { /* older host */ }
    return fallback;
};

UTAMods.register({
    id: 'wave-light',
    name: '动感波光',
    version: '1.5.1',
    api: 1,
    author: 'pomepii',
    description: 'QQ 音乐「动感波光」风格：封面主色波光 + 居中歌词 + 关键字水印 + 翻译。MIT 移植版。',
    settings: SETTINGS,
    activate: activate,
});

})();
