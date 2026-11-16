"""从场景导出包与全景 PNG 打包生成网页用的 WebP 模型与贴图（默认分别输出到 `public/models/` 和 `public/textures/`，需带 WebP 支持的 Pillow）。"""
import argparse
import io
import json
import struct
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SCENE = ROOT / '.materials/moonlit-scene'
EXPORTS = SCENE / 'exports/moonlit-game-models'
GROUND_PNG = EXPORTS / 'ground-png'
SKY_PNG = SCENE / 'source-assets/textures/night-panorama-no-aurora-8k.png'
WEBP_EXTENSION = 'EXT_texture_webp'
QUALITY = 90


def encode(image, lossless=False):
    """将图像编码为 WebP 字节。"""
    mode = 'RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB'
    data = io.BytesIO()
    image.convert(mode).save(data, 'WEBP', quality=QUALITY, method=6,
                             lossless=lossless, alpha_quality=100, exact=True)
    return data.getvalue()


def read_glb(path):
    """读取 GLB 的 JSON 数据字典与二进制缓冲区。"""
    data = path.read_bytes()
    json_size = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + json_size]), data[28 + json_size:]


def write_glb(path, model, binary):
    """将 JSON 字典与二进制缓冲区封装写入 GLB 文件。"""
    text = json.dumps(model, ensure_ascii=False, separators=(',', ':')).encode()
    text += b' ' * (-len(text) % 4)
    path.write_bytes(
        struct.pack('<4sII', b'glTF', 2, 28 + len(text) + len(binary))
        + struct.pack('<I4s', len(text), b'JSON') + text
        + struct.pack('<I4s', len(binary), b'BIN\0') + binary
    )


def convert_model(source, destination, albedo_dir=None):
    """将 GLB 内嵌图像转为 WebP 并重算缓冲区偏移；数据贴图用无损压缩，底色可从指定 PNG 目录读取。"""
    model, binary = read_glb(source)
    textures = model['textures']
    data_textures = set()
    for material in model['materials']:
        # 法线、环境光遮蔽与金属粗糙度贴图存储非颜色数值，使用无损 WebP 避免压缩失真影响着色。
        for texture in (material.get('normalTexture'), material.get('occlusionTexture'),
                        material.get('pbrMetallicRoughness', {}).get('metallicRoughnessTexture')):
            if texture:
                data_textures.add(textures[texture['index']]['source'])

    views = model['bufferViews']
    images = {}
    for index, image in enumerate(model['images']):
        view = views[image['bufferView']]
        start = view.get('byteOffset', 0)
        image_data = io.BytesIO(binary[start:start + view['byteLength']])
        if albedo_dir and image['name'].endswith('-albedo'):
            image_data = albedo_dir / f"{image['name']}.png"
        with Image.open(image_data) as original:
            images[image['bufferView']] = encode(original, lossless=index in data_textures)
        image['mimeType'] = 'image/webp'

    for texture in textures:
        texture.setdefault('extensions', {})[WEBP_EXTENSION] = {'source': texture.pop('source')}
    for name in ('extensionsUsed', 'extensionsRequired'):
        model.setdefault(name, []).append(WEBP_EXTENSION)

    # 原样复制顶点、索引等数据，只替换图片并重算各段位置。
    packed = bytearray()
    for index, view in enumerate(views):
        start = view.get('byteOffset', 0)
        data = images.get(index)
        if data is None:
            data = binary[start:start + view['byteLength']]
        view['byteOffset'] = len(packed)
        view['byteLength'] = len(data)
        packed.extend(data)
        packed.extend(b'\0' * (-len(packed) % 4))
    model['buffers'][0]['byteLength'] = len(packed)
    write_glb(destination, model, packed)


def pack(models_output, textures_output):
    """打包场景 GLB 到模型目录，并打包电脑与手机两档无极光天空贴图到贴图目录。"""
    models_output.mkdir(parents=True, exist_ok=True)
    textures_output.mkdir(parents=True, exist_ok=True)
    with Image.open(SKY_PNG) as sky:
        for quality, size in [('mobile', (2048, 683)), ('desktop', (4096, 1365))]:
            (textures_output / f'sky-no-aurora-{quality}.webp').write_bytes(
                encode(sky.resize(size, Image.Resampling.LANCZOS))
            )
            convert_model(
                SCENE / f'integration/source-tree/tree-game-{quality}.glb',
                models_output / f'tree-game-{quality}.glb',
            )
    convert_model(EXPORTS / 'models/ground-desktop.glb', models_output / 'ground-desktop.glb', GROUND_PNG / 'desktop')
    convert_model(EXPORTS / 'models/forest-desktop.glb', models_output / 'forest-desktop.glb')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'public/models')
    parser.add_argument('--textures-output', type=Path, default=ROOT / 'public/textures')
    args = parser.parse_args()
    pack(args.output, args.textures_output)
