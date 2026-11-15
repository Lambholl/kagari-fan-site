import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Node 测试只读取网格，图片解码留给浏览器验收。 */
export async function loadGeometry(path) {
  const data = readFileSync(path);
  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.subarray(20, 20 + jsonLength));
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) delete primitive.material;
  }
  delete json.images;
  delete json.textures;
  delete json.materials;
  const encoded = Buffer.from(JSON.stringify(json));
  const paddedLength = Math.ceil(encoded.length / 4) * 4;
  const binary = data.subarray(20 + jsonLength);
  const output = Buffer.alloc(20 + paddedLength + binary.length, 32);
  data.copy(output, 0, 0, 12);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  encoded.copy(output, 20);
  binary.copy(output, 20 + paddedLength);
  return (await new GLTFLoader().parseAsync(output.buffer, '')).scene;
}
