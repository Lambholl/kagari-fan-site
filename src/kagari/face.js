import * as THREE from 'three';

// 脸画在一张等距柱状贴图上，直接包在头部球面上。
// 贴图中心 u=0.25 对应正面（+z）。全部由 canvas 现画，不使用任何现成图像。
const W = 2048;
const H = 1024;
const px = (lonDeg) => W * (0.25 + lonDeg / 360);
const py = (latDeg) => H * (0.5 - latDeg / 180);

const SKIN = '#ffe8d4';

/**
 * 眼睛的轮廓（以内眼角朝 -x 描述，即她左眼；另一只镜像）。
 * 照立绘：纵向偏长的 D 形——上缘较平、向外眼角微微下压，下缘圆润。
 * hi < 1 时上眼睑落下（眯眼），lo < 1 时下眼睑抬起（微笑）。
 */
function eyeOutline(w2, h2, hi, lo) {
  return {
    inner: [-0.9 * w2, -0.28 * h2 * hi],
    top: [
      [-0.62 * w2, -0.86 * h2 * hi, -0.1 * w2, -1.0 * h2 * hi, 0.32 * w2, -0.96 * h2 * hi],
      [0.66 * w2, -0.92 * h2 * hi, 0.92 * w2, -0.76 * h2 * hi, 1.0 * w2, -0.42 * h2 * hi],
    ],
    bottom: [
      [1.04 * w2, 0.22 * h2 * lo, 0.82 * w2, 0.92 * h2 * lo, 0.14 * w2, 0.98 * h2 * lo],
      [-0.52 * w2, 1.02 * h2 * lo, -0.94 * w2, 0.5 * h2 * lo, -0.9 * w2, -0.28 * h2 * hi],
    ],
  };
}

function tracePath(ctx, o, closed = true) {
  ctx.beginPath();
  ctx.moveTo(o.inner[0], o.inner[1]);
  for (const s of o.top) ctx.bezierCurveTo(...s);
  if (!closed) return;
  for (const s of o.bottom) ctx.bezierCurveTo(...s);
  ctx.closePath();
}

