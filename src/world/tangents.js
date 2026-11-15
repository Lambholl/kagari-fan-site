/**
 * 修复几何体里长度为 0 或非有限的切线。
 * 着色器会对切线做 normalize，零向量得到 NaN；NaN 像素经泛光模糊会扩成大片黑块。
 * 只改坏掉的顶点：取与法线垂直的任意单位向量，其余顶点的切线保持原样。
 * @param {THREE.BufferGeometry} geometry 带 tangent 属性的几何体；没有该属性时不做任何事。
 * @returns {number} 被修复的顶点数。
 */
export function repairTangents(geometry) {
  const tangent = geometry.getAttribute('tangent');
  const normal = geometry.getAttribute('normal');
  if (!tangent || !normal) return 0;
  let repaired = 0;
  for (let i = 0; i < tangent.count; i++) {
    const x = tangent.getX(i);
    const y = tangent.getY(i);
    const z = tangent.getZ(i);
    const length = Math.hypot(x, y, z);
    if (Number.isFinite(length) && length > 1e-3) continue;
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    // 选与法线最不平行的坐标轴，叉乘得到垂直于法线的切线。
    const ax = Math.abs(nx) < 0.9 ? 1 : 0;
    const ay = ax ? 0 : 1;
    let tx = ay * nz;
    let ty = -ax * nz;
    let tz = ax * ny - ay * nx;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const w = tangent.getW(i);
    tangent.setXYZW(i, tx, ty, tz, w === 1 || w === -1 ? w : 1);
    repaired++;
  }
  if (repaired) tangent.needsUpdate = true;
  return repaired;
}
