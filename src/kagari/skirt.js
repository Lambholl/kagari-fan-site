import * as THREE from 'three';

/** 将裙面调整到跪坐曲面，隐藏原蒙皮裙摆并向 root 添加替代网格（root 须保持单位变换）。 */
export function drapeSeatedSkirt(root, meshes, surface, restWaist, bodyHeight) {
  const p = new THREE.Vector3();
  const posed = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const outer = [];
  const result = [];
  root.updateMatrixWorld(true);

  for (const source of meshes.filter((m) => /kirt|Petticoat|flounce/i.test(m.name))) {
    // 隐藏 Overskirt 的贴身内壳子网格（_2 与 _3）：跪坐大幅弯折后会与外层穿插，外层已启用 DoubleSide。
    if (/Overskirt.*_[23]$/.test(source.name)) {
      source.visible = false;
      continue;
    }
    const lining = /Petticoat|flounce/i.test(source.name);
    source.skeleton.update();
    const geometry = source.geometry.clone();
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i) - restWaist.x;
      const y = positions.getY(i);
      const z = positions.getZ(i) - restWaist.z;
      const phi = Math.atan2(x, z);
      // 绑定姿势下裙摆前缘约 0.72 m、两侧约 0.41 m，按方位角平滑过渡以使两侧裙边盖住膝外。
      const hemY = 0.414 + 0.308 * Math.max(0, 1 - (Math.abs(phi) / 1.66) ** 1.38);
      const v = Math.max(0, (restWaist.y - y) / (restWaist.y - hemY));
      surface(phi, Math.min(v, 1), p);
      direction.set(Math.sin(phi), 0, Math.cos(phi));
      if (v > 1) p.addScaledVector(direction, (v - 1) * 0.18);

      // 保留原裙面的法向厚度与细褶起伏，防止里外布层重叠闪烁。
      const restRadius = 0.082 + 0.6 * (restWaist.y - y);
      p.y += 0.7 * (Math.hypot(x, z) - restRadius);
      // 平滑压低靠近纸面的细褶，保留不同布层之间的高度差。
      const floorDistance = p.y - 0.007;
      p.y = 0.007 + 0.5 * (floorDistance + Math.sqrt(floorDistance ** 2 + 0.000144));

      // 腰部保留蒙皮位置，向下逐渐过渡到摊开的裙面。
      source.getVertexPosition(i, posed);
      source.localToWorld(posed);
      root.worldToLocal(posed);
      p.lerp(posed, 1 - THREE.MathUtils.smoothstep(v, 0.02, 0.23));
      // 裙褶与外扩会改变水平坐标，按最终位置重新抬高以免膝盖穿透外裙。
      if (!lining) p.y = Math.max(p.y, bodyHeight(p.x, p.z) + 0.019);
      // 内衬与荷叶边约束在外裙下方，仅超出外裙边缘的部分显露出来。
      if (lining) {
        ray.set(origin.set(p.x, 2, p.z), down);
        const hit = ray.intersectObjects(outer, false)[0];
        if (hit) p.y = Math.min(p.y, hit.point.y - 0.008);
      }
      positions.setXYZ(i, p.x, p.y, p.z);
    }
    geometry.deleteAttribute('skinIndex');
    geometry.deleteAttribute('skinWeight');
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const skirt = new THREE.Mesh(geometry, source.material);
    skirt.name = `${source.name}_seated`;
    skirt.frustumCulled = false;
    root.add(skirt);
    skirt.updateMatrixWorld(true);
    if (/Overskirt.*_1$/.test(source.name)) outer.push(skirt);
    source.visible = false;
    result.push(skirt);
  }
  return result;
}
