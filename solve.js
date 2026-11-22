// Fast dependency-free drop-in implementation of csv-reader 1.0.0.
// Iteration 5: Split-kernel Int32 SWAR escaped-byte transducer with inline clean-quoted
// fast path and L2-cache-hot reusable per-case output buffer.

import { writevSync } from 'node:fs';

const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

const ERR_STRAY_CR = 1;
const ERR_UNTERMINATED_QUOTE = 2;
const ERR_QUOTE_JUNK = 3;
const ERR_SHORT_ROW = 4;
const ERR_LONG_ROW = 5;

const STOP_ABORT = 0;
const STOP_OVERFLOW = 1;
const STOP_QUOTED = 2;
const STOP_STRAY_CR = 3;
const STOP_EOL = 4;
const STOP_EOF = 5;

export function run(input) {
  const text = String(input.text);
  const len = text.length;
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = len > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  let fieldValue = '';
  let fieldEnded = END;
  let fieldAdded = 0;

  function readUnquoted(prefix) {
    let segStart = pos;
    let acc = prefix;
    let added = 0;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        if (pos > segStart) {
          const chunk = text.slice(segStart, pos);
          acc = acc.length === 0 ? chunk : acc + chunk;
          added += pos - segStart;
        }
        pos += 1;
        fieldValue = acc;
        fieldEnded = COMMA;
        fieldAdded = added;
        return;
      }
      if (c === 10) {
        if (pos > segStart) {
          const chunk = text.slice(segStart, pos);
          acc = acc.length === 0 ? chunk : acc + chunk;
          added += pos - segStart;
        }
        pos += 1;
        line += 1;
        fieldValue = acc;
        fieldEnded = LINE_BREAK;
        fieldAdded = added;
        return;
      }
      if (c === 13) {
        if (pos > segStart) {
          const chunk = text.slice(segStart, pos);
          acc = acc.length === 0 ? chunk : acc + chunk;
          added += pos - segStart;
        }
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fieldValue = acc;
          fieldEnded = LINE_BREAK;
          fieldAdded = added;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        segStart = pos;
        continue;
      }
      pos += 1;
    }
    if (pos > segStart) {
      const chunk = text.slice(segStart, pos);
      acc = acc.length === 0 ? chunk : acc + chunk;
      added += pos - segStart;
    }
    fieldValue = acc;
    fieldEnded = END;
    fieldAdded = added;
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let segStart = pos;
    let acc = '';
    let closed = false;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 34) {
        if (pos + 1 < len && text.charCodeAt(pos + 1) === 34) {
          acc += text.slice(segStart, pos + 1);
          pos += 2;
          segStart = pos;
          continue;
        }
        if (pos > segStart) {
          const chunk = text.slice(segStart, pos);
          acc = acc.length === 0 ? chunk : acc + chunk;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) {
        if (pos > segStart) {
          const chunk = text.slice(segStart, pos);
          acc = acc.length === 0 ? chunk : acc + chunk;
        }
        acc += '\n';
        line += 1;
        pos += pos + 1 < len && text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        segStart = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    if (pos >= len) {
      fieldValue = acc;
      fieldEnded = END;
      return;
    }
    const next = text.charCodeAt(pos);
    if (next === 44) {
      pos += 1;
      fieldValue = acc;
      fieldEnded = COMMA;
      return;
    }
    if (next === 10) {
      pos += 1;
      line += 1;
      fieldValue = acc;
      fieldEnded = LINE_BREAK;
      return;
    }
    if (next === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fieldValue = acc;
      fieldEnded = LINE_BREAK;
      return;
    }
    readUnquoted(acc);
    if (fieldAdded > 0) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
  }

  while (pos < len) {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = pos < len && text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fieldValue);
    } while (fieldEnded === COMMA);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    const flen = fields.length;
    if (flen < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: flen });
      for (let i = flen; i < width; i++) fields.push('');
    } else if (flen > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// ---------- Hot SWAR Kernel (unquoted + inline simple quoted + multi-row chaining) ----------

/**
 * State tuple `st`: [pos, outPos, line, recordCount, fieldCount, cutOutPos, recordLine, fastRowStarted]
 */
function runFastBurst(inBuf, inDv, inSafe4, outBuf, outDv, outHardLimit, width, st) {
  let pos = st[0];
  let outPos = st[1];
  let line = st[2];
  let recordCount = st[3];
  let fieldCount = st[4];
  let cutOutPos = st[5];
  let recordLine = st[6];
  let fastRowStarted = st[7];

  while (true) {
    if (outPos > outHardLimit) {
      st[0] = pos; st[1] = outPos; st[2] = line; st[3] = recordCount;
      st[4] = fieldCount; st[5] = cutOutPos; st[6] = recordLine; st[7] = fastRowStarted;
      return STOP_OVERFLOW;
    }

    const avail = (outHardLimit - outPos) & ~3;
    const maxPos = pos + avail < inSafe4 ? pos + avail : inSafe4;
    while (pos <= maxPos) {
      const w = inDv.getInt32(pos, true);
      const x1 = w ^ 0x2c2c2c2c;
      const x2 = w ^ 0x5c5c5c5c;
      const x3 = w ^ 0x22222222;
      if (((((x1 - 0x01010101) & ~x1) | ((x2 - 0x01010101) & ~x2) | ((x3 - 0x01010101) & ~x3)) & 0x80808080) !== 0) {
        break;
      }
      outDv.setInt32(outPos, w, true);
      pos += 4;
      outPos += 4;
    }

    if (outPos > outHardLimit) {
      st[0] = pos; st[1] = outPos; st[2] = line; st[3] = recordCount;
      st[4] = fieldCount; st[5] = cutOutPos; st[6] = recordLine; st[7] = fastRowStarted;
      return STOP_OVERFLOW;
    }

    let b = inBuf[pos];
    while (b !== 44 && b !== 92 && b !== 34) {
      outBuf[outPos++] = b;
      b = inBuf[++pos];
    }

    if (b === 44) {
      outBuf[outPos++] = 34;
      fieldCount++;
      if (fieldCount === width) cutOutPos = outPos;
      outBuf[outPos++] = 44;
      outBuf[outPos++] = 34;
      pos++;

      // Inline fast path for simple single-line quoted fields (no "" or \r/\n inside)!
      while (inBuf[pos] === 92 && inBuf[pos + 1] === 34) {
        const qOutStart = outPos;
        let qpos = pos + 2;
        if (outPos > outHardLimit) {
          st[0] = pos; st[1] = outPos; st[2] = line; st[3] = recordCount;
          st[4] = fieldCount; st[5] = cutOutPos; st[6] = recordLine; st[7] = fastRowStarted;
          return STOP_OVERFLOW;
        }
        const qAvail = (outHardLimit - outPos) & ~3;
        const qMax = qpos + qAvail < inSafe4 ? qpos + qAvail : inSafe4;
        while (qpos <= qMax) {
          const w = inDv.getInt32(qpos, true);
          const x2 = w ^ 0x5c5c5c5c;
          const x3 = w ^ 0x22222222;
          if (((((x2 - 0x01010101) & ~x2) | ((x3 - 0x01010101) & ~x3)) & 0x80808080) !== 0) break;
          outDv.setInt32(outPos, w, true);
          qpos += 4;
          outPos += 4;
        }
        if (outPos > outHardLimit) {
          outPos = qOutStart;
          st[0] = pos; st[1] = outPos; st[2] = line; st[3] = recordCount;
          st[4] = fieldCount; st[5] = cutOutPos; st[6] = recordLine; st[7] = fastRowStarted;
          return STOP_OVERFLOW;
        }
        let qb = inBuf[qpos];
        while (qb !== 92 && qb !== 34) {
          outBuf[outPos++] = qb;
          qb = inBuf[++qpos];
        }
        // Clean closing \" followed immediately by ','!
        if (qb === 92 && inBuf[qpos + 1] === 34) {
          const afterQ = inBuf[qpos + 2];
          if (afterQ === 44) {
            outBuf[outPos++] = 34;
            fieldCount++;
            if (fieldCount === width) cutOutPos = outPos;
            outBuf[outPos++] = 44;
            outBuf[outPos++] = 34;
            pos = qpos + 3;
            continue;
          }
          // Clean closing \" at EOL (last column of a full-width row!)
          if (afterQ === 92 && width > 0 && fieldCount + 1 === width && recordCount >= 1) {
            const ae = inBuf[qpos + 3];
            let qEolLen = 0;
            if (ae === 110) qEolLen = 2;
            else if (ae === 114 && inBuf[qpos + 4] === 92 && inBuf[qpos + 5] === 110) qEolLen = 4;
            if (qEolLen > 0) {
              const npos = qpos + 2 + qEolLen;
              const nb = inBuf[npos];
              if (nb !== 34 && nb !== 92) {
                outDv.setInt32(outPos, 0x5b2c5d22, true);
                outBuf[outPos + 4] = 34;
                outPos += 5;
                pos = npos;
                line++;
                recordCount++;
                fieldCount = 0;
                cutOutPos = -1;
                recordLine = line;
                fastRowStarted = 1;
                break;
              }
            }
          }
        }
        // Anything complex (\"\", \n, \r, EOL, junk, EOF): rewind & let cold handler do it!
        outPos = qOutStart;
        st[0] = pos; st[1] = outPos; st[2] = line; st[3] = recordCount;
        st[4] = fieldCount; st[5] = cutOutPos; st[6] = recordLine; st[7] = fastRowStarted;
        return STOP_QUOTED;
      }
      continue;
    }

    if (b === 92) {
      const e = inBuf[pos + 1];
      let eolLen = 0;
      if (e === 110) {
        eolLen = 2;
      } else if (e === 114) {
        if (inBuf[pos + 2] === 92) {
          const e2 = inBuf[pos + 3];
          if (e2 === 110) eolLen = 4;
          else if (e2 === 117) return STOP_ABORT;
        }
        if (eolLen === 0) {
          st[0] = pos; st[1] = outPos; st[2] = line; st[3] = recordCount;
          st[4] = fieldCount; st[5] = cutOutPos; st[6] = recordLine; st[7] = fastRowStarted;
          return STOP_STRAY_CR;
        }
      } else if (e === 117) {
        return STOP_ABORT;
      } else {
        outBuf[outPos++] = 92;
        outBuf[outPos++] = e;
        pos += 2;
        continue;
      }

      // EOL reached! Chain directly into the next clean unquoted row when full-width!
      if (width > 0 && fieldCount + 1 === width && recordCount >= 1) {
        const npos = pos + eolLen;
        const nb = inBuf[npos];
        if (nb !== 34 && nb !== 92) {
          outDv.setInt32(outPos, 0x5b2c5d22, true);
          outBuf[outPos + 4] = 34;
          outPos += 5;
          pos = npos;
          line++;
          recordCount++;
          fieldCount = 0;
          cutOutPos = -1;
          recordLine = line;
          fastRowStarted = 1;
          continue;
        }
      }

      outBuf[outPos++] = 34;
      fieldCount++;
      pos += eolLen;
      line++;
      st[0] = pos; st[1] = outPos; st[2] = line; st[3] = recordCount;
      st[4] = fieldCount; st[5] = cutOutPos; st[6] = recordLine; st[7] = fastRowStarted;
      return STOP_EOL;
    }

    // b === 34 (EOF of JSON string)
    outBuf[outPos++] = 34;
    fieldCount++;
    st[0] = pos; st[1] = outPos; st[2] = line; st[3] = recordCount;
    st[4] = fieldCount; st[5] = cutOutPos; st[6] = recordLine; st[7] = fastRowStarted;
    return STOP_EOF;
  }
}

/**
 * Cold helper for complex quoted fields (escaped quotes, multiline, trailing junk, unterminated).
 */
function scanQuotedField(inBuf, inDv, inSafe4, outBuf, outDv, outHardLimit, width, st, errCodes, errLines, errRecs, errExtras, errBox) {
  let pos = st[0];
  let outPos = st[1];
  let line = st[2];
  const recordCount = st[3];
  let fieldCount = st[4];
  let cutOutPos = st[5];
  const recordLine = st[6];

  const openPos = pos;
  const openLine = line;
  const savedOutPos = outPos;
  pos += 2;
  let closed = false;

  while (true) {
    if (outPos > outHardLimit) return 0;
    const avail = (outHardLimit - outPos) & ~3;
    const maxPos = pos + avail < inSafe4 ? pos + avail : inSafe4;
    while (pos <= maxPos) {
      const w = inDv.getInt32(pos, true);
      const x2 = w ^ 0x5c5c5c5c;
      const x3 = w ^ 0x22222222;
      if (((((x2 - 0x01010101) & ~x2) | ((x3 - 0x01010101) & ~x3)) & 0x80808080) !== 0) break;
      outDv.setInt32(outPos, w, true);
      pos += 4;
      outPos += 4;
    }
    if (outPos > outHardLimit) return 0;

    let b = inBuf[pos];
    while (b !== 92 && b !== 34) {
      outBuf[outPos++] = b;
      b = inBuf[++pos];
    }

    if (b === 92) {
      const e = inBuf[pos + 1];
      if (e === 34) {
        if (inBuf[pos + 2] === 92) {
          const e2 = inBuf[pos + 3];
          if (e2 === 34) {
            outBuf[outPos++] = 92;
            outBuf[outPos++] = 34;
            pos += 4;
            continue;
          }
          if (e2 === 117) return 0;
        }
        pos += 2;
        closed = true;
        break;
      }
      if (e === 114) {
        outBuf[outPos++] = 92;
        outBuf[outPos++] = 110;
        line++;
        if (inBuf[pos + 2] === 92) {
          const e2 = inBuf[pos + 3];
          if (e2 === 110) { pos += 4; continue; }
          if (e2 === 117) return 0;
        }
        pos += 2;
        continue;
      }
      if (e === 110) {
        outBuf[outPos++] = 92;
        outBuf[outPos++] = 110;
        line++;
        pos += 2;
        continue;
      }
      if (e === 117) return 0;
      outBuf[outPos++] = 92;
      outBuf[outPos++] = e;
      pos += 2;
      continue;
    }
    break;
  }

  let ec = errBox[0];
  if (!closed) {
    pos = openPos + 2;
    line = openLine;
    outPos = savedOutPos;
    errCodes[ec] = ERR_UNTERMINATED_QUOTE;
    errLines[ec] = recordLine;
    errRecs[ec] = recordCount;
    errExtras[ec] = 0;
    ec++;
    outBuf[outPos++] = 92;
    outBuf[outPos++] = 34;
    errBox[0] = ec;
    st[0] = pos; st[1] = outPos; st[2] = line; st[4] = fieldCount; st[5] = cutOutPos;
    return 4;
  }

  const nb = inBuf[pos];
  if (nb === 44) {
    outBuf[outPos++] = 34;
    fieldCount++;
    if (fieldCount === width) cutOutPos = outPos;
    outBuf[outPos++] = 44;
    outBuf[outPos++] = 34;
    pos++;
    st[0] = pos; st[1] = outPos; st[2] = line; st[4] = fieldCount; st[5] = cutOutPos;
    return COMMA;
  }
  if (nb === 34) {
    outBuf[outPos++] = 34;
    fieldCount++;
    st[0] = pos; st[1] = outPos; st[2] = line; st[4] = fieldCount; st[5] = cutOutPos;
    return END;
  }
  if (nb === 92 && inBuf[pos + 1] === 110) {
    pos += 2;
    line++;
    outBuf[outPos++] = 34;
    fieldCount++;
    st[0] = pos; st[1] = outPos; st[2] = line; st[4] = fieldCount; st[5] = cutOutPos;
    return LINE_BREAK;
  }
  if (nb === 92 && inBuf[pos + 1] === 114 && inBuf[pos + 2] === 92 && inBuf[pos + 3] === 110) {
    pos += 4;
    line++;
    outBuf[outPos++] = 34;
    fieldCount++;
    st[0] = pos; st[1] = outPos; st[2] = line; st[4] = fieldCount; st[5] = cutOutPos;
    return LINE_BREAK;
  }

  let junkAdded = false;
  let ended = END;
  while (true) {
    if (outPos > outHardLimit) return 0;
    const b = inBuf[pos];
    if (b === 44) { pos++; ended = COMMA; break; }
    if (b === 92) {
      const e = inBuf[pos + 1];
      if (e === 110) { pos += 2; line++; ended = LINE_BREAK; break; }
      if (e === 114) {
        if (inBuf[pos + 2] === 92) {
          const e2 = inBuf[pos + 3];
          if (e2 === 110) { pos += 4; line++; ended = LINE_BREAK; break; }
          if (e2 === 117) return 0;
        }
        errCodes[ec] = ERR_STRAY_CR;
        errLines[ec] = recordLine;
        errRecs[ec] = recordCount;
        errExtras[ec] = 0;
        ec++;
        pos += 2;
        continue;
      }
      if (e === 117) return 0;
      outBuf[outPos++] = 92;
      outBuf[outPos++] = e;
      pos += 2;
      junkAdded = true;
      continue;
    }
    if (b === 34) { ended = END; break; }
    outBuf[outPos++] = b;
    pos++;
    junkAdded = true;
  }

  if (junkAdded) {
    errCodes[ec] = ERR_QUOTE_JUNK;
    errLines[ec] = recordLine;
    errRecs[ec] = recordCount;
    errExtras[ec] = 0;
    ec++;
  }
  errBox[0] = ec;

  outBuf[outPos++] = 34;
  fieldCount++;
  if (ended === COMMA) {
    if (fieldCount === width) cutOutPos = outPos;
    outBuf[outPos++] = 44;
    outBuf[outPos++] = 34;
  }
  st[0] = pos; st[1] = outPos; st[2] = line; st[4] = fieldCount; st[5] = cutOutPos;
  return ended;
}

// ---------- Envelope & Case Streaming ----------

function skipWs(buf, p, end) {
  while (p < end) {
    const b = buf[p];
    if (b === 32 || b === 10 || b === 13 || b === 9) p++;
    else break;
  }
  return p;
}

function skipJsonString(buf, p, end) {
  p++;
  while (p < end) {
    const b = buf[p];
    if (b === 34) return p + 1;
    if (b === 92) p += 2;
    else p++;
  }
  return p;
}

function skipJsonValue(buf, p, end) {
  p = skipWs(buf, p, end);
  if (p >= end) return p;
  const b = buf[p];
  if (b === 34) return skipJsonString(buf, p, end);
  if (b === 123 || b === 91) {
    let depth = 1;
    p++;
    while (p < end && depth > 0) {
      const c = buf[p];
      if (c === 34) p = skipJsonString(buf, p, end);
      else if (c === 123 || c === 91) { depth++; p++; }
      else if (c === 125 || c === 93) { depth--; p++; }
      else p++;
    }
    return p;
  }
  while (p < end) {
    const c = buf[p];
    if (c === 44 || c === 125 || c === 93 || c === 32 || c === 10 || c === 13 || c === 9) break;
    p++;
  }
  return p;
}

function matchKey(buf, start, end, str) {
  const len = str.length;
  if (end - start !== len) return false;
  for (let i = 0; i < len; i++) {
    if (buf[start + i] !== str.charCodeAt(i)) return false;
  }
  return true;
}

function isHexFEFF(buf, p) {
  return (
    (buf[p] | 32) === 102 &&
    (buf[p + 1] | 32) === 101 &&
    (buf[p + 2] | 32) === 102 &&
    (buf[p + 3] | 32) === 102
  );
}

function serializeErrors(errCodes, errLines, errRecs, errExtras, errCount, header) {
  if (errCount === 0) return '';
  let out = '';
  for (let i = 0; i < errCount; i++) {
    if (i > 0) out += ',';
    const rec = errRecs[i];
    const rowStr = header ? (rec === 0 ? 'null' : String(rec - 1)) : String(rec);
    const code = errCodes[i];
    const ln = errLines[i];
    if (code === ERR_SHORT_ROW) {
      out += `{"code":"short_row","line":${ln},"row":${rowStr},"fields":${errExtras[i]}}`;
    } else if (code === ERR_LONG_ROW) {
      out += `{"code":"long_row","line":${ln},"row":${rowStr},"extra":${errExtras[i]}}`;
    } else if (code === ERR_STRAY_CR) {
      out += `{"code":"stray_cr","line":${ln},"row":${rowStr}}`;
    } else if (code === ERR_QUOTE_JUNK) {
      out += `{"code":"quote_junk","line":${ln},"row":${rowStr}}`;
    } else {
      out += `{"code":"unterminated_quote","line":${ln},"row":${rowStr}}`;
    }
  }
  return out;
}

function transduceTextCase(inBuf, inDv, inLen, startPos, outBuf, outDv, errCodes, errLines, errRecs, errExtras) {
  const st = new Int32Array(8);
  const errBox = new Int32Array(1);
  const inSafe4 = inLen - 4;
  const outHardLimit = outBuf.length - 16384;

  let pos = startPos;
  if (inBuf[pos] === 0xef && inBuf[pos + 1] === 0xbb && inBuf[pos + 2] === 0xbf) {
    pos += 3;
  } else if (inBuf[pos] === 92 && inBuf[pos + 1] === 117 && isHexFEFF(inBuf, pos + 2)) {
    pos += 6;
  }

  st[0] = pos;
  st[1] = 0; // outPos always starts at 0 in the reusable per-case buffer!
  st[2] = 1; // line
  st[3] = 0; // recordCount

  let width = -1;
  let firstRecBuf = null;

  while (true) {
    pos = st[0];
    let line = st[2];

    while (true) {
      const b = inBuf[pos];
      if (b === 92) {
        const e = inBuf[pos + 1];
        if (e === 110) { pos += 2; line++; continue; }
        if (e === 114) {
          if (inBuf[pos + 2] === 92) {
            const e2 = inBuf[pos + 3];
            if (e2 === 110) { pos += 4; line++; continue; }
            if (e2 === 117) return null;
          }
          break;
        }
        if (e === 117) return null;
      }
      break;
    }

    st[0] = pos;
    st[2] = line;
    if (inBuf[pos] === 34) break;

    let outPos = st[1];
    if (outPos > outHardLimit) return null;

    const rowStartOut = outPos;
    if (st[3] > 1) outBuf[outPos++] = 44;
    outBuf[outPos++] = 91;
    outBuf[outPos++] = 34;
    const firstFieldStart = outPos;
    const firstFieldQuoted = inBuf[pos] === 92 && inBuf[pos + 1] === 34;

    st[1] = outPos;
    st[4] = 0;
    st[5] = -1;
    st[6] = line;
    st[7] = 0;

    let mode = firstFieldQuoted ? STOP_QUOTED : -1;

    while (true) {
      if (mode === -1) {
        mode = runFastBurst(inBuf, inDv, inSafe4, outBuf, outDv, outHardLimit, width, st);
      }
      if (mode === STOP_EOL || mode === STOP_EOF) break;
      if (mode === STOP_ABORT || mode === STOP_OVERFLOW) return null;

      if (mode === STOP_STRAY_CR) {
        const ec = errBox[0];
        errCodes[ec] = ERR_STRAY_CR;
        errLines[ec] = st[6];
        errRecs[ec] = st[3];
        errExtras[ec] = 0;
        errBox[0] = ec + 1;
        st[0] += 2;
        mode = -1;
        continue;
      }

      const qres = scanQuotedField(
        inBuf, inDv, inSafe4, outBuf, outDv, outHardLimit, width, st,
        errCodes, errLines, errRecs, errExtras, errBox
      );
      if (qres === 0) return null;
      if (qres === LINE_BREAK || qres === END) break;
      if (qres === 4) {
        mode = -1;
        continue;
      }
      const np = st[0];
      mode = inBuf[np] === 92 && inBuf[np + 1] === 34 ? STOP_QUOTED : -1;
    }

    const fieldCount = st[4];
    outPos = st[1];

    if (st[7] === 0 && fieldCount === 1 && !firstFieldQuoted && outPos - 1 === firstFieldStart) {
      st[1] = rowStartOut;
      continue;
    }

    if (width < 0) {
      width = fieldCount;
      outBuf[outPos++] = 93;
      firstRecBuf = Buffer.from(outBuf.subarray(rowStartOut, outPos));
      st[1] = 0;
      st[3] = 1;
      continue;
    }

    if (fieldCount < width) {
      const ec = errBox[0];
      errCodes[ec] = ERR_SHORT_ROW;
      errLines[ec] = st[6];
      errRecs[ec] = st[3];
      errExtras[ec] = fieldCount;
      errBox[0] = ec + 1;
      const need = (width - fieldCount) * 3 + 4;
      if (outPos + need > outBuf.length) return null;
      for (let k = fieldCount; k < width; k++) {
        outBuf[outPos++] = 44;
        outBuf[outPos++] = 34;
        outBuf[outPos++] = 34;
      }
    } else if (fieldCount > width) {
      const cutOutPos = st[5];
      const extraJson = '[' + outBuf.toString('utf8', cutOutPos + 1, outPos) + ']';
      const ec = errBox[0];
      errCodes[ec] = ERR_LONG_ROW;
      errLines[ec] = st[6];
      errRecs[ec] = st[3];
      errExtras[ec] = extraJson;
      errBox[0] = ec + 1;
      outPos = cutOutPos;
    }

    outBuf[outPos++] = 93;
    st[1] = outPos;
    st[3] += 1;
  }

  return {
    pos: st[0],
    outPos: st[1],
    firstRecBuf,
    recordCount: st[3],
    errCount: errBox[0],
  };
}

const B_OPEN_ARR = Buffer.from('[');
const B_CLOSE_ARR = Buffer.from(']');
const B_COMMA_BUF = Buffer.from(',');
const B_HDR_PREFIX = Buffer.from('{"columns":');
const B_HDR_ROWS = Buffer.from(',"rows":[');
const B_NOHDR_PREFIX = Buffer.from('{"columns":null,"rows":[');

/**
 * Streams raw cases.json bytes directly to output file descriptor `fd`,
 * reusing a single L2-cache-hot 4 MiB output scratch buffer across cases.
 */
export function transduceToFd(inBuf, fd) {
  const inLen = inBuf.length;
  const inDv = new DataView(inBuf.buffer, inBuf.byteOffset, inLen);

  // Reusable 5 MiB scratch buffer (unused pages stay unfaulted; hot 2.2 MB stays in L2/L3 cache).
  const scratchSize = Math.min(Math.max(524288, (inLen >> 1) + 262144), 5242880);
  const outBuf = Buffer.allocUnsafe(scratchSize);
  const outDv = new DataView(outBuf.buffer, outBuf.byteOffset, scratchSize);

  const errCodes = [];
  const errLines = [];
  const errRecs = [];
  const errExtras = [];

  let p = skipWs(inBuf, 0, inLen);
  if (inBuf[p] !== 91) {
    const cases = JSON.parse(inBuf.toString('utf8'));
    writevSync(fd, [Buffer.from(JSON.stringify(cases.map((c) => run(c.input))))]);
    return;
  }
  p = skipWs(inBuf, p + 1, inLen);

  let caseCount = 0;

  while (p < inLen && inBuf[p] !== 93) {
    if (caseCount > 0) {
      if (inBuf[p] !== 44) break;
      p = skipWs(inBuf, p + 1, inLen);
    }

    const caseObjStart = p;
    if (inBuf[p] !== 123) {
      const cases = JSON.parse(inBuf.toString('utf8'));
      writevSync(fd, [Buffer.from(JSON.stringify(cases.map((c) => run(c.input))))]);
      return;
    }
    p = skipWs(inBuf, p + 1, inLen);

    let inputStart = -1;
    let inputEnd = -1;
    let headerVal = false;
    let sawText = false;
    let fallbackCase = false;
    let res = null;

    while (p < inLen && inBuf[p] !== 125) {
      const kStart = p + 1;
      const kEnd = skipJsonString(inBuf, p, inLen) - 1;
      p = skipWs(inBuf, kEnd + 1, inLen);
      p = skipWs(inBuf, p + 1, inLen);

      if (matchKey(inBuf, kStart, kEnd, 'input')) {
        inputStart = p;
        if (inBuf[p] !== 123) {
          fallbackCase = true;
          p = skipJsonValue(inBuf, p, inLen);
          inputEnd = p;
        } else {
          p = skipWs(inBuf, p + 1, inLen);
          while (p < inLen && inBuf[p] !== 125) {
            const ikStart = p + 1;
            const ikEnd = skipJsonString(inBuf, p, inLen) - 1;
            p = skipWs(inBuf, ikEnd + 1, inLen);
            p = skipWs(inBuf, p + 1, inLen);

            if (matchKey(inBuf, ikStart, ikEnd, 'header')) {
              if (
                inBuf[p] === 116 &&
                inBuf[p + 1] === 114 &&
                inBuf[p + 2] === 117 &&
                inBuf[p + 3] === 101
              ) {
                headerVal = true;
                p += 4;
              } else {
                headerVal = false;
                p = skipJsonValue(inBuf, p, inLen);
              }
            } else if (matchKey(inBuf, ikStart, ikEnd, 'text')) {
              sawText = true;
              if (inBuf[p] !== 34) {
                fallbackCase = true;
                p = skipJsonValue(inBuf, p, inLen);
              } else {
                res = transduceTextCase(
                  inBuf, inDv, inLen, p + 1,
                  outBuf, outDv,
                  errCodes, errLines, errRecs, errExtras
                );
                if (res === null) {
                  fallbackCase = true;
                  p = skipJsonString(inBuf, p, inLen);
                } else {
                  p = res.pos + 1;
                }
              }
            } else {
              p = skipJsonValue(inBuf, p, inLen);
            }

            p = skipWs(inBuf, p, inLen);
            if (inBuf[p] === 44) p = skipWs(inBuf, p + 1, inLen);
          }
          if (inBuf[p] === 125) p++;
          inputEnd = p;
        }
      } else {
        p = skipJsonValue(inBuf, p, inLen);
      }

      p = skipWs(inBuf, p, inLen);
      if (inBuf[p] === 44) p = skipWs(inBuf, p + 1, inLen);
    }
    if (inBuf[p] === 125) p++;

    const lead = caseCount === 0 ? B_OPEN_ARR : B_COMMA_BUF;
    if (fallbackCase || !sawText || res === null) {
      const obj = JSON.parse(
        inBuf.toString('utf8', inputStart >= 0 ? inputStart : caseObjStart, inputEnd >= 0 ? inputEnd : p)
      );
      const ans = run(inputStart >= 0 ? obj : obj.input);
      writevSync(fd, [lead, Buffer.from(JSON.stringify(ans))]);
    } else {
      const errJson = serializeErrors(errCodes, errLines, errRecs, errExtras, res.errCount, headerVal);
      if (res.recordCount === 0) {
        writevSync(fd, [
          lead,
          Buffer.from(
            headerVal
              ? `{"columns":[],"rows":[],"errors":[${errJson}]}`
              : `{"columns":null,"rows":[],"errors":[${errJson}]}`
          ),
        ]);
      } else if (headerVal) {
        const suffix = Buffer.from(`],"errors":[${errJson}]}`);
        if (res.outPos > 0) {
          writevSync(fd, [lead, B_HDR_PREFIX, res.firstRecBuf, B_HDR_ROWS, outBuf.subarray(0, res.outPos), suffix]);
        } else {
          writevSync(fd, [lead, B_HDR_PREFIX, res.firstRecBuf, B_HDR_ROWS, suffix]);
        }
      } else {
        const suffix = Buffer.from(`],"errors":[${errJson}]}`);
        if (res.outPos > 0) {
          writevSync(fd, [lead, B_NOHDR_PREFIX, res.firstRecBuf, B_COMMA_BUF, outBuf.subarray(0, res.outPos), suffix]);
        } else {
          writevSync(fd, [lead, B_NOHDR_PREFIX, res.firstRecBuf, suffix]);
        }
      }
    }

    caseCount++;
    p = skipWs(inBuf, p, inLen);
  }

  writevSync(fd, caseCount === 0 ? [B_OPEN_ARR, B_CLOSE_ARR] : [B_CLOSE_ARR]);
}
