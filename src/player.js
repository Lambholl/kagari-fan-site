import * as THREE from 'three';
import { clamp, damp } from './util/noise.js';
import { heightAt, canWalkTo, isLedgeDrop, surfaceAt } from './world/terrain.js';
import { SCENE_LAYOUT } from './world/scene-layout.js';

// 主角（瑚太朗）的第一人称控制：WASD 或方向键行走，鼠标环视；触屏有虚拟摇杆。

const EYE_STAND = 1.66;
const EYE_SIT = 0.98;
const WALK = 2.5;
const RUN = 5.0;
const WORLD_R = 170;
// 不能走进她和铺开的裙摆里（圆心略偏向她身后）
const BLOCK = { x: 0.25, z: -0.14, r: 1.08 };
// 按住 X 放大的倍率：每次按下从 ZOOM_DEFAULT 开始，滚轮在 ZOOM_MIN 至 ZOOM_MAX 之间调节。
// 8 倍时默认 62° 视场角收窄到约 8.6°，足够看清山脚平原上的花；再大就像望远镜，画面也只剩少量像素在动。
const ZOOM_DEFAULT = 3;
const ZOOM_MIN = 1.25;
const ZOOM_MAX = 8;
// 滚轮每格（约 100 像素）倍率变化 2 的 1/4 次方，从 2 倍到 8 倍滚 8 格。
const ZOOM_WHEEL_PIXELS_PER_OCTAVE = 400;
// 走出崖边后腾空下落；落地处比起跳点低出 FALL_LETHAL 米就算摔死，交给剧情处理。
// 4 米远高于行走允许的台阶高度，走下普通的小坎只会落地。
const GRAVITY = 9.8;
const FALL_LETHAL = 4;
// 脚下一直没有地面（掉出地形网格）时，下落这么多米后同样算摔死，免得一直往下掉。
const FALL_VOID = 80;
// 摔死或撞树后躺在地上的视点高度（米）。
const EYE_DOWN = 0.3;
// 撞向主树树根的速度（沿指向树心方向的分量，米/秒）超过这个值就算撞死。
// 奔跑速度 5 米/秒，正面撞上约 5；与正面夹角超过约 40° 时分量低于 3.8，算擦过；走路速度 2.5 米/秒，怎么撞都不算。
const TREE_LETHAL = 3.8;
// 穿过树干掉出世界后，先在树干里滑行 CLIP_SINK_DELAY 秒再往下沉，镜头能看到树干内部。
const CLIP_SINK_DELAY = 0.3;
// 掉出世界后水平速度每秒按 e 的 -CLIP_DRAG 次方衰减。
const CLIP_DRAG = 1.2;
// 掉出世界后的最大下落速度（米/秒）。第一次穿过去的独白约一分钟：20 秒时掉到约 115 米深，
// 场景雾遮掉头顶世界的两成；50 秒约 300 米，遮掉约四分之三，独白结束时世界淡进雾里。
const CLIP_TERMINAL = 6;
// 落在走不上去的陡坡上时，沿坡往下滑的水平加速度（米/秒²）。
const SLIDE_ACCEL = 6;
// 落在可以走的地面上时，水平速度只保留这个比例。
const LANDING_KEEP = 0.3;

