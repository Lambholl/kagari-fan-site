import * as THREE from 'three';
import { clamp, damp } from './util/noise.js';
import { heightAt } from './world/terrain.js';

// 主角（瑚太朗）的第一人称控制：WASD / 方向键行走，鼠标环视；触屏有虚拟摇杆。

const EYE_STAND = 1.66;
const EYE_SIT = 0.98;
const WALK = 2.5;
const RUN = 5.0;
const WORLD_R = 72;
// 不能走进她和铺开的裙摆里（圆心略偏向她身后）
const BLOCK = { x: 0.25, z: -0.14, r: 1.08 };

export function createPlayer({ camera, dom, hooks = {} }) {
  const st = {
    x: 0,
    z: 36,
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
  };
  const keys = new Set();
  const vel = new THREE.Vector2();
  const joy = { id: null, sx: 0, sy: 0, x: 0, y: 0 };
  const lookTouch = { id: null, x: 0, y: 0 };
  let dragging = false;

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
    if (e.repeat) return;
    keys.add(e.code);
    if (!st.active) return;
    if (e.code === 'KeyE' || e.code === 'KeyF' || e.code === 'Enter') hooks.onAction?.();
    if (e.code === 'Space') {
      e.preventDefault();
      hooks.onAdvance?.();
    }
    if (e.code === 'KeyC' && !st.moveLocked) setSitting(!st.sitting);
    if (MOVE_KEYS.includes(e.code)) {
      if (e.code.startsWith('Arrow')) e.preventDefault();
      if (st.sitting && !st.moveLocked) setSitting(false);
    }
  }
  function onKeyUp(e) {
    keys.delete(e.code);
  }
  function rotate(dx, dy, sens) {
    st.yaw -= dx * sens;
    st.pitch = clamp(st.pitch - dy * sens, -1.45, 1.45);
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
      // 指针锁定可能被环境拒绝；失败时退回“按住拖动环视”
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
        rotate(-(t.clientX - lookTouch.x), -(t.clientY - lookTouch.y), 0.0052);
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
  window.addEventListener('blur', () => keys.clear());
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

  function update(dt) {
    // —— 移动 ——
    let mx = 0;
    let mz = 0;
    if (st.active && !st.moveLocked && !st.sitting) {
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
    vel.x = damp(vel.x, wx, 10, dt);
    vel.y = damp(vel.y, wz, 10, dt);
    let nx = st.x + vel.x * dt;
    let nz = st.z + vel.y * dt;

    // 她的身体与裙摆
    const bx = nx - BLOCK.x;
    const bz = nz - BLOCK.z;
    const bd = Math.hypot(bx, bz);
    if (bd < BLOCK.r) {
      nx = BLOCK.x + (bx / (bd || 1)) * BLOCK.r;
      nz = BLOCK.z + (bz / (bd || 1)) * BLOCK.r;
    }
    // “今夜”的边界
    const r = Math.hypot(nx, nz);
    if (r > WORLD_R) {
      nx *= WORLD_R / r;
      nz *= WORLD_R / r;
      hooks.onBoundary?.();
    }
    const moved = Math.hypot(nx - st.x, nz - st.z);
    st.x = nx;
    st.z = nz;
    st.speed = moved / Math.max(dt, 1e-4);

    // —— 视点 ——
    st.eye = damp(st.eye, st.sitting ? EYE_SIT : EYE_STAND, 5, dt);
    st.lean = damp(st.lean, st.leanTarget, 4, dt);
    const prevBob = st.bob;
    st.bob += moved * 1.75;
    if (Math.floor(prevBob / Math.PI) !== Math.floor(st.bob / Math.PI) && moved > 0) hooks.onStep?.(st.x, st.z, running);
    const bobAmt = Math.min(1, st.speed / WALK);
    const bobY = Math.abs(Math.sin(st.bob)) * 0.035 * bobAmt;
    const ground = heightAt(st.x, st.z);
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
    teleport(x, z, yaw, pitch = 0) {
      st.x = x;
      st.z = z;
      st.yaw = yaw;
      st.pitch = pitch;
      st.roll = 0;
      vel.set(0, 0);
    },
    /** 面向某个世界坐标所需的 yaw / pitch */
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
