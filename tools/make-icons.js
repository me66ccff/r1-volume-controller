/**
 * 生成扩展图标（纯 Node，无第三方依赖）。
 * 设计：深色圆角方块 + 橙色环形音量弧 + 白色喇叭楔形。
 * 用法: node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');
const SIZES = [16, 32, 48, 128, 256];

/* ---------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------------------------------------------------------- 绘制 */

function mix(a, b, t) {
  return a + (b - a) * t;
}

function over(dst, src, alpha) {
  return {
    r: mix(dst.r, src.r, alpha),
    g: mix(dst.g, src.g, alpha),
    b: mix(dst.b, src.b, alpha),
    a: Math.min(1, dst.a + alpha)
  };
}

/** 点是否在多边形内（射线法，用于画喇叭） */
function inPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 点到圆弧（按角度区间截取）的距离，用于画声波 */
function distanceToArc(px, py, cx, cy, radius, a0, a1) {
  const vx = px - cx;
  const vy = py - cy;
  const dist = Math.sqrt(vx * vx + vy * vy);
  let ang = Math.atan2(vy, vx);
  while (ang < a0) ang += Math.PI * 2;
  const clamped = Math.min(a1, Math.max(a0, ang));
  const tx = cx + Math.cos(clamped) * radius;
  const ty = cy + Math.sin(clamped) * radius;
  return { radial: Math.abs(dist - radius), point: Math.hypot(px - tx, py - ty) };
}

/** 用 4x4 超采样画一个尺寸为 size 的图标 */
function renderIcon(size) {
  const SS = 4;
  const W = size * SS;
  const buf = Buffer.alloc(W * W * 4);

  const center = W / 2;
  const radius = W / 2 - W * 0.055; // 外层留一点边距
  const corner = W * 0.24;

  const ringOuter = W * 0.405;
  const ringInner = W * 0.405 - W * 0.092; // 环宽
  const startAngle = -Math.PI / 2;
  const sweep = Math.PI * 1.68; // 约 302 度，顺时针从正上方开始

  // 喇叭主体（相对中心的归一化坐标，按 W 缩放）；整体偏左，右侧留给声波
  const speaker = [
    [-0.27, -0.086],
    [-0.19, -0.086],
    [-0.115, -0.122],
    [-0.115, 0.122],
    [-0.19, 0.086],
    [-0.27, 0.086]
  ].map((p) => [p[0] * W + center, p[1] * W + center]);

  const wave1 = { cx: -0.12 * W, r: 0.145 * W, w: W * 0.026 };
  const wave2 = { cx: -0.12 * W, r: 0.23 * W, w: W * 0.024 };

  const put = (x, y, color, alpha) => {
    if (x < 0 || y < 0 || x >= W || y >= W || alpha <= 0) return;
    const i = (y * W + x) * 4;
    const cur = { r: buf[i], g: buf[i + 1], b: buf[i + 2], a: buf[i + 3] / 255 };
    const next = over(cur, color, alpha);
    buf[i] = Math.round(next.r);
    buf[i + 1] = Math.round(next.g);
    buf[i + 2] = Math.round(next.b);
    buf[i + 3] = Math.round(next.a * 255);
  };

  const bgTop = { r: 0x22, g: 0x26, b: 0x31 };
  const bgBottom = { r: 0x0d, g: 0x0f, b: 0x14 };
  const accentA = { r: 0xff, g: 0x5f, b: 0x56 };
  const accentB = { r: 0xff, g: 0xc7, b: 0x5c };
  const track = { r: 0xff, g: 0xc7, b: 0x5c };
  const white = { r: 0xff, g: 0xff, b: 0xff };

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // 圆角矩形遮罩
      const dx = Math.max(Math.abs(px - center) - (radius - corner), 0);
      const dy = Math.max(Math.abs(py - center) - (radius - corner), 0);
      const distCorner = Math.sqrt(dx * dx + dy * dy);
      const insideRect =
        Math.abs(px - center) <= radius - corner || Math.abs(py - center) <= radius - corner
          ? Math.max(Math.abs(px - center), Math.abs(py - center)) <= radius
          : distCorner <= corner;
      if (!insideRect) continue;

      // 背景渐变
      const t = py / W;
      put(x, y, { r: mix(bgTop.r, bgBottom.r, t), g: mix(bgTop.g, bgBottom.g, t), b: mix(bgTop.b, bgBottom.b, t) }, 1);

      const vx = px - center;
      const vy = py - center;
      const dist = Math.sqrt(vx * vx + vy * vy);

      // 音量圆弧
      if (dist <= ringOuter + 0.5 && dist >= ringInner - 0.5) {
        const edge = Math.min(ringOuter - dist, dist - ringInner);
        if (edge > -0.5) {
          let ang = Math.atan2(vy, vx) - startAngle;
          while (ang < 0) ang += Math.PI * 2;
          const onArc = ang <= sweep;
          const col = onArc
            ? {
                r: mix(accentA.r, accentB.r, Math.min(1, ang / sweep)),
                g: mix(accentA.g, accentB.g, Math.min(1, ang / sweep)),
                b: mix(accentA.b, accentB.b, Math.min(1, ang / sweep))
              }
            : track;
          const alpha = (onArc ? 1 : 0.22) * Math.max(0, Math.min(1, edge + 0.5));
          put(x, y, col, alpha);
        }
      }

      // 喇叭
      if (inPolygon(px, py, speaker)) put(x, y, white, 1);

      // 声波
      [wave1, wave2].forEach((w) => {
        const d = distanceToArc(px, py, center + w.cx, center, w.r, -Math.PI / 3.2, Math.PI / 3.2);
        const soft = Math.min(
          Math.max(0, w.w / 2 - d.radial + 0.5),
          Math.max(0, w.w / 2 - d.point + 0.5)
        );
        if (soft > 0) put(x, y, white, Math.min(1, soft) * 0.92);
      });
    }
  }

  // 下采样到目标尺寸（颜色与透明度分开平均，避免边缘发黑）
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const iAlpha = buf[i + 3];
          const w = iAlpha / 255;
          r += buf[i] * w;
          g += buf[i + 1] * w;
          b += buf[i + 2] * w;
          a += iAlpha;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const alpha = a / n;
      const wsum = a / 255 || 1;
      out[o] = Math.round(r / wsum);
      out[o + 1] = Math.round(g / wsum);
      out[o + 2] = Math.round(b / wsum);
      out[o + 3] = Math.round(alpha);
    }
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
SIZES.forEach((size) => {
  const png = encodePng(size, size, renderIcon(size));
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`✓ ${path.relative(process.cwd(), file)}  ${png.length} bytes`);
});
console.log('图标生成完成。');
