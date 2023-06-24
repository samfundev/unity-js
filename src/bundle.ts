import type { Readable } from 'stream';
import AsyncBinaryStream from 'async-binary-stream';
import BufferReader from 'buffer-reader';
import { uncompress as decompressLz4 } from 'lz4-napi';
import { Asset } from './asset';
import type { AssetObject } from './classes';

interface BundleHeader {
  signature: string;
  version: number;
  unityVersion: string;
  unityReversion: string;
  size: number;
  compressedBlocksInfoSize: number;
  uncompressedBlocksInfoSize: number;
  flags: number;
}

interface StorageBlock {
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
}

enum StorageBlockFlags {
  COMPRESSION_TYPE_MASK = 0x3f,
  STREAMED = 0x40,
}

interface StorageNode {
  offset: number;
  size: number;
  flags: number;
  path: string;
}

enum Signature {
  UNITY_WEB = 'UnityWeb',
  UNITY_RAW = 'UnityRaw',
  UNITY_FS = 'UnityFS',
  UNITY_ARCHIVE = 'UnityArchive',
  UNITY_WEB_DATA_1_0 = '"UnityWebData1.0"',
}

enum ArchiveFlags {
  COMPRESSION_TYPE_MASK = 0x3f,
  BLOCKS_AND_DIRECTORY_INFO_COMBINED = 0x40,
  BLOCKS_INFO_AT_THE_END = 0x80,
  OLD_WEB_PLUGIN_COMPATIBILITY = 0x100,
  BLOCK_INFO_NEED_PADDING_AT_START = 0x200,
}

enum CompressionType {
  NONE,
  LZMA,
  LZ4,
  LZ4_HC,
  LZHAM,
}

enum FileType {
  ASSETS_FILE,
  BUNDLE_FILE,
  WEB_FILE,
  RESOURCE_FILE,
  GZIP_FILE,
  BROTLI_FILE,
  ZIP_FILE,
}

export class AssetBundle {
  private readonly blockInfos: StorageBlock[] = [];
  private readonly nodes: StorageNode[] = [];
  private assetObjects: AssetObject[] = [];

  private constructor(private readonly header: BundleHeader) {}

  static async load(data: Readable) {
    const s = new AsyncBinaryStream(data);

    const signature = await s.readNullTerminatingString();
    const version = await s.readUInt32BE();
    const unityVersion = await s.readNullTerminatingString();
    const unityReversion = await s.readNullTerminatingString();

    const bundle = new AssetBundle({
      signature,
      version,
      unityVersion,
      unityReversion,
      size: 0,
      compressedBlocksInfoSize: 0,
      uncompressedBlocksInfoSize: 0,
      flags: 0,
    });

    await bundle.read(s);

    return bundle;
  }

  public objects() {
    return [...this.assetObjects];
  }

  private async read(s: AsyncBinaryStream) {
    const { signature } = this.header;

    const files = await (async () => {
      switch (signature) {
        case Signature.UNITY_FS:
          await this.readHeader(s);
          await this.readBlocksInfoAndDirectory(s);
          return this.readFiles(await this.readBlocks(s));

        default:
          throw new Error(`Unsupported bundle type: ${signature}`);
      }
    })();

    this.assetObjects = files
      .filter(f => getFileType(f) === FileType.ASSETS_FILE)
      .flatMap(f => new Asset(f).objects());
  }

  private async readHeader(s: AsyncBinaryStream) {
    const { header } = this;

    if (header.version >= 7) {
      throw new Error(`Unsupported bundle version: ${header.version}`);
    }

    header.size = Number(await s.readInt64BE());
    header.compressedBlocksInfoSize = await s.readUInt32BE();
    header.uncompressedBlocksInfoSize = await s.readUInt32BE();
    header.flags = await s.readUInt32BE();
  }

  private async readBlocksInfoAndDirectory(s: AsyncBinaryStream) {
    const { flags, compressedBlocksInfoSize, uncompressedBlocksInfoSize } = this.header;
    if (
      flags & ArchiveFlags.BLOCKS_INFO_AT_THE_END ||
      flags & ArchiveFlags.BLOCK_INFO_NEED_PADDING_AT_START
    ) {
      throw new Error(`Unsupported bundle flags: ${flags}`);
    }

    const blockInfoBuffer = await s.readBuffer(compressedBlocksInfoSize);
    const compressionType = flags & ArchiveFlags.COMPRESSION_TYPE_MASK;
    const blockInfoUncompressedBuffer = await decompressBuffer(
      blockInfoBuffer,
      compressionType,
      uncompressedBlocksInfoSize,
    );

    this.readBlocksInfo(blockInfoUncompressedBuffer);
  }

