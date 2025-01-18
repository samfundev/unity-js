import type { ArrayBufferReader } from '../utils/reader';
import type { ObjectInfo } from './types';
import { AssetType } from './types';

const dumpObject = (obj: any): any => {
  if (typeof obj === 'object') {
    if (Array.isArray(obj)) return obj.map(item => dumpObject(item));
    if (obj instanceof Map) {
      return Object.fromEntries(Array.from(obj.entries()).map(([k, v]) => [k, dumpObject(v)]));
    }
    if (obj instanceof Set) {
      return Array.from(obj.values()).map(item => dumpObject(item));
    }

    const result: any = {};

    const className: string | undefined = obj.__class;
    if (className) result.__class = className;

    for (const key in obj) {
      const cur = obj[key];
      if (
        key.startsWith('__') ||
        typeof cur === 'function' ||
        cur instanceof ArrayBuffer ||
        cur instanceof Uint8Array ||
        (typeof cur === 'object' && cur.__doNotDump)
      ) {
        continue;
      }
      result[key] = typeof cur?.dump === 'function' ? cur.dump() : dumpObject(cur);
    }

    return result;
  }

  return obj;
};

export abstract class AssetBase {
  abstract readonly type: AssetType;
  readonly reader: ArrayBufferReader;
  readonly name: string;

  constructor(
    protected readonly __info: ObjectInfo,
    r: ArrayBufferReader,
  ) {
    r.seek(__info.bytesStart);
    this.reader = r;
    this.name = r.readAlignedString();
  }

  get pathId() {
    return this.__info.pathId;
  }

  get size() {
    return this.__info.bytesSize;
  }

  get container() {
    return this.__info.bundle.containerMap?.get(this.pathId) ?? '';
  }

  protected get __class() {
    return AssetType[this.type] || 'unknown';
  }

  dump(): Record<string, any> {
    try {
      return dumpObject(this);
    } catch (error) {
      console.error(`Dump ${this.__class} error:`, error);
      return {};
    }
  }

  typeTree() {
    const methods: Record<string, string> = {
      int: 'Int32',
      string: 'AlignedString',
      float: 'Float32',
    };

    function remap(method: string) {
      method = method.replace('SInt', 'Int');
      return methods[method] ?? method;
    }

    const reader = this.reader.clone();
    reader.seek(this.__info.bytesStart);
    const nodes = this.__info.tree;
    let index = 0;
    function readObject(): Record<string, unknown> {
      const initialLevel = nodes[index].level;
      const object: Record<string, unknown> = {};
      while (index < nodes.length) {
        const node = nodes[index];
        if (node.level <= initialLevel - 1) break;

        index++;
        const nextNode = nodes[index];
        if (nextNode && nextNode.level > node.level && node.typeStr !== 'string') {
          if (nextNode.typeStr === 'Array') {
            const array = [];
            const length = reader.readUInt32();
            if (length !== 0) {
              index += 2; // skip Array and size
              const startIndex = index;
              for (let j = 0; j < length; j++) {
                index = startIndex;
                array.push(readObject().data);
              }
            } else {
              // Skip everything until the next field
              while (index < nodes.length && nodes[index].level > node.level) {
                index++;
              }
            }

            object[node.nameStr] = array;
          } else {
            object[node.nameStr] = readObject();
          }
        } else {
          // @ts-expect-error
          object[node.nameStr] = reader[`read${remap(node.typeStr)}`]();
          reader.align(4);

          if (node.typeStr === 'string') {
            index += 3; // skip string (Array, size, data)
          }
        }
      }

      return object;
    }

    return readObject().Base as Record<string, unknown>;
  }
}
