import * as THREE from 'three'

const PAPER_CLEARANCE = 0.005 // 给裙面描边和纸面三角形之间的起伏留出余量（米）。
const BODY_CLEARANCE = 0.019 // 外裙离臀腿包围面的距离（米）。

/** 将裙面调整到跪坐曲面，并返回贴合纸面的方法。构建时 root 须保持单位变换。 */
export const drapeSeatedSkirt = (
  root: THREE.Group,
  meshes: THREE.SkinnedMesh[],
  surface: (phi: number, v: number, out: THREE.Vector3) => THREE.Vector3,
  restWaist: THREE.Vector3,
  bodyHeight: (x: number, z: number) => number,
) => {
  const p = new THREE.Vector3()
  const posed = new THREE.Vector3()
  const direction = new THREE.Vector3()
  const ray = new THREE.Raycaster()
  const down = new THREE.Vector3(0, -1, 0)
  const origin = new THREE.Vector3()
  const outer: THREE.Mesh[] = []
  const skirts: THREE.Mesh[] = []
  const layers: { skirt: THREE.Mesh; restHeights: Float32Array; isLining: boolean }[] = []
  root.updateMatrixWorld(true)

  for (const source of meshes.filter((m) => /kirt|Petticoat|flounce/i.test(m.name))) {
    // 隐藏 Overskirt 的贴身内壳子网格（_2 与 _3）：跪坐大幅弯折后会与外层穿插，外层已启用 DoubleSide。
    if (/Overskirt.*_[23]$/.test(source.name)) {
      source.visible = false
      continue
    }
    const isLining = /Petticoat|flounce/i.test(source.name)
    source.skeleton.update()
    const geometry = source.geometry.clone()
    const positions = geometry.getAttribute('position')
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i) - restWaist.x
      const y = positions.getY(i)
      const z = positions.getZ(i) - restWaist.z
      const phi = Math.atan2(x, z)
      // 绑定姿势下裙摆前缘约 0.72 m、两侧约 0.41 m，按方位角平滑过渡以使两侧裙边盖住膝外。
      const hemY = 0.414 + 0.308 * Math.max(0, 1 - (Math.abs(phi) / 1.66) ** 1.38)
      const v = Math.max(0, (restWaist.y - y) / (restWaist.y - hemY))
      surface(phi, Math.min(v, 1), p)
      direction.set(Math.sin(phi), 0, Math.cos(phi))
      if (v > 1) {
        p.addScaledVector(direction, (v - 1) * 0.18)
      }

      // 保留原裙面的法向厚度与细褶起伏，防止里外布层重叠闪烁。
      const restRadius = 0.082 + 0.6 * (restWaist.y - y)
      p.y += 0.7 * (Math.hypot(x, z) - restRadius)
      // 平滑压低靠近纸面的细褶，保留不同布层之间的高度差。
      const floorDistance = p.y - 0.007
      p.y = 0.007 + 0.5 * (floorDistance + Math.sqrt(floorDistance ** 2 + 0.000144))

      // 腰部保留蒙皮位置，向下逐渐过渡到摊开的裙面。
      source.getVertexPosition(i, posed)
      source.localToWorld(posed)
      root.worldToLocal(posed)
      p.lerp(posed, 1 - THREE.MathUtils.smoothstep(v, 0.02, 0.23))
      // 裙褶与外扩会改变水平坐标，按最终位置重新抬高以免膝盖穿透外裙。
      if (!isLining) {
        p.y = Math.max(p.y, bodyHeight(p.x, p.z) + BODY_CLEARANCE)
      }
      // 内衬与荷叶边约束在外裙下方，仅超出外裙边缘的部分显露出来。
      if (isLining) {
        ray.set(origin.set(p.x, 2, p.z), down)
        const hit = ray.intersectObjects(outer, false)[0]
        if (hit) {
          p.y = Math.min(p.y, hit.point.y - 0.008)
        }
      }
      positions.setXYZ(i, p.x, p.y, p.z)
    }
    geometry.deleteAttribute('skinIndex')
    geometry.deleteAttribute('skinWeight')
    geometry.computeVertexNormals()
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    const skirt = new THREE.Mesh(geometry, source.material)
    skirt.name = `${source.name}_seated`
    skirt.frustumCulled = false
    root.add(skirt)
    skirt.updateMatrixWorld(true)
    if (/Overskirt.*_1$/.test(source.name)) {
      outer.push(skirt)
    }
    source.visible = false
    skirts.push(skirt)
    // 保留原始跪坐高度，切换朝向时从同一曲面重新贴合。
    const restHeights = Float32Array.from({ length: positions.count }, (_, i) => positions.getY(i))
    layers.push({ skirt, restHeights, isLining })
  }

  return {
    skirts,
    /** 按 root 当前的位置和绕 Y 轴的朝向，将低处的裙摆贴到纸面的实际起伏上。 */
    fitToPaper(paperHeightAt: (x: number, z: number) => number | null): void {
      root.updateWorldMatrix(true, false)
      for (const { skirt, restHeights, isLining } of layers) {
        const { geometry } = skirt
        const positions = geometry.getAttribute('position')
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i)
          const z = positions.getZ(i)
          const restY = restHeights[i]!
          p.set(x, 0, z).applyMatrix4(root.matrixWorld)
          const paperY = paperHeightAt(p.x, p.z)
          let y = restY
          if (paperY !== null) {
            // 低处的布层共用同一个位移，向腰部逐渐减弱，保留贴地裙褶的层次。
            const floorY = paperY - p.y + PAPER_CLEARANCE
            const weight = 1 - THREE.MathUtils.smoothstep(restY, 0.025, 0.14)
            y = Math.max(floorY, restY + floorY * weight)
            if (!isLining) {
              y = Math.max(y, bodyHeight(x, z) + BODY_CLEARANCE)
            }
          }
          positions.setY(i, y)
        }
        positions.needsUpdate = true
        geometry.computeVertexNormals()
        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()
      }
    },
  }
}
