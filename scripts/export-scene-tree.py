"""在 Blender 中对齐并简化主树，保留近看时的树干与分叉。"""
import json
import math
import random
from pathlib import Path

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.materials/moonlit-scene/blender/current/地形_月夜花海_缓坡版.blend'
OUTPUT = ROOT / '.materials/moonlit-scene/integration/source-tree'
OUTPUT.mkdir(parents=True, exist_ok=True)
SCENE_SCALE = 6  # 与 scene-layout.js 中的场景比例一致。


def prepare_tree(tree, keep_leaves, dissolve_degrees):
    mesh = tree.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    # 分开修树皮和抽叶片，避免同一个开口在两档模型中有不同结果。
    leaf_mesh = bmesh.new()
    leaf_mesh.from_mesh(mesh)
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if face.material_index == 0], context='FACES')
    bmesh.ops.delete(leaf_mesh, geom=[face for face in leaf_mesh.faces if face.material_index == 1], context='FACES')
    thin_leaves(leaf_mesh, keep_leaves)

    # 只焊合木质网格的重合点，UV 仍保存在每个面的转角上。
    inverse = tree.matrix_world.inverted()
    for vertex in bm.verts:
        vertex.co = (tree.matrix_world @ vertex.co) / SCENE_SCALE
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.00008)
    bm.normal_update()
    rings = bark_rims(bm)
    uv = bm.loops.layers.uv.active
    joined = 0
    # 源树的两根主枝在这些断口处与树身断开，保留各枝原位并连接两端。
    for socket_pos, branch_pos in [
        ((2.137, -0.149, 2.224), (2.869, -0.678, 2.489)),
        ((2.010, -0.194, 2.679), (2.926, -0.846, 2.474)),
    ]:
        socket, socket_center = closest_rim(rings, socket_pos)
        branch, branch_center = closest_rim(rings, branch_pos)
        faces = bmesh.ops.bridge_loops(bm, edges=socket + branch)['faces']
        for face in faces:
            apply_bark_patch(face, uv, socket_center, branch_center - socket_center)
        if not faces:
            raise RuntimeError(f'未能连接断枝：{branch_pos}')
        joined += 1

    center = Vector((2.0495, -0.1405))
    capped = 0
    for edges, point in bark_rims(bm):
        # 不封埋在地里的树根，只封主干侧面及明显枝头的开口。
        if point.z < 0.15 or sum(edge.calc_length() for edge in edges) < 0.19:
            continue
        for face in bmesh.ops.holes_fill(bm, edges=edges, sides=len(edges))['faces']:
            apply_bark_patch(face, uv, point)
            capped += 1

    # 仅合并树冠外围近似共面的相邻面。保留所有原枝条、UV 接缝和整体轮廓。
    bm.normal_update()
    outside = {
        v for f in bm.faces if f.material_index == 1 for v in f.verts
        if v.co.z > 4.2 or (v.co.xy - center).length > 1.4
    }
    edges = [e for e in bm.edges if e.is_manifold and all(v in outside for v in e.verts)]
    bm.verts.index_update()
    bmesh.ops.dissolve_limit(
        bm, angle_limit=math.radians(dissolve_degrees), edges=edges,
        verts=sorted(outside, key=lambda v: v.index),
        delimit={'NORMAL', 'MATERIAL', 'SEAM', 'SHARP', 'UV'},
    )
    bmesh.ops.triangulate(bm, faces=[face for face in bm.faces if len(face.verts) > 3])
    for vertex in bm.verts:
        vertex.co = inverse @ (vertex.co * SCENE_SCALE)
    # 把两份网格按原材质编号放回同一个模型，保留各自的 UV。
    leaf_data = bpy.data.meshes.new('Game_Hero_Leaves')
    leaf_mesh.to_mesh(leaf_data)
    leaf_mesh.free()
    bm.from_mesh(leaf_data)
    bpy.data.meshes.remove(leaf_data)
    bm.to_mesh(mesh)
    bm.free()
    mesh.validate(clean_customdata=False)
    return {'joined': joined, 'capped': capped}


def thin_leaves(bm, keep_leaves):
    # 叶片由独立的两三角面组成。整片抽稀，保留其轮廓和 UV。
    cards = []
    leaves = set(bm.faces)
    for face in bm.faces:
        if face not in leaves:
            continue
        leaves.remove(face)
        adjacent = {other for edge in face.edges for other in edge.link_faces if other in leaves}
        leaves.difference_update(adjacent)
        cards.append([face, *adjacent])
    random.Random(613).shuffle(cards)
    bmesh.ops.delete(bm, geom=[f for card in cards[int(len(cards) * keep_leaves):] for f in card], context='FACES')


