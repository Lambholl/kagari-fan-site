"""从当前打开的 Blender 角色源文件导出网页模型。

在 Blender 4.5 后台模式中运行，只写出目标 GLB 而不修改源 `.blend` 文件。
未通过 `-- <输出路径>` 指定位置时，默认写入 `public/models/kagari-base.glb`。
"""
import sys
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]
FACE_KEYS = {
    'Fcl_BRW_Joy', 'Fcl_BRW_Surprised', 'Fcl_EYE_Close', 'Fcl_EYE_Joy',
    'Fcl_EYE_Surprised', 'Fcl_MTH_Close', 'Fcl_MTH_Up', 'Fcl_MTH_Small',
    'Fcl_MTH_Neutral', 'Fcl_MTH_A',
}
FACE_DETAIL = ('FaceBrow', 'FaceEyelash', 'FaceEyeline', 'EyeHighlight')
TEXTURED = ('N00_', 'Dress |', 'Binding |', 'Petticoat |', 'Skirt |')
GAME_RIBBONS = ('Wrist bow.', 'Short bow tail.', 'Long flying tail.')


def prepare_material(material):
    """清空材质节点并重建最小 Principled BSDF，仅接出底色与透明度供前端着色。"""
    # glTF 导出器会忽略 Blender 自定义卡通节点树，只接出底色和透明度即可。
    tree = material.node_tree
    image = next((n.image for n in tree.nodes if n.type == 'TEX_IMAGE' and n.image), None)
    tree.nodes.clear()
    output = tree.nodes.new('ShaderNodeOutputMaterial')
    shader = tree.nodes.new('ShaderNodeBsdfPrincipled')
    shader.inputs['Base Color'].default_value = material.diffuse_color
    shader.inputs['Metallic'].default_value = 0
    tree.links.new(shader.outputs['BSDF'], output.inputs['Surface'])
    if image and material.name.startswith(TEXTURED):
        texture = tree.nodes.new('ShaderNodeTexImage')
        texture.image = image
        tree.links.new(texture.outputs['Color'], shader.inputs['Base Color'])
        if any(name in material.name for name in FACE_DETAIL):
            material.surface_render_method = 'BLENDED'
            tree.links.new(texture.outputs['Alpha'], shader.inputs['Alpha'])
        elif material.name.endswith(('HAIR', 'EyeIris_00_EYE')):
            material.surface_render_method = 'DITHERED'
            tree.links.new(texture.outputs['Alpha'], shader.inputs['Alpha'])


def fit_top(obj):
    """微调上衣肩缝内衬与颈带中段的形态键顶点位置，避免低头或抬臂时穿插。"""
    mesh = obj.data
    lining = {v for p in mesh.polygons if p.material_index == 1 for v in p.vertices}
    outer = {v for p in mesh.polygons if p.material_index == 0 for v in p.vertices}

    def smooth(a, b, x):
        t = max(0, min(1, (x - a) / (b - a)))
        return t * t * (3 - 2 * t)

    inner = lining - outer
    for vertex in mesh.vertices:
        x, y, z = vertex.co
        x = abs(x)
        # 仅向内收进肩缝正面翻出的内衬区域，保持袖口位置不变。
        shoulder = 0
        if vertex.index in inner:
            shoulder = smooth(.085, .107, x) * (1 - smooth(.138, .16, x))
            shoulder *= smooth(1.144, 1.166, z) * (1 - smooth(1.204, 1.224, z))
            shoulder *= 1 - smooth(-.018, .008, y)
        # 为颈带中段在俯仰时预留余量，下方交叉领带保持原形。
        collar = (1 - smooth(.011, .031, x)) * (1 - smooth(-.001, .014, y))
        collar *= smooth(1.186, 1.197, z) * (1 - smooth(1.222, 1.236, z))
        if not (shoulder or collar):
            continue
        for key in mesh.shape_keys.key_blocks:
            key.data[vertex.index].co.y += .012 * shoulder - .006 * collar
            key.data[vertex.index].co.z -= .004 * shoulder


def export(destination):
    """在绑定姿势下筛选网格、形态键与材质，并导出为 WebP 内嵌的 GLB。"""
    rig = bpy.data.objects['Armature']
    bpy.context.view_layer.objects.active = rig
    if rig.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    rig.data.pose_position = 'REST'
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)

    materials = set()
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or obj.parent != rig or not obj.visible_get() or obj.hide_render:
            continue
        if obj.name.startswith(GAME_RIBBONS):
            continue
        if obj.name == 'Cuff binding.R.001':
            fit_top(obj)
        keys = obj.data.shape_keys
        if keys:
            keys.animation_data_clear()
            for key in list(keys.key_blocks)[1:]:
                # 仅保留面部表情与袖根修正形态键，供前端驱动。
                if key.name not in FACE_KEYS and not key.name.startswith('Shoulder clearance'):
                    obj.shape_key_remove(key)
                else:
                    key.value = 0
        obj.select_set(True)
        materials.update(slot.material for slot in obj.material_slots if slot.material)

    for material in sorted(materials, key=lambda m: m.name):
        prepare_material(material)
    # 重命名前臂贴身缠带材质，供前端脚本识别并统一着色。
    bpy.data.materials['Ribbon | flat crimson cloth'].name = 'Ribbon | crimson wraps'

    bpy.ops.export_scene.gltf(
        filepath=str(destination), export_format='GLB', use_selection=True,
        export_apply=False, export_animations=False, export_armature_object_remove=False,
        export_rest_position_armature=True, export_morph=True, export_morph_normal=True,
        export_image_format='WEBP', export_image_quality=90,
    )


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    export(Path(args[0]).resolve() if args else ROOT / 'public/models/kagari-base.glb')
