import type { Bundle } from './bundle';
import type { AssetObject } from './classes';
import { createAssetObject } from './classes';
import { ArrayBufferReader } from './utils/reader';

interface AssetHeader {
  metadataSize: number;
  fileSize: number;
  version: number;
  dataOffset: number;
  endianness: number;
}

interface TypeInfo {
  classId: number;
  tree: TypeTreeNode[];
}

interface TypeTreeNode {
  version: number;
  level: number;
  typeFlags: number;
  typeStrOffset: number;
  nameStrOffset: number;
  byteSize: number;
  index: number;
  metaFlag: number;
  refTypeHash: number | undefined;

  nameStr: string;
  typeStr: string;
}

export interface ObjectInfo {
  tree: TypeTreeNode[];
  getReader: () => ArrayBufferReader;
  bundle: Bundle;
  buildType: string;
  assetVersion: number;
  bytesStart: number;
  bytesSize: number;
  typeId: number;
  classId: number;
  isDestroyed: number;
  stripped: number;
  pathId: bigint;
  version: number[];
}

export class Asset {
  private readonly reader: ArrayBufferReader;
  private readonly header: AssetHeader;
  private readonly fileEndianness: number = 0;
  private readonly unityVersion: string = '';
  private readonly version: number[] = [];
  private readonly buildType: string = '';
  private readonly targetPlatform: number = 0;
  private readonly enableTypeTree: boolean = false;
  private readonly enableBigId: boolean = false;
  private readonly types: TypeInfo[] = [];
  private readonly objectInfos: ObjectInfo[] = [];
  private readonly cloneReader = () => this.reader.clone();

  constructor(bundle: Bundle, data: ArrayBuffer) {
    const r = new ArrayBufferReader(data);
    this.reader = r;

    const header: AssetHeader = (this.header = {
      metadataSize: r.readUInt32BE(),
      fileSize: r.readUInt32BE(),
      version: r.readUInt32BE(),
      dataOffset: r.readUInt32BE(),
      endianness: 0,
    });

    if (header.version >= 9) {
      this.fileEndianness = header.endianness = r.readUInt8();
      r.move(3);
    } else {
      r.seek(header.fileSize - header.metadataSize);
      this.fileEndianness = r.readUInt8();
    }
    if (header.version >= 22) {
      header.metadataSize = r.readUInt32();
      header.fileSize = Number(r.readUInt64());
      header.dataOffset = Number(r.readUInt64());
      r.move(8);
    }
    r.setLittleEndian(!this.fileEndianness);
    if (header.version >= 7) {
      this.unityVersion = r.readStringUntilZero();
      this.version = this.unityVersion
        .replace(/[a-z]+/gi, '.')
        .split('.')
        .slice(0, 4)
        .map(s => Number(s));
      this.buildType = this.unityVersion.match(/[a-z]/i)?.[0] ?? '';
    }
    if (header.version >= 8) {
      this.targetPlatform = r.readInt32();
    }
    if (header.version >= 13) {
      this.enableTypeTree = !!r.readUInt8();
    }

    const typeCount = r.readInt32();
    for (let i = 0; i < typeCount; i++) {
      this.readType(false);
    }

    if (header.version >= 7 && header.version < 14) {
      this.enableBigId = !!r.readInt32();
    }

    const objectCount = r.readUInt32();
    for (let i = 0; i < objectCount; i++) {
      const info: ObjectInfo = {
        getReader: this.cloneReader,
        bundle,
        buildType: this.buildType,
        assetVersion: header.version,
        bytesStart: 0,
        bytesSize: 0,
        typeId: 0,
        classId: 0,
        isDestroyed: 0,
        stripped: 0,
        pathId: 0n,
        version: this.version,
        tree: [],
      };

      if (this.enableBigId) info.pathId = r.readInt64();
      else if (header.version < 14) info.pathId = BigInt(r.readInt32());
      else {
        r.align(4);
        info.pathId = r.readInt64();
      }
      info.bytesStart = header.version >= 22 ? Number(r.readUInt64()) : r.readUInt32();
      info.bytesStart += header.dataOffset;
      info.bytesSize = r.readUInt32();
      info.typeId = r.readInt32();
      if (header.version < 16) info.classId = r.readUInt16();
      else info.classId = this.types[info.typeId].classId;
      if (header.version < 11) info.isDestroyed = r.readUInt16();
      if (header.version >= 11 && header.version < 17) r.move(2);
      if (header.version === 15 || header.version === 16) info.stripped = r.readUInt8();

      info.tree = this.types[info.typeId].tree;

      this.objectInfos.push(info);
    }

    // 未实现
  }

  public objects() {
    return this.objectInfos.map(createAssetObject).filter(o => o) as AssetObject[];
  }

  // 未完整实现，只用于跳过
  private readType(isRefType: boolean) {
    const r = this.reader;
    const { version } = this.header;

    const info: TypeInfo = {
      classId: r.readInt32(),
      tree: [],
    };

    if (version >= 16) r.move(1);
    const scriptTypeIndex = version >= 17 ? r.readInt16() : null;
    if (version >= 13) {
      if (
        (isRefType && scriptTypeIndex !== null) ||
        (version < 16 && info.classId < 0) ||
        (version >= 16 && info.classId === 114)
      ) {
        r.move(16);
      }
      r.move(16);
    }
    if (this.enableTypeTree) {
      if (version >= 12 || version === 10) info.tree = this.readTypeTreeBlob();
      else throw new Error(`Unsupported asset version: ${version}`);
      if (version >= 21) {
        if (isRefType) {
          r.readStringUntilZero();
          r.readStringUntilZero();
          r.readStringUntilZero();
        } else {
          const size = r.readInt32();
          r.move(size * 4);
        }
      }
    }

    this.types.push(info);
  }

