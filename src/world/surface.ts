import * as THREE from 'three'

interface SurfaceTriangle {
  x: number
  y: number
  z: number
  bx: number
  by: number
  bz: number
  cx: number
  cy: number
  cz: number
  denominator: number
  normalY: number
  isPlateau: boolean
}

/** 地面在一个采样点的高度（米）、法线竖直分量和主平台标记。 */
export interface GroundSurface {
  height: number
  normalY: number
  isPlateau: boolean
}

/**
 * 按水平方格索引朝上的地形三角面，返回查询 (x, z) 最高可见表面高度与法线的函数。
 * shouldMatchPlateau 为 true 时仅匹配主平台表面，网格外返回 null。
 */
export const createSurfaceSampler = (root: THREE.Object3D, cellSize = 4) => {
  const cells = new Map<string, SurfaceTriangle[]>()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const normal = new THREE.Vector3()
  root.updateMatrixWorld(true)
  root.traverse((mesh) => {
    if (!(mesh instanceof THREE.Mesh)) {
      return
    }
    const position = mesh.geometry.getAttribute('position')
    const index = mesh.geometry.index
    const count = index ? index.count : position.count
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld)
      b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(
        mesh.matrixWorld,
      )
      c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(
        mesh.matrixWorld,
      )
      ab.subVectors(b, a)
      ac.subVectors(c, a)
      normal.crossVectors(ab, ac).normalize()
      if (normal.y <= 0.01) {
        continue
      }
      const denominator = ab.x * ac.z - ac.x * ab.z
      const triangle = {
        x: a.x,
        y: a.y,
        z: a.z,
        bx: ab.x,
        by: ab.y,
        bz: ab.z,
        cx: ac.x,
        cy: ac.y,
        cz: ac.z,
        denominator,
        normalY: normal.y,
        isPlateau: mesh.name === 'Game_Plateau',
      }
      const minX = Math.floor(Math.min(a.x, b.x, c.x) / cellSize)
      const maxX = Math.floor(Math.max(a.x, b.x, c.x) / cellSize)
      const minZ = Math.floor(Math.min(a.z, b.z, c.z) / cellSize)
      const maxZ = Math.floor(Math.max(a.z, b.z, c.z) / cellSize)
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const key = `${x},${z}`
          if (!cells.has(key)) {
            cells.set(key, [])
          }
          cells.get(key)!.push(triangle)
        }
      }
    }
  })
  return (x: number, z: number, shouldMatchPlateau = false): GroundSurface | null => {
    const triangles = cells.get(`${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`) || []
    let result = null
    for (const t of triangles) {
      if (shouldMatchPlateau && !t.isPlateau) {
        continue
      }
      const dx = x - t.x
      const dz = z - t.z
      const u = (dx * t.cz - t.cx * dz) / t.denominator
      const v = (t.bx * dz - dx * t.bz) / t.denominator
      if (u < -1e-6 || v < -1e-6 || u + v > 1.000001) {
        continue
      }
      const height = t.y + u * t.by + v * t.cy
      if (!result || height > result.height) {
        result = { height, normalY: t.normalY, isPlateau: t.isPlateau }
      }
    }
    return result
  }
}