function drawEye(ctx, cx, cy, mirror, soft, narrow) {
  const w2 = 80;
  const h2 = 100;
  const hi = 1 - 0.32 * narrow - 0.06 * soft;
  const lo = 1 - 0.28 * soft;
  const o = eyeOutline(w2, h2, hi, lo);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(mirror ? -1 : 1, 1);

  // 眼白：只在内外眼角露出一点
  tracePath(ctx, o);
  ctx.fillStyle = '#fbfaff';
  ctx.fill();
  ctx.save();
  tracePath(ctx, o);
  ctx.clip();

  // 虹膜：几乎占满整个眼眶，上缘被上眼睑切掉；上深、下浅的紫，没有描边
  const ix = 0.06 * w2;
  const iy = 0.1 * h2;
  const irx = 0.78 * w2;
  const iry = 0.98 * h2;
  let g = ctx.createLinearGradient(0, iy - iry, 0, iy + iry);
  // 偏紫而不是偏蓝（参照立绘与动画）
  g.addColorStop(0.0, '#22104a');
  g.addColorStop(0.28, '#46289a');
  g.addColorStop(0.58, '#7656d2');
  g.addColorStop(0.82, '#a890ee');
  g.addColorStop(1.0, '#dccdfc');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(ix, iy, irx, iry, 0, 0, Math.PI * 2);
  ctx.fill();
  // 虹膜边缘自然变暗（代替生硬的描边）
  g = ctx.createRadialGradient(ix, iy, irx * 0.55, ix, iy, irx * 1.02);
  g.addColorStop(0, 'rgba(20,10,70,0)');
  g.addColorStop(1, 'rgba(20,10,70,0.55)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(ix, iy, irx, iry, 0, 0, Math.PI * 2);
  ctx.fill();
  // 瞳孔：竖长的暗椭圆
  g = ctx.createLinearGradient(0, iy - 0.5 * h2, 0, iy + 0.4 * h2);
  g.addColorStop(0, 'rgba(12,6,40,0.95)');
  g.addColorStop(1, 'rgba(40,24,110,0.6)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(ix, iy - 0.06 * h2, 0.3 * w2, 0.46 * h2, 0, 0, Math.PI * 2);
  ctx.fill();
  // 上眼睑投下的影子
  g = ctx.createLinearGradient(0, -h2 * hi, 0, -0.15 * h2);
  g.addColorStop(0, 'rgba(10,4,40,0.85)');
  g.addColorStop(1, 'rgba(10,4,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-1.2 * w2, -1.2 * h2, 2.4 * w2, 1.2 * h2);
  // 虹膜下半的亮弧
  g = ctx.createRadialGradient(ix, iy + iry * 0.62, 2, ix, iy + iry * 0.62, irx * 0.85);
  g.addColorStop(0, 'rgba(222,212,255,0.85)');
  g.addColorStop(1, 'rgba(222,212,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(ix, iy + iry * 0.55, irx * 0.78, iry * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 上睫毛：粗而平的一道，越往外眼角越粗
  ctx.strokeStyle = '#231a36';
  ctx.lineWidth = 9;
  tracePath(ctx, o, false);
  ctx.stroke();
  ctx.lineWidth = 15;
  ctx.beginPath();
  ctx.moveTo(o.top[0][4], o.top[0][5]);
  ctx.bezierCurveTo(...o.top[1]);
  ctx.stroke();
  // 外眼角的一小撮睫毛
  ctx.fillStyle = '#231a36';
  ctx.beginPath();
  ctx.moveTo(0.72 * w2, -0.86 * h2 * hi);
  ctx.quadraticCurveTo(1.12 * w2, -0.82 * h2 * hi, 1.18 * w2, -0.5 * h2 * hi);
  ctx.quadraticCurveTo(1.06 * w2, -0.5 * h2 * hi, 0.98 * w2, -0.2 * h2 * hi);
  ctx.closePath();
  ctx.fill();
  // 内眼角一小段细线
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(o.inner[0], o.inner[1]);
  ctx.quadraticCurveTo(-0.98 * w2, 0.0, -0.92 * w2, 0.18 * h2);
  ctx.stroke();
  // 下眼睑：只在外侧有一小段淡色的线
  ctx.strokeStyle = 'rgba(96,62,90,0.85)';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(0.98 * w2, 0.32 * h2 * lo);
  ctx.bezierCurveTo(0.9 * w2, 0.78 * h2 * lo, 0.6 * w2, 0.95 * h2 * lo, 0.3 * w2, 0.98 * h2 * lo);
  ctx.stroke();
  if (soft > 0.01) {
    // 微笑：下眼睑推上来的一道柔和弧线
    ctx.strokeStyle = `rgba(96,62,90,${0.55 * soft})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0.3 * w2, 0.98 * h2 * lo);
    ctx.bezierCurveTo(-0.3 * w2, 1.02 * h2 * lo, -0.8 * w2, 0.7 * h2 * lo, -0.9 * w2, 0.25 * h2);
    ctx.stroke();
  }
  // 双眼皮：上方一道淡淡的粉棕色细线
  ctx.strokeStyle = 'rgba(190,120,125,0.6)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-0.45 * w2, -1.06 * h2 * hi - 14);
  ctx.quadraticCurveTo(0.25 * w2, -1.2 * h2 * hi - 14, 0.86 * w2, -0.96 * h2 * hi - 12);
  ctx.stroke();
  ctx.restore();

  // 高光不镜像：照立绘，两只眼睛的大高光都在虹膜右上
  ctx.fillStyle = '#ffffff';
  const hx = cx + 0.3 * w2;
  const hy = cy - 0.26 * h2 * hi;
  ctx.beginPath();
  ctx.ellipse(hx, hy, 0.2 * w2, 0.17 * h2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(cx - 0.34 * w2, cy - 0.5 * h2 * hi, 0.075 * w2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(cx - 0.2 * w2, cy + 0.55 * h2, 0.06 * w2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/**
 * @param {object} o
 * @param {number} o.soft   0 = 无表情，1 = 柔和的微笑
 * @param {number} o.narrow 0..1，眯起眼睛凝视
 */
function drawFace({ soft = 0, narrow = 0 } = {}) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = SKIN;
  ctx.fillRect(0, 0, W, H);

  // 刘海投在额头上的影子
  let g = ctx.createLinearGradient(0, py(60), 0, py(8));
  g.addColorStop(0, 'rgba(196,170,205,0.55)');
  g.addColorStop(1, 'rgba(196,170,205,0)');
  ctx.fillStyle = g;
  ctx.fillRect(px(-90), py(70), px(90) - px(-90), py(8) - py(70));
  // 下巴底下偏暗
  g = ctx.createLinearGradient(0, py(-55), 0, py(-90));
  g.addColorStop(0, 'rgba(214,160,160,0)');
  g.addColorStop(1, 'rgba(214,160,160,0.6)');
  ctx.fillStyle = g;
  ctx.fillRect(0, py(-55), W, py(-90) - py(-55));

  // 腮红：眼睛正下方一片，带几道斜线
  for (const sgn of [-1, 1]) {
    const bx = px(sgn * 30);
    const by = py(-31);
    ctx.save();
    ctx.translate(bx, by);
    ctx.scale(1.8, 1);
    g = ctx.createRadialGradient(0, 0, 2, 0, 0, 40);
    g.addColorStop(0, `rgba(255,120,135,${0.5 + 0.15 * soft})`);
    g.addColorStop(1, 'rgba(255,120,135,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 40, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(225,95,115,0.55)';
    ctx.lineWidth = 2.5;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(bx + i * 12 - 5, by + 8);
      ctx.lineTo(bx + i * 12 + 5, by - 8);
      ctx.stroke();
    }
  }

  // 眼睛
  const eyeLat = -11;
  const eyeLon = 28;
  drawEye(ctx, px(eyeLon), py(eyeLat), false, soft, narrow);
  drawEye(ctx, px(-eyeLon), py(eyeLat), true, soft, narrow);

  // 眉：几乎被刘海盖住的细线
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(150,140,190,0.9)';
  ctx.lineWidth = 5;
  for (const sgn of [-1, 1]) {
    const x0 = px(sgn * 14);
    const x1 = px(sgn * 38);
    const yb = py(13 + 1.5 * soft);
    ctx.beginPath();
    ctx.moveTo(x0, yb + 5 - 6 * narrow);
    ctx.quadraticCurveTo((x0 + x1) / 2, yb - 9 - 4 * soft, x1, yb + 3);
    ctx.stroke();
  }

  // 鼻：立绘里只是一个小小的、带点粉色的鼻尖
  {
    const nx = px(0) + 2;
    const ny = py(-30);
    g = ctx.createRadialGradient(nx, ny, 1, nx, ny, 10);
    g.addColorStop(0, 'rgba(220,130,125,0.75)');
    g.addColorStop(1, 'rgba(220,130,125,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(nx, ny, 10, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(175,95,95,0.85)';
    ctx.beginPath();
    ctx.ellipse(nx + 1, ny + 1, 3, 2.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 嘴：小小的、淡粉色
  const mx = px(0);
  const my = py(-45);
  ctx.lineCap = 'round';
  if (soft > 0.5) {
    // 只有嘴角微微上扬的、没有声音的笑
    ctx.strokeStyle = '#b05866';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(mx - 22, my - 4);
    ctx.quadraticCurveTo(mx, my + 10, mx + 22, my - 4);
    ctx.stroke();
  } else {
    // 微微张开的小嘴：上唇一道短线，下面一点粉色
    ctx.fillStyle = 'rgba(238,140,145,0.8)';
    ctx.beginPath();
    ctx.ellipse(mx, my + 4, 8, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#a24f5c';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(mx - 10, my + 1);
    ctx.quadraticCurveTo(mx, my - 3, mx + 10, my + 1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function makeFaceTextures() {
  return {
    neutral: drawFace({ soft: 0, narrow: 0 }),
    stare: drawFace({ soft: 0, narrow: 1 }),
    smile: drawFace({ soft: 1, narrow: 0 }),
  };
}
