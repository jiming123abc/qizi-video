/**
 * xlsxSafe：对结构有小毛病的 .xlsx（WPS/Numbers/第三方导出常见：空 theme 部件、
 * 空共享字符串条目、越界共享串索引、空 <v> 标签等）在交给 exceljs 读取前做一次清洗修复。
 *
 * 背景：exceljs 遇到这些文件会在读取/对账阶段直接抛底层错误，例如：
 *  - themes 部件为空：Cannot read properties of null (reading 'toString')（xlsx.js _processThemeEntry）
 *  - 共享串索引越界：Cannot read properties of undefined (reading 'richText')（cell-xform reconcile）
 * 导致整个文件无法解析，即使分镜数据本身是完好的。
 */
const zlib = require('zlib');
const unzipper = require('unzipper');

// 统计 sharedStrings.xml 中 <si> 条目的数量（顺序即索引）
function countSharedStringEntries(xml) {
  const m = xml.match(/<si\b[^>]*>/g);
  return m ? m.length : 0;
}

// 修复 sharedStrings.xml：空 <si/> / <si></si> 补成含空 <t> 的条目，避免 getString 返回 null
function sanitizeSharedStrings(xml) {
  return xml
    .replace(/<si\s*\/>/g, '<si><t></t></si>')
    .replace(/<si>\s*<\/si>/g, '<si><t></t></si>');
}

// 修复工作表 XML
function sanitizeWorksheet(xml, ssCount) {
  let out = xml;

  // 1) 剔除引用了越界（或缺失）共享字符串索引的单元格。
  //    单元格按 r= 坐标定位，直接删除坏格子不影响其他格子的数据；只匹配 t="s" 的 <c>
  out = out.replace(
    /<c\b(?=[^>]*\bt="s")[^>]*\/>|<c\b(?=[^>]*\bt="s")[^>]*>(?:(?!<\/c>)[\s\S])*?<\/c>/g,
    (cellXml) => {
      const v = cellXml.match(/<v[^>]*>\s*(-?\d+)\s*<\/v>/);
      if (!v) return ''; // 声明了 t="s" 但没有索引，坏格子直接丢弃
      const idx = parseInt(v[1], 10);
      return idx >= 0 && idx < ssCount ? cellXml : '';
    }
  );

  // 2) 去掉剩余的空 <v></v> / <v/>（数字单元格空值会让 exceljs 的 NumberValue.toString 崩在 null 上）
  out = out
    .replace(/<v\s*\/>/g, '')
    .replace(/<v>\s*<\/v>/g, '');

  return out;
}

/**
 * 解包 → 清洗 → 重新打包，返回新的 xlsx Buffer
 * @param {string} filePath 原始 xlsx 路径
 * @returns {Promise<Buffer>}
 */
async function readSanitizedXlsx(filePath) {
  const directory = await unzipper.Open.file(filePath);
  const parts = [];

  for (const file of directory.files) {
    if (file.type === 'Directory') continue;
    const name = file.path.replace(/\\/g, '/');
    let buf;
    try {
      buf = await file.buffer();
    } catch (e) {
      // 无法解压的部件直接跳过
      continue;
    }

    // 空的 theme 部件会触发 exceljs 的 null.toString 崩溃 → 丢弃（缺失主题仅影响默认样式）
    if (/^xl\/theme\/[^/]+\.xml$/i.test(name) && buf.length === 0) {
      continue;
    }

    // sharedStrings 先做空条目修复；工作表的越界索引修复需要知道条目总数，留到第二轮
    if (/^xl\/sharedstrings\.xml$/i.test(name)) {
      buf = Buffer.from(sanitizeSharedStrings(buf.toString('utf-8')), 'utf-8');
    }

    parts.push({ name, buf });
  }

  // 第二轮：需要先知道 sharedStrings 条目数才能校验工作表里的索引
  const ssPart = parts.find(p => /^xl\/sharedstrings\.xml$/i.test(p.name));
  const ssCount = ssPart ? countSharedStringEntries(ssPart.buf.toString('utf-8')) : 0;
  for (const p of parts) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(p.name)) {
      p.buf = Buffer.from(sanitizeWorksheet(p.buf.toString('utf-8'), ssCount), 'utf-8');
    }
  }

  return zipParts(parts);
}

// ---------- 极简 ZIP 打包（deflate + UTF-8 文件名），无需额外依赖 ----------
function crc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crc32Table();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipParts(parts) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { name, buf } of parts) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const comp = zlib.deflateRawSync(buf);
    const crc = crc32(buf);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(8, 8);     // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(buf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(buf.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, centralBuf, end]);
}

module.exports = { readSanitizedXlsx, sanitizeWorksheet, sanitizeSharedStrings, countSharedStringEntries };
