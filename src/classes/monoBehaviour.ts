import type { ArrayBufferReader } from '../utils/reader';
import { AssetBase } from './base';
import { PPtr } from './pptr';
import type { ObjectInfo } from './types';
import { AssetType } from './types';

export class MonoBehaviour extends AssetBase {
  readonly type = AssetType.MonoBehaviour;
  gameobject: PPtr;
  enabled: boolean;
  script: PPtr;

  constructor(info: ObjectInfo, r: ArrayBufferReader) {
    super(info, r);
    r.seek(info.bytesStart);

    this.gameobject = new PPtr(info, r); // m_GameObject
    this.enabled = r.readBoolean(); // m_Enabled
    r.align(4);
    this.script = new PPtr(info, r);
    // @ts-expect-error MonoBehaviours have a name field, but it's not in the same spot as other assets.
    this.name = r.readAlignedString();
  }
}