def bark_rims(bm):
    bm.edges.index_update()
    remaining = {e for e in bm.edges if e.is_boundary and e.link_faces[0].material_index == 1}
    rims = []
    for first in sorted(remaining, key=lambda e: e.index):
        if first not in remaining:
            continue
        remaining.remove(first)
        pending = [first]
        edges = []
        while pending:
            edge = pending.pop()
            edges.append(edge)
            for vertex in edge.verts:
                neighbors = remaining.intersection(vertex.link_edges)
                remaining.difference_update(neighbors)
                pending.extend(sorted(neighbors, key=lambda e: e.index))
        vertices = {v for e in edges for v in e.verts}
        if len(edges) < 3 or len(edges) != len(vertices):
            continue
        edge_set = set(edges)
        if any(len(edge_set.intersection(v.link_edges)) != 2 for v in vertices):
            continue
        point = sum((v.co for v in vertices), Vector((0, 0, 0))) / len(vertices)
        rims.append((edges, point))
    return rims


def closest_rim(rims, position):
    target = Vector(position)
    rim = min(rims, key=lambda item: (item[1] - target).length)
    if (rim[1] - target).length > 0.02:
        raise RuntimeError(f'找不到源模型的断口：{position}')
    return rim


def apply_bark_patch(face, uv, origin, axis=None):
    # 只在新加的接合面投射木纹，邻接的源面保留原 UV。
    face.material_index = 1
    face.smooth = True
    face.normal_update()
    if axis:
        direction = axis.normalized()
        across = direction.orthogonal().normalized()
        around = direction.cross(across)
        angles = []
        for loop in face.loops:
            delta = loop.vert.co - origin
            angles.append(math.atan2(delta.dot(around), delta.dot(across)))
        for loop, angle in zip(face.loops, angles):
            angle = angles[0] + math.remainder(angle - angles[0], math.tau)
            loop[uv].uv = (0.34 + angle * 0.07, 0.58 + (loop.vert.co - origin).dot(direction) * 0.7)
    else:
        across = face.normal.orthogonal().normalized()
        up = face.normal.cross(across)
        for loop in face.loops:
            delta = loop.vert.co - origin
            loop[uv].uv = (0.34 + delta.dot(across) * 0.65, 0.58 + delta.dot(up) * 0.65)


stats = {}
for quality, texture_size, keep_leaves, dissolve_degrees in [
    ('mobile', 512, 0.48, 8),
    ('desktop', 1024, 0.68, 5),
]:
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    tree = bpy.data.objects['Oak Leaf_Leaf _02_0']
    # 这一物体包含主树的树皮和树叶；次要枝干物体不重复导入。
    ancestors = [tree]
    while ancestors[-1].parent:
        ancestors.append(ancestors[-1].parent)

    # 保留原父子变换，避免把非均匀缩放和旋转压成一次变换而改变树形。
    anchor = Matrix.Translation(Vector((0, 0, -88.24276733398438)))
    root = ancestors[-1]
    root.matrix_world = Matrix.Scale(0.2 * SCENE_SCALE, 4) @ anchor @ root.matrix_world
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    tree.hide_set(False)
    repair = prepare_tree(tree, keep_leaves, dissolve_degrees)
    tree.name = 'Game_Hero_Source'
    tree.data.calc_loop_triangles()
    stats[quality] = {
        material.name: sum(triangle.material_index == slot for triangle in tree.data.loop_triangles)
        for slot, material in enumerate(tree.data.materials)
    }
    stats[quality]['repair'] = repair

    for material in tree.data.materials:
        nodes = material.node_tree.nodes
        shader = next(node for node in nodes if node.type == 'BSDF_PRINCIPLED')
        if material.name == 'Moon_Hero_Leaf__02':
            # 明确导出为透明裁切。保留 Blender 原材质的透明阈值，不用半透明排序。
            links = material.node_tree.links
            cutoff_node = shader.inputs['Alpha'].links[0].from_node
            alpha_source = cutoff_node.inputs[0].links[0].from_socket
            cutoff_node.operation = 'GREATER_THAN'
            links.new(alpha_source, cutoff_node.inputs[0])
        for node in nodes:
            if node.type != 'TEX_IMAGE' or not node.image:
                continue
            image = node.image.copy()
            image.scale(texture_size, texture_size)
            image.pack()
            node.image = image

    bpy.ops.object.select_all(action='DESELECT')
    for obj in ancestors:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = tree
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT / f'tree-game-{quality}.glb'),
        export_format='GLB', use_selection=True, use_active_scene=True,
        export_yup=True, export_apply=False, export_tangents=True,
        export_cameras=False, export_lights=False, export_animations=False,
    )

(OUTPUT / 'game-triangles.json').write_text(json.dumps(stats, indent=2), encoding='utf-8')
print('GAME_TREE_TRIANGLES', json.dumps(stats))