  // 未实现，只用于跳过
  private readTypeTreeBlob(): TypeTreeNode[] {
    const nodes = [];
    const r = this.reader;

    const nodeNumber = r.readInt32();
    const stringBufferSize = r.readInt32();

    for (let i = 0; i < nodeNumber; i++) {
      nodes.push({
        version: r.readUInt16(),
        level: r.readUInt8(),
        typeFlags: r.readUInt8(),
        typeStrOffset: r.readUInt32(),
        nameStrOffset: r.readUInt32(),
        byteSize: r.readInt32(),
        index: r.readInt32(),
        metaFlag: r.readUInt32(),
        refTypeHash: this.header.version >= 19 ? r.readInt32() : undefined,
        nameStr: '',
        typeStr: '',
      });
    }

    const customTypes = new Map();
    const start = r.position;
    while (r.position < start + stringBufferSize) {
      const index = r.position - start;
      customTypes.set(index, r.readStringUntilZero());
    }

    const getType = (offset: number) => {
      if ((offset & 0x80000000) === 0) {
        return customTypes.get(offset);
      } else {
        return this.knownTypes.get(offset & 0x7fffffff);
      }
    };

    for (const node of nodes) {
      node.typeStr = getType(node.typeStrOffset);
      node.nameStr = getType(node.nameStrOffset);
    }

    return nodes;
  }

  private readonly knownTypes = new Map<number, string>([
    [0, 'AABB'],
    [5, 'AnimationClip'],
    [19, 'AnimationCurve'],
    [34, 'AnimationState'],
    [49, 'Array'],
    [55, 'Base'],
    [60, 'BitField'],
    [69, 'bitset'],
    [76, 'bool'],
    [81, 'char'],
    [86, 'ColorRGBA'],
    [96, 'Component'],
    [106, 'data'],
    [111, 'deque'],
    [117, 'double'],
    [124, 'dynamic_array'],
    [138, 'FastPropertyName'],
    [155, 'first'],
    [161, 'float'],
    [167, 'Font'],
    [172, 'GameObject'],
    [183, 'Generic Mono'],
    [196, 'GradientNEW'],
    [208, 'GUID'],
    [213, 'GUIStyle'],
    [222, 'int'],
    [226, 'list'],
    [231, 'long long'],
    [241, 'map'],
    [245, 'Matrix4x4f'],
    [256, 'MdFour'],
    [263, 'MonoBehaviour'],
    [277, 'MonoScript'],
    [288, 'm_ByteSize'],
    [299, 'm_Curve'],
    [307, 'm_EditorClassIdentifier'],
    [331, 'm_EditorHideFlags'],
    [349, 'm_Enabled'],
    [359, 'm_ExtensionPtr'],
    [374, 'm_GameObject'],
    [387, 'm_Index'],
    [395, 'm_IsArray'],
    [405, 'm_IsStatic'],
    [416, 'm_MetaFlag'],
    [427, 'm_Name'],
    [434, 'm_ObjectHideFlags'],
    [452, 'm_PrefabInternal'],
    [469, 'm_PrefabParentObject'],
    [490, 'm_Script'],
    [499, 'm_StaticEditorFlags'],
    [519, 'm_Type'],
    [526, 'm_Version'],
    [536, 'Object'],
    [543, 'pair'],
    [548, 'PPtr<Component>'],
    [564, 'PPtr<GameObject>'],
    [581, 'PPtr<Material>'],
    [596, 'PPtr<MonoBehaviour>'],
    [616, 'PPtr<MonoScript>'],
    [633, 'PPtr<Object>'],
    [646, 'PPtr<Prefab>'],
    [659, 'PPtr<Sprite>'],
    [672, 'PPtr<TextAsset>'],
    [688, 'PPtr<Texture>'],
    [702, 'PPtr<Texture2D>'],
    [718, 'PPtr<Transform>'],
    [734, 'Prefab'],
    [741, 'Quaternionf'],
    [753, 'Rectf'],
    [759, 'RectInt'],
    [767, 'RectOffset'],
    [778, 'second'],
    [785, 'set'],
    [789, 'short'],
    [795, 'size'],
    [800, 'SInt16'],
    [807, 'SInt32'],
    [814, 'SInt64'],
    [821, 'SInt8'],
    [827, 'staticvector'],
    [840, 'string'],
    [847, 'TextAsset'],
    [857, 'TextMesh'],
    [866, 'Texture'],
    [874, 'Texture2D'],
    [884, 'Transform'],
    [894, 'TypelessData'],
    [907, 'UInt16'],
    [914, 'UInt32'],
    [921, 'UInt64'],
    [928, 'UInt8'],
    [934, 'unsigned int'],
    [947, 'unsigned long long'],
    [966, 'unsigned short'],
    [981, 'vector'],
    [988, 'Vector2f'],
    [997, 'Vector3f'],
    [1006, 'Vector4f'],
    [1015, 'm_ScriptingClassIdentifier'],
    [1042, 'Gradient'],
    [1051, 'Type*'],
    [1057, 'int2_storage'],
    [1070, 'int3_storage'],
    [1083, 'BoundsInt'],
    [1093, 'm_CorrespondingSourceObject'],
    [1121, 'm_PrefabInstance'],
    [1138, 'm_PrefabAsset'],
    [1152, 'FileSize'],
    [1161, 'Hash128'],
    [1169, 'RenderingLayerMask'],
  ]);
}