/** 创建第一人称玩家控制器，同步相机视角和影子替身位置。 */
export function createPlayer({ camera, dom, hooks = {} }) {
  const st = {
    x: SCENE_LAYOUT.spawn.x,
    z: SCENE_LAYOUT.spawn.z,
    yaw: 0,
    pitch: 0.12,
    roll: 0,
    eye: EYE_STAND,
    sitting: false,
    active: false, // 是否接受输入
    moveLocked: false,
    lean: 0, // 向前探身（递杯子时）
    leanTarget: 0,
    speed: 0,
    bob: 0,
    shake: 0,
    pointerLocked: false,
    touch: false,
    zoom: 1, // 当前放大倍率，平滑趋向 zoomTarget
    airborne: false, // 走出崖边后正在下落或沿陡坡下滑
    downed: false, // 摔死或撞树后躺在地上，直到 teleport
    clipping: false, // 穿过树干掉出世界，直到 teleport
  };
  let zoomTarget = 1;
  // 下落中的脚底高度、竖直速度、起跳点高度，以及是否已通知过摔死。
  const fall = { feet: 0, vy: 0, top: 0, isReported: false };
  // 穿过树干后已经过的秒数，以及脚底高度和竖直速度。
  const clip = { t: 0, feet: 0, vy: 0 };
  const keys = new Set();
  const vel = new THREE.Vector2();
  const joy = { id: null, sx: 0, sy: 0, x: 0, y: 0 };
  const lookTouch = { id: null, x: 0, y: 0 };
  let dragging = false;
  let lookSensitivity = 1;

  camera.rotation.order = 'YXZ';

  // 只用来投下影子的替身——月光把主角的影子长长地拖在身后
  const body = new THREE.Group();
  const shadowMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.95, 4, 10), shadowMat);
  torso.position.y = 0.72;
  const headS = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), shadowMat);
  headS.position.y = 1.55;
  torso.castShadow = headS.castShadow = true;
  body.add(torso, headS);

  const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

  function onKeyDown(e) {
    // 设置打开时，方向键与确认键留给页面控件。
    if (e.repeat || hooks.inputBlocked?.(e.target)) return;
    keys.add(e.code);
    if (!st.active) return;
    if (e.code === 'KeyE' || e.code === 'KeyF' || e.code === 'Enter') hooks.onAction?.();
    if (e.code === 'Space') {
      e.preventDefault();
      hooks.onAdvance?.();
    }
    if (e.code === 'KeyC' && !st.moveLocked) setSitting(!st.sitting);
    if (e.code === 'KeyX') zoomTarget = ZOOM_DEFAULT;
    if (MOVE_KEYS.includes(e.code)) {
      if (e.code.startsWith('Arrow')) e.preventDefault();
      if (st.sitting && !st.moveLocked) setSitting(false);
    }
  }
  function onKeyUp(e) {
    keys.delete(e.code);
    if (e.code === 'KeyX') zoomTarget = 1;
  }
  function onWheel(e) {
    if (zoomTarget === 1) return;
    // 放大时滚轮只调倍率，并阻止页面滚动。
    e.preventDefault();
    const pixels = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? window.innerHeight : 1);
    zoomTarget = clamp(zoomTarget * 2 ** (-pixels / ZOOM_WHEEL_PIXELS_PER_OCTAVE), ZOOM_MIN, ZOOM_MAX);
  }
  function rotate(dx, dy, sens) {
    // 躺倒在地上或掉出世界时视线由剧情控制，忽略鼠标和触屏的转动。
    if (st.downed || st.clipping) return;
    // 放大后同样的鼠标位移按倍率缩小转角，准星在画面上移动的速度与不放大时一致。
    const turn = sens * lookSensitivity / st.zoom;
    st.yaw -= dx * turn;
    st.pitch = clamp(st.pitch - dy * turn, -1.45, 1.45);
  }
  function onMouseMove(e) {
    if (!st.active) return;
    if (document.pointerLockElement === dom) rotate(e.movementX, e.movementY, 0.0021);
    else if (dragging) rotate(-e.movementX, -e.movementY, 0.004);
  }
  function onMouseDown(e) {
    if (!st.active || st.touch) return;
    if (e.button !== 0) return;
    if (document.pointerLockElement !== dom) {
      dragging = true;
      // 指针锁定可能被环境拒绝；失败时退回按住拖动环视
      try {
        const p = dom.requestPointerLock?.();
        if (p && p.catch) p.catch(() => {});
      } catch {
        /* ignore */
      }
    } else hooks.onAdvance?.();
  }
  function onMouseUp() {
    dragging = false;
  }
  function onLockChange() {
    st.pointerLocked = document.pointerLockElement === dom;
    if (st.pointerLocked) dragging = false;
    hooks.onLockChange?.(st.pointerLocked);
  }

  // —— 触屏 ——
  function onTouchStart(e) {
    st.touch = true;
    if (!st.active) return;
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth * 0.45 && joy.id === null) {
        joy.id = t.identifier;
        joy.sx = t.clientX;
        joy.sy = t.clientY;
        joy.x = joy.y = 0;
        hooks.onJoystick?.(true, joy.sx, joy.sy, 0, 0);
      } else if (lookTouch.id === null) {
        lookTouch.id = t.identifier;
        lookTouch.x = t.clientX;
        lookTouch.y = t.clientY;
      }
    }
  }
  function onTouchMove(e) {
    if (!st.active) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        const dx = t.clientX - joy.sx;
        const dy = t.clientY - joy.sy;
        const len = Math.hypot(dx, dy);
        const m = Math.min(len, 56);
        joy.x = len > 0 ? (dx / len) * (m / 56) : 0;
        joy.y = len > 0 ? (dy / len) * (m / 56) : 0;
        hooks.onJoystick?.(true, joy.sx, joy.sy, joy.x * 56, joy.y * 56);
        if (st.sitting && !st.moveLocked && m > 20) setSitting(false);
      } else if (t.identifier === lookTouch.id) {
        // 手指往哪边划，视线就往哪边转，和指针锁定时的鼠标方向一致。
        rotate(t.clientX - lookTouch.x, t.clientY - lookTouch.y, 0.0052);
        lookTouch.x = t.clientX;
        lookTouch.y = t.clientY;
      }
    }
  }
  function onTouchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        joy.id = null;
        joy.x = joy.y = 0;
        hooks.onJoystick?.(false, 0, 0, 0, 0);
      } else if (t.identifier === lookTouch.id) lookTouch.id = null;
    }
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    keys.clear();
    // 切走窗口时收不到 X 的松开事件。
    zoomTarget = 1;
  });
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  dom.addEventListener('mousedown', onMouseDown);
  document.addEventListener('pointerlockchange', onLockChange);
  dom.addEventListener('touchstart', onTouchStart, { passive: true });
  dom.addEventListener('touchmove', onTouchMove, { passive: false });
  dom.addEventListener('touchend', onTouchEnd);
  dom.addEventListener('touchcancel', onTouchEnd);

  function setSitting(v) {
    if (st.sitting === v) return;
    st.sitting = v;
    hooks.onSit?.(v);
  }

  // 这一步会进入主树树根范围，并且朝树心方向的速度够快。
  function isTreeCrash(nx, nz) {
    const { tree } = SCENE_LAYOUT;
    if (Math.hypot(nx - tree.x, nz - tree.z) >= tree.radius) return false;
    const dx = tree.x - st.x;
    const dz = tree.z - st.z;
    const d = Math.hypot(dx, dz) || 1;
    return (vel.x * dx + vel.y * dz) / d > TREE_LETHAL;
  }

  function crashIntoTree() {
    st.downed = true;
    st.shake = 1.5;
    vel.set(0, 0);
    hooks.onTreeCrash?.();
  }

  function clipThroughTree() {
    st.clipping = true;
    clip.t = 0;
    clip.feet = heightAt(st.x, st.z);
    clip.vy = 0;
    hooks.onTreeClip?.();
  }

  function updateClip(dt) {
    clip.t += dt;
    vel.multiplyScalar(Math.exp(-CLIP_DRAG * dt));
    if (clip.t > CLIP_SINK_DELAY) {
      clip.vy = Math.max(clip.vy - GRAVITY * dt, -CLIP_TERMINAL);
      clip.feet += clip.vy * dt;
    }
  }

  function startFall() {
    st.airborne = true;
    fall.feet = fall.top = heightAt(st.x, st.z);
    fall.vy = 0;
    fall.isReported = false;
  }

  // 腾空一帧：按重力下落；碰到可以走的地面就落地，碰到陡坡就贴着坡面往下滑。
  // (nx, nz) 是这一帧的水平目标位置。
  function updateFall(nx, nz, dt) {
    fall.vy -= GRAVITY * dt;
    fall.feet += fall.vy * dt;
    const surface = surfaceAt(nx, nz);
    if (surface && fall.feet <= surface.height) {
      fall.feet = surface.height;
      if (surface.normalY >= 0.78) {
        st.airborne = false;
        hooks.onLand?.(-fall.vy);
        st.shake = Math.max(st.shake, Math.min(1.5, -fall.vy * 0.12));
        if (fall.top - surface.height > FALL_LETHAL) {
          st.downed = true;
          vel.set(0, 0);
          reportFall();
        } else vel.multiplyScalar(LANDING_KEEP);
      } else {
        // 坡面高度沿 x、z 的差分给出下坡方向。
        const gx = (surfaceAt(nx + 0.25, nz)?.height ?? surface.height) - (surfaceAt(nx - 0.25, nz)?.height ?? surface.height);
        const gz = (surfaceAt(nx, nz + 0.25)?.height ?? surface.height) - (surfaceAt(nx, nz - 0.25)?.height ?? surface.height);
        const g = Math.hypot(gx, gz) || 1;
        vel.x -= (gx / g) * SLIDE_ACCEL * dt;
        vel.y -= (gz / g) * SLIDE_ACCEL * dt;
        fall.vy = Math.min(fall.vy, 0);
      }
    }
    if (!surface && fall.top - fall.feet > FALL_VOID) reportFall();
  }

  // 通知剧情摔死，每次下落只通知一次。
  function reportFall() {
    if (fall.isReported) return;
    fall.isReported = true;
    hooks.onFall?.();
  }

  function update(dt) {
    // 剧情接管镜头时松开放大。
    if (!st.active) zoomTarget = 1;
    // 在对数空间里平滑，放大和缩小的快慢一致。
    st.zoom = Math.exp(damp(Math.log(st.zoom), Math.log(zoomTarget), 14, dt));
    if (Math.abs(st.zoom - zoomTarget) < 1e-3) st.zoom = zoomTarget;

    // —— 移动 ——
    let mx = 0;
    let mz = 0;
    if (st.active && !st.moveLocked && !st.sitting && !st.downed && !hooks.inputBlocked?.()) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) mz -= 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) mz += 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) mx -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) mx += 1;
      mx += joy.x;
      mz += joy.y;
    }
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    const running = keys.has('ShiftLeft') || keys.has('ShiftRight') || Math.hypot(joy.x, joy.y) > 0.92;
    const sp = running ? RUN : WALK;
    const sin = Math.sin(st.yaw);
    const cos = Math.cos(st.yaw);
    // yaw = 0 时面朝 -z
    const wx = (mx * cos + mz * sin) * sp;
    const wz = (-mx * sin + mz * cos) * sp;
    // 腾空和掉出世界时不受操控，保持离开地面时的水平速度。
    if (!st.airborne && !st.clipping) {
      vel.x = damp(vel.x, wx, 10, dt);
      vel.y = damp(vel.y, wz, 10, dt);
    }
    if (st.clipping) updateClip(dt);
    let nx = st.x + vel.x * dt;
    let nz = st.z + vel.y * dt;

    // 她的身体与裙摆
    const bx = nx - BLOCK.x;
    const bz = nz - BLOCK.z;
    const bd = Math.hypot(bx, bz);
    if (bd < BLOCK.r && !st.clipping) {
      nx = BLOCK.x + (bx / (bd || 1)) * BLOCK.r;
      nz = BLOCK.z + (bz / (bd || 1)) * BLOCK.r;
    }
    // “今夜”的边界
    const r = Math.hypot(nx, nz);
    if (r > WORLD_R && !st.clipping) {
      nx *= WORLD_R / r;
      nz *= WORLD_R / r;
      hooks.onBoundary?.();
    }
    // 掉出世界后跳过所有阻挡和地面检查，包括上面篝的裙摆和“今夜”的边界，主角穿过地面一直往下掉。
    if (st.clipping) {
      // 位置已经由 updateClip 和水平速度算好。
    } else if (st.airborne) {
      updateFall(nx, nz, dt);
    } else if (isTreeCrash(nx, nz)) {
      if (hooks.shouldClipThroughTree?.()) clipThroughTree();
      else {
        crashIntoTree();
        nx = st.x;
        nz = st.z;
      }
    } else if (!canWalkTo(nx, nz, st.x, st.z)) {
      // 往下走出崖边就腾空；往上的陡坡和树根仍然挡住，尝试沿单个坐标轴滑动。
      if (isLedgeDrop(nx, nz, st.x, st.z)) startFall();
      else if (canWalkTo(nx, st.z, st.x, st.z)) nz = st.z;
      else if (canWalkTo(st.x, nz, st.x, st.z)) nx = st.x;
      else { nx = st.x; nz = st.z; }
    }
    const moved = Math.hypot(nx - st.x, nz - st.z);
    st.x = nx;
    st.z = nz;
    st.speed = moved / Math.max(dt, 1e-4);

    // —— 视点 ——
    st.eye = damp(st.eye, st.downed ? EYE_DOWN : st.sitting ? EYE_SIT : EYE_STAND, 5, dt);
    st.lean = damp(st.lean, st.leanTarget, 4, dt);
    const prevBob = st.bob;
    // 腾空和掉出世界时停住脚步声和视线起伏。
    const isOffGround = st.airborne || st.clipping;
    if (!isOffGround) st.bob += moved * 1.75;
    if (Math.floor(prevBob / Math.PI) !== Math.floor(st.bob / Math.PI) && moved > 0) hooks.onStep?.(st.x, st.z, running);
    const bobAmt = isOffGround ? 0 : Math.min(1, st.speed / WALK);
    const bobY = Math.abs(Math.sin(st.bob)) * 0.035 * bobAmt;
    const ground = st.clipping ? clip.feet : st.airborne ? fall.feet : heightAt(st.x, st.z);
    st.shake = damp(st.shake, 0, 4, dt);
    const shx = (Math.random() - 0.5) * st.shake * 0.06;
    const shy = (Math.random() - 0.5) * st.shake * 0.06;
    camera.position.set(
      st.x - sin * st.lean + shx,
      ground + st.eye + bobY - st.lean * 0.25 + shy,
      st.z - cos * st.lean,
    );
    camera.rotation.set(st.pitch, st.yaw, st.roll + Math.sin(st.bob) * 0.004 * bobAmt);
    body.position.set(st.x, ground, st.z);
    body.scale.y = st.eye / EYE_STAND;
  }

  return {
    state: st,
    body,
    update,
    setSitting,
    /**
     * 设置鼠标和触屏环视的灵敏度倍率。
     * @param {number} multiplier - 1 为默认速度，必须大于 0。
     * @returns {void}
     */
    setLookSensitivity(multiplier) {
      lookSensitivity = multiplier;
    },
    teleport(x, z, yaw, pitch = 0) {
      st.x = x;
      st.z = z;
      st.yaw = yaw;
      st.pitch = pitch;
      st.roll = 0;
      st.airborne = false;
      st.downed = false;
      st.clipping = false;
      vel.set(0, 0);
    },
    /** 面向某个世界坐标所需的 yaw 和 pitch（弧度）。 */
    aimAt(target, out = {}) {
      const dx = target.x - camera.position.x;
      const dy = target.y - camera.position.y;
      const dz = target.z - camera.position.z;
      out.yaw = Math.atan2(-dx, -dz);
      out.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      return out;
    },
    requestLock() {
      if (st.touch) return;
      try {
        const p = dom.requestPointerLock?.();
        if (p && p.catch) p.catch(() => {});
      } catch {
        /* ignore */
      }
    },
  };
}