  private readBlocksInfo(blockInfo: Buffer) {
    const r = new BufferReader(blockInfo);
    // const uncompressedDataHash = r.nextBuffer(16);
    r.move(16);
    const blockInfoCount = r.nextInt32BE();

    for (let i = 0; i < blockInfoCount; i++) {
      this.blockInfos.push({
        uncompressedSize: r.nextUInt32BE(),
        compressedSize: r.nextUInt32BE(),
        flags: r.nextUInt16BE(),
      });
    }

    const nodeCount = r.nextInt32BE();

    for (let i = 0; i < nodeCount; i++) {
      this.nodes.push({
        offset: bufferReaderReadBigInt64BE(r),
        size: bufferReaderReadBigInt64BE(r),
        flags: r.nextUInt32BE(),
        path: r.nextStringZero(),
      });
    }
  }

  private async readBlocks(s: AsyncBinaryStream) {
    const results: Buffer[] = [];

    for (const { flags, compressedSize, uncompressedSize } of this.blockInfos) {
      const compressionType = flags & StorageBlockFlags.COMPRESSION_TYPE_MASK;
      const compressedBuffer = await s.readBuffer(compressedSize);
      const uncompressedBuffer = await decompressBuffer(
        compressedBuffer,
        compressionType,
        uncompressedSize,
      );
      results.push(uncompressedBuffer);
    }

    return Buffer.concat(results);
  }

  private readFiles(data: Buffer) {
    const r = new BufferReader(data);
    const files: Buffer[] = [];

    for (const { offset, size } of this.nodes) {
      r.seek(offset);
      files.push(r.nextBuffer(size));
    }

    return files;
  }
}

const decompressBuffer = async (data: Buffer, type: number, uncompressedSize?: number) => {
  switch (type) {
    case CompressionType.NONE:
      return data;

    case CompressionType.LZ4:
    case CompressionType.LZ4_HC: {
      if (!uncompressedSize) throw new Error('Uncompressed size not provided');
      const sizeBuffer = Buffer.alloc(4);
      sizeBuffer.writeUInt32LE(uncompressedSize);
      return await decompressLz4(Buffer.concat([sizeBuffer, data]));
    }

    default:
      throw new Error(`Unsupported compression type: ${type}`);
  }
};

const bufferReaderReadBigInt64BE = (r: BufferReader) => Number(r.nextBuffer(8).readBigInt64BE());

const getFileType = (data: Buffer) => {
  const r = new BufferReader(data);
  const signature = r.nextStringZero();

  switch (signature) {
    case Signature.UNITY_WEB:
    case Signature.UNITY_RAW:
    case Signature.UNITY_ARCHIVE:
    case Signature.UNITY_FS:
      return FileType.BUNDLE_FILE;

    case Signature.UNITY_WEB_DATA_1_0:
      return FileType.WEB_FILE;

    default: {
      const GZIP_HEAD = Buffer.from([0x1f, 0x8b]);
      const BROTLI_HEAD = Buffer.from([0x62, 0x72, 0x6f, 0x74, 0x6c, 0x69]);
      const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      const ZIP_SPANNED_HEAD = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

      const matchHead = (magic: Buffer, start = 0) => {
        r.seek(start);
        return r.nextBuffer(magic.length).equals(magic);
      };

      const isSerializedFile = () => {
        if (data.length < 20) return false;
        r.seek(0);
        r.move(4);
        let fileSize = r.nextUInt32BE();
        const version = r.nextUInt32BE();
        let dataOffset = r.nextUInt32BE();
        r.move(4);
        if (version >= 22) {
          if (data.length < 48) return false;
          r.move(4);
          fileSize = bufferReaderReadBigInt64BE(r);
          dataOffset = bufferReaderReadBigInt64BE(r);
        }
        if (data.length !== fileSize) return false;
        if (dataOffset > fileSize) return false;
        return true;
      };

      // 应该要先复位，猜的
      if (matchHead(GZIP_HEAD)) return FileType.GZIP_FILE;
      if (matchHead(BROTLI_HEAD, 32)) return FileType.BROTLI_FILE;
      if (isSerializedFile()) return FileType.ASSETS_FILE;
      if (matchHead(ZIP_HEAD) || matchHead(ZIP_SPANNED_HEAD)) return FileType.ZIP_FILE;
      return FileType.RESOURCE_FILE;
    }
  }
};
