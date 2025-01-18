import type { ArrayBufferReader } from '../utils/reader';
import { AssetBase } from './base';
import type { ObjectInfo } from './types';
import { AssetType } from './types';

export class MonoScript extends AssetBase {
  readonly type = AssetType.MonoScript;
  className: string;

  constructor(info: ObjectInfo, r: ArrayBufferReader) {
    super(info, r);

    r.readInt32(); // executionOrder;
    r.readUInt8Slice(16); // propertiesHash;
    this.className = r.readAlignedString();
  }
}
