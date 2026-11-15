import * as THREE from 'three';

/** 将地面三角形按水平位置分格，供行走和花朵共用同一份精确高度。 */
export function createSurfaceSampler(root, cellSize = 4) {
  const cells = new Map();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const { position } = mesh.geometry.attributes;
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      normal.crossVectors(ab, ac).normalize();
      if (normal.y <= 0.01) continue;
      const denominator = ab.x * ac.z - ac.x * ab.z;
      const triangle = {
        x: a.x, y: a.y, z: a.z,
        bx: ab.x, by: ab.y, bz: ab.z,
        cx: ac.x, cy: ac.y, cz: ac.z,
        denominator, normalY: normal.y,
        plateau: mesh.name === 'Game_Plateau',
      };
      const minX = Math.floor(Math.min(a.x, b.x, c.x) / cellSize);
      const maxX = Math.floor(Math.max(a.x, b.x, c.x) / cellSize);
      const minZ = Math.floor(Math.min(a.z, b.z, c.z) / cellSize);
      const maxZ = Math.floor(Math.max(a.z, b.z, c.z) / cellSize);
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          const key = `${x},${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(triangle);
        }
      }
    }
  });
  return (x, z, plateauOnly = false) => {
    const triangles = cells.get(`${Math.floor(x / cellSize)},${Math.floor(z / cellSize)}`) || [];
    let result = null;
    for (const t of triangles) {
      if (plateauOnly && !t.plateau) continue;
      const dx = x - t.x;
      const dz = z - t.z;
      const u = (dx * t.cz - t.cx * dz) / t.denominator;
      const v = (t.bx * dz - dx * t.bz) / t.denominator;
      if (u < -1e-6 || v < -1e-6 || u + v > 1.000001) continue;
      const height = t.y + u * t.by + v * t.cy;
      if (!result || height > result.height) result = { height, normalY: t.normalY, plateau: t.plateau };
    }
    return result;
  };
}
