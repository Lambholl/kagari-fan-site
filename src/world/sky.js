import * as THREE from 'three';
import { makeNoise2D, fbm, mulberry32, smoothstep } from '../util/noise.js';
import { createMoon } from './moon.js';

/**
 * 月轮的单位方向，世界坐标以 +y 为天顶、-z 为月面真北。
 */
export const MOON_DIR = (() => {
  const az = THREE.MathUtils.degToRad(16); // 自正北(-z)向东(+x)偏转
  const el = THREE.MathUtils.degToRad(25);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
})();

const SKY_R = 1500;
const MOON_ANGULAR_RADIUS = THREE.MathUtils.degToRad(10.5);

function makeCloudTexture(seed) {
  const W = 512;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const n = makeNoise2D(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      const f = fbm(n, u * 5, v * 3.2, 5);
      // 椭圆衰减，底边更厚实，顶边蓬松
      const ex = (u - 0.5) * 2;
      const ey = (v - 0.58) * 2.4;
      const fall = 1 - smoothstep(0.35, 1.0, Math.sqrt(ex * ex + ey * ey));
      const a = smoothstep(0.42, 0.75, f * 0.75 + fall * 0.5) * fall;
      const i = (y * W + x) * 4;
      const lum = 150 + f * 105;
      img.data[i] = lum;
      img.data[i + 1] = lum;
      img.data[i + 2] = lum;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 创建夜空、星点、月轮和地平线云，返回场景节点与更新方法。
 * @returns {object} group 为天空节点，moon 为月轮节点。
 */
export function createSky() {
  const group = new THREE.Group();
  group.name = 'sky';

  // —— 天穹 ——
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uMoonDir: { value: MOON_DIR.clone() },
      uMoonRadius: { value: MOON_ANGULAR_RADIUS },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uMoonDir;
      uniform float uMoonRadius;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 zen = vec3(0.0001, 0.00025, 0.0006);
        vec3 mid = vec3(0.0004, 0.0010, 0.0026);
        vec3 hor = vec3(0.0012, 0.0028, 0.0060);
        vec3 col = mix(hor, mid, smoothstep(0.0, 0.28, h));
        col = mix(col, zen, smoothstep(0.2, 0.95, h));
        float md = clamp(dot(d, uMoonDir), -1.0, 1.0);
        // 从月轮边缘向外连续衰减，避免外壳形成一圈硬边。
        float outside = max(acos(md) - uMoonRadius, 0.0);
        col += vec3(0.045, 0.085, 0.12) * exp(-outside / 0.009);
        col += vec3(0.001, 0.002, 0.004) * exp(-outside / 0.045);
        // 地平线以下沉入黑暗
        col = mix(col, vec3(0.0005, 0.0010, 0.0020), 1.0 - smoothstep(-0.12, 0.0, d.y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 48, 24), domeMat);
  dome.renderOrder = -20;
  dome.frustumCulled = false;
  group.add(dome);

  // —— 星 ——
  const rand = mulberry32(909);
  const STAR_N = 2600;
  const sp = new Float32Array(STAR_N * 3);
  const ss = new Float32Array(STAR_N);
  const sc = new Float32Array(STAR_N * 3);
  for (let i = 0; i < STAR_N; i++) {
    // 整个球面均匀分布（延时摄影般旋转时，地平线下的星会升上来）
    const u = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const R = SKY_R * 0.96;
    sp[i * 3] = Math.cos(a) * s * R;
    sp[i * 3 + 1] = u * R;
    sp[i * 3 + 2] = Math.sin(a) * s * R;
    const mag = Math.pow(rand(), 5);
    ss[i] = 1.2 + mag * 3.4;
    const warm = rand();
    const br = 0.5 + rand() * 0.5 + mag * 0.6;
    sc[i * 3] = br * (0.8 + warm * 0.25);
    sc[i * 3 + 1] = br * (0.88 + warm * 0.1);
    sc[i * 3 + 2] = br * (1.05 - warm * 0.15);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
  starGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const starMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    vertexColors: true,
    uniforms: {
      uPixelRatio: { value: 1 },
      uMoonDir: { value: MOON_DIR.clone() },
      uGroupRot: { value: new THREE.Matrix3() },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uPixelRatio;
      uniform vec3 uMoonDir;
      uniform mat3 uGroupRot;
      varying vec3 vColor;
      varying float vFade;
      varying float vIntensity;
      void main() {
        vColor = color;
        vec3 wd = normalize(uGroupRot * position);
        // 靠近地平线与月亮的星被冲淡
        float md = max(dot(wd, uMoonDir), 0.0);
        vFade = smoothstep(-0.02, 0.22, wd.y) * (1.0 - smoothstep(0.80, 0.985, md));
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // 扩大暗星的覆盖面积并降低峰值，减少亚像素移动造成的亮度跳变。
        float size = max(aSize, 3.0);
        vIntensity = (aSize * aSize) / (size * size);
        gl_PointSize = size * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vFade;
      varying float vIntensity;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float r2 = dot(p, p);
        float a = exp(-18.0 * r2) * (1.0 - smoothstep(0.18, 0.25, r2));
        gl_FragColor = vec4(vColor * vIntensity, a * vFade);
      }
    `,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -19;
  // 让星空绕一根倾斜的天轴转动
  const starPivot = new THREE.Group();
  starPivot.rotation.set(THREE.MathUtils.degToRad(52), 0, THREE.MathUtils.degToRad(8));
  starPivot.add(stars);
  group.add(starPivot);

  // —— 月 ——
  const moonR = Math.sin(MOON_ANGULAR_RADIUS) * SKY_R * 0.9;
  const lunar = createMoon(moonR, MOON_DIR);
  const moon = lunar.group;
  moon.frustumCulled = false;
  group.add(moon);

  // —— 贴着地平线的云 ——
  const clouds = new THREE.Group();
  const cloudTex = [makeCloudTexture(51), makeCloudTexture(52), makeCloudTexture(53)];
  const CLOUD_N = 16;
  const cloudItems = [];
  for (let i = 0; i < CLOUD_N; i++) {
    const az = (i / CLOUD_N) * Math.PI * 2 + rand() * 0.3;
    const el = THREE.MathUtils.degToRad(1.5 + rand() * 7.5);
    const dist = SKY_R * 0.86;
    const w = 520 + rand() * 520;
    const hgt = w * (0.3 + rand() * 0.14);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const md = Math.max(0, dir.dot(MOON_DIR));
    const lit = 0.16 + 0.75 * Math.pow(md, 3);
    const mat = new THREE.MeshBasicMaterial({
      map: cloudTex[i % 3],
      transparent: true,
      depthWrite: false,
      fog: false,
      opacity: 0.55 + rand() * 0.3,
      color: new THREE.Color(0.025 * lit + 0.001, 0.04 * lit + 0.002, 0.065 * lit + 0.004),
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, hgt), mat);
    mesh.position.copy(dir).multiplyScalar(dist);
    mesh.lookAt(0, 0, 0);
    mesh.renderOrder = -17;
    mesh.frustumCulled = false;
    clouds.add(mesh);
    cloudItems.push(mesh);
  }
  group.add(clouds);

  const tmpM4 = new THREE.Matrix4();
  const state = { lapse: 0, starAngle: 0, cloudAngle: 0 };

  return {
    group,
    moon,
    /**
     * 设置星空旋转和云层移动的时间加速系数。
     * @param {number} v 0 为平时的夜空，1 为剧情时间加速的最大速度。
     */
    setLapse(v) {
      state.lapse = v;
    },
    /**
     * 跟随相机位置更新天空，并推进星空旋转和云层移动。
     * @param {number} dt 距上一帧的秒数。
     * @param {THREE.Camera} camera 当前相机。
     * @param {number} pixelRatio 渲染器采用的设备像素比。
     */
    update(dt, camera, pixelRatio) {
      group.position.copy(camera.position);
      moon.position.copy(MOON_DIR).multiplyScalar(SKY_R * 0.9);
      lunar.update(dt, state.lapse);
      // 平时星点保持固定，仅在剧情的时间加速段旋转星空。
      state.starAngle += dt * state.lapse * 0.9;
      state.cloudAngle += dt * (0.0006 + state.lapse * 0.35);
      stars.rotation.y = state.starAngle;
      clouds.rotation.y = state.cloudAngle;
      group.updateMatrixWorld(true);
      tmpM4.copy(stars.matrixWorld);
      starMat.uniforms.uGroupRot.value.setFromMatrix4(tmpM4);
      starMat.uniforms.uPixelRatio.value = pixelRatio;
    },
  };
}
