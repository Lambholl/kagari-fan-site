import * as THREE from 'three';

/** 将裙面调整到固定跪坐姿势，隐藏原蒙皮裙摆并返回替代网格。root 需保持单位变换。 */
export function drapeSeatedSkirt(root, meshes, surface, restWaist) {
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
    // 外裙使用双面材质即可。原来的贴身内壳在大幅弯折后会和外层互相穿插。
    if (/Overskirt.*_[23]$/.test(source.name)) {
      source.visible = false;
      continue;
    }
    source.skeleton.update();
    const geometry = source.geometry.clone();
    const positions = geometry.attributes.position;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i) - restWaist.x;
      const y = positions.getY(i);
      const z = positions.getZ(i) - restWaist.z;
      const phi = Math.atan2(x, z);
      // 原模型前短后长：前缘约 0.71 m，侧后缘约 0.41 m。
      const hemY = 0.414 + 0.3 * Math.max(0, Math.cos(phi)) ** 2;
      const v = Math.max(0, (restWaist.y - y) / (restWaist.y - hemY));
      surface(phi, Math.min(v, 1), p);
      direction.set(Math.sin(phi), 0, Math.cos(phi));
      if (v > 1) p.addScaledVector(direction, (v - 1) * 0.18);

      // 将原裙面的法向厚度和细褶带到新曲面，避免里外层重叠闪烁。
      const restRadius = 0.082 + 0.6 * (restWaist.y - y);
      p.y += 0.7 * (Math.hypot(x, z) - restRadius);
      // 平滑压低靠近纸面的细褶，保留不同布层之间的高度差。
      const floorDistance = p.y - 0.007;
      p.y = 0.007 + 0.5 * (floorDistance + Math.sqrt(floorDistance ** 2 + 0.000144));

      // 腰部仍接在原来的蒙皮位置，向下逐渐过渡到摊开的裙面。
      source.getVertexPosition(i, posed);
      source.localToWorld(posed);
      root.worldToLocal(posed);
      p.lerp(posed, 1 - THREE.MathUtils.smoothstep(v, 0.02, 0.23));
      // 里层藏在面料下面；只有越过外裙边缘的荷叶边露出来。
      if (/Petticoat|flounce/i.test(source.name)) {
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
