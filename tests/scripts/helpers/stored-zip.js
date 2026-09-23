/**
 * Minimal STORED (uncompressed) zip builder for the lexicon pipeline tests —
 * just enough structure for yauzl to read entries, so the extraction guards can
 * be exercised with no network and no real archive. `usizeOverride` lets a
 * test lie about the declared inflated size in the central directory (what a
 * decompression bomb would do).
 */

const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
};

const makeStoredZip = (entries, { usizeOverride } = {}) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, content] of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const data = Buffer.from(content, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); // compressed size (stored)
        local.writeUInt32LE(data.length, 22); // uncompressed size
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt32LE(crc, 16);
        // A stored entry must declare equal compressed/uncompressed sizes, so
        // a bomb lies about both — mirror that or yauzl's own consistency
        // check fires before the guard under test.
        central.writeUInt32LE(usizeOverride ?? data.length, 20);
        central.writeUInt32LE(usizeOverride ?? data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42); // local header offset
        locals.push(local, nameBuf, data);
        centrals.push(Buffer.concat([central, nameBuf]));
        offset += local.length + nameBuf.length + data.length;
    }
    const centralDir = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralDir, eocd]);
};

module.exports = { makeStoredZip };
