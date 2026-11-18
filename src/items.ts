import * as THREE from 'three'
import { damp } from './util/noise.ts'
import { getContext2D } from './util/dom.ts'

// 主角手里的东西：保温瓶，和一只纯白的内杯。

const makeSteamTexture = () => {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = getContext2D(c)
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30)
  g.addColorStop(0, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

const makeCup = (steamTex: THREE.Texture) => {
  const cup = new THREE.Group()
  const profile = [
    [0.0, 0.0],
    [0.026, 0.0],
    [0.03, 0.004],
    [0.036, 0.05],
    [0.0375, 0.058],
    [0.0345, 0.058],
    [0.033, 0.05],
    [0.027, 0.008],
    [0.0, 0.006],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  const body = new THREE.Mesh(
    new THREE.LatheGeometry(profile, 28),
    new THREE.MeshLambertMaterial({ color: 0xf4f6ff, emissive: 0x30343f, side: THREE.DoubleSide }),
  )
  cup.add(body)
  const coffee = new THREE.Mesh(
    new THREE.CircleGeometry(0.0325, 24).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x1c0d06, emissive: 0x060302 }),
  )
  coffee.position.y = 0.046
  cup.add(coffee)
  const steam = []
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: steamTex,
        transparent: true,
        depthWrite: false,
        opacity: 0,
        color: 0xcfe4ff,
      }),
    )
    cup.add(s)
    steam.push({ sprite: s, phase: i / 5 })
  }
  return Object.assign(cup, { userData: { coffee, steam, isFull: true } })
}

const updateCup = (cup: ReturnType<typeof makeCup>, time: number) => {
  const { coffee, steam, isFull } = cup.userData
  coffee.visible = isFull
  for (const { sprite: s, phase } of steam) {
    const k = (time * 0.35 + phase) % 1
    s.position.set(
      Math.sin(k * 7 + phase * 20) * 0.012,
      0.06 + k * 0.13,
      Math.cos(k * 5 + phase * 9) * 0.01,
    )
    const sc = 0.03 + k * 0.06
    s.scale.set(sc, sc, sc)
    s.material.opacity = isFull ? Math.sin(k * Math.PI) * 0.5 : 0
  }
}

const POSES = {
  hidden: { p: [0.2, -0.62, -0.45], r: [0, 0, 0] },
  hold: { p: [0.17, -0.25, -0.5], r: [0.12, 0, -0.05] },
  offer: { p: [0.03, -0.17, -0.74], r: [0.02, 0, 0] },
  drink: { p: [0.02, -0.1, -0.3], r: [0.95, 0, 0] },
}

/** 创建主角手里的保温瓶和纯白内杯，以及递交给她时使用的独立杯体。 */
export const createItems = (camera: THREE.PerspectiveCamera, scene: THREE.Scene) => {
  const steamTex = makeSteamTexture()
  const view = new THREE.Group()
  view.name = 'viewmodel'
  camera.add(view)

  // 保温瓶
  const thermos = new THREE.Group()
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2a4a5c, emissive: 0x0a1a24 })
  const capMat = new THREE.MeshLambertMaterial({ color: 0xc8d2e0, emissive: 0x2a2e36 })
  thermos.add(
    new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.04, 0.2, 20).translate(0, 0.1, 0), bodyMat),
  )
  thermos.add(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.038, 0.03, 20).translate(0, 0.215, 0),
      bodyMat,
    ),
  )
  thermos.add(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.031, 0.031, 0.045, 20).translate(0, 0.25, 0),
      capMat,
    ),
  )
  thermos.position.set(0.36, -0.62, -0.6)
  thermos.rotation.set(0.1, 0, 0.12)
  view.add(thermos)

  const cup = makeCup(steamTex)
  view.add(cup)
  cup.position.fromArray(POSES.hidden.p)

  // 递给篝时在世界坐标系中独立移动的杯子实例
  const worldCup = makeCup(steamTex)
  worldCup.visible = false
  scene.add(worldCup)

  let poseName: keyof typeof POSES = 'hidden'
  const st = { hasThermos: false, thermosY: -0.62, jolt: 0 }
  const tp = new THREE.Vector3()
  const tr = new THREE.Vector3()

  return {
    view,
    cup,
    worldCup,
    /** 显示或收起手持的保温瓶。 */
    setThermos(isVisible: boolean) {
      st.hasThermos = isVisible
    },
    /** 切换手持杯子的目标姿势。 */
    setPose(name: keyof typeof POSES) {
      poseName = name
    },
    /** 更新两个杯体的咖啡和热气显示。 */
    setFull(isFull: boolean) {
      cup.userData.isFull = isFull
      worldCup.userData.isFull = isFull
    },
    /** 触发保温瓶被缎带弹开时的偏转抖动。 */
    jolt() {
      st.jolt = 1
    },
    /** 把手持杯子的世界坐标写入 out。 */
    cupWorldPosition(out: THREE.Vector3) {
      return cup.getWorldPosition(out)
    },
    /** 推进杯子、保温瓶和热气的逐帧动画。 */
    update(dt: number, time: number) {
      const pose = POSES[poseName]
      tp.fromArray(pose.p)
      tr.fromArray(pose.r)
      cup.position.x = damp(cup.position.x, tp.x, 6, dt)
      cup.position.y = damp(cup.position.y, tp.y + Math.sin(time * 1.3) * 0.004, 6, dt)
      cup.position.z = damp(cup.position.z, tp.z, 6, dt)
      cup.rotation.x = damp(cup.rotation.x, tr.x, 6, dt)
      cup.rotation.z = damp(cup.rotation.z, tr.z, 6, dt)
      cup.visible = cup.position.y > -0.58
      st.jolt = damp(st.jolt, 0, 5, dt)
      st.thermosY = damp(st.thermosY, st.hasThermos ? -0.36 : -0.7, 5, dt)
      thermos.position.y = st.thermosY + Math.sin(time * 1.1 + 1) * 0.004
      thermos.position.x = 0.36 + st.jolt * 0.16
      thermos.rotation.z = 0.12 - st.jolt * 0.9
      thermos.visible = st.thermosY > -0.66
      updateCup(cup, time)
      if (worldCup.visible) {
        updateCup(worldCup, time)
      }
    },
  }
}
