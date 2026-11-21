// solve.js — a fast drop-in for csv-reader 1.0.0's readCsv.
//
// The text is read once, left to right. A plain field is found by walking to
// its next comma or line break and taking one slice of the text; a quoted
// field is assembled from the slices between the characters that matter
// inside it (a quote, a CR), so no field is ever built a character at a time.
// The broken-row policy is the reference's own, kept exactly:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote and each CRLF or lone CR inside it read
//     as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends);
//   - a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row} in the order met, a record's
//     short_row or long_row when it ends: line the 1-based line its record
//     starts on, counting every LF, CRLF and lone CR inside quotes, and row
//     its record's index in rows, null for the header.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const AT_COMMA = 0;
const AT_BREAK = 1;
const AT_END = 2;

/** csv-reader's reading of one case's input {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;

  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error met while reading it names both.
  let recordLine = 1;
  let recordRow = null;

  // How the field just read ended, and how many characters that read kept
  // (a read's seed is not counted: the quote_junk rule asks what the junk
  // after a closing quote added, not what the quoted part held).
  let ended = AT_END;
  let kept = 0;

  function fail(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Unquoted reading from a stray CR on: the text before the CR is one kept
  // segment and each later stray CR closes another, so the value is the join
  // of its segments. `seed` leads the value and is not counted in `kept`.
  function plainTail(seed, start, i) {
    const parts = seed === '' ? [] : [seed];
    let seg = start;
    let total = 0;
    for (;;) {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        i += 1;
      }
      parts.push(text.slice(seg, i));
      total += i - seg;
      if (i >= n) {
        pos = n;
        ended = AT_END;
        kept = total;
        return parts.join('');
      }
      const c = text.charCodeAt(i);
      if (c === 44) {
        pos = i + 1;
        ended = AT_COMMA;
        kept = total;
        return parts.join('');
      }
      if (c === 10) {
        pos = i + 1;
        line += 1;
        ended = AT_BREAK;
        kept = total;
        return parts.join('');
      }
      if (text.charCodeAt(i + 1) === 10) {
        pos = i + 2;
        line += 1;
        ended = AT_BREAK;
        kept = total;
        return parts.join('');
      }
      // A CR not followed by LF is dropped.
      fail('stray_cr');
      i += 1;
      seg = i;
    }
  }

  // Reads unquoted characters onto `seed` up to the next comma or line
  // break. With no stray CR met the value is one slice of the text.
  function readPlain(seed) {
    const start = pos;
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        pos = i + 1;
        ended = AT_COMMA;
        kept = i - start;
        const v = text.slice(start, i);
        return seed === '' ? v : seed + v;
      }
      if (c === 10) {
        pos = i + 1;
        line += 1;
        ended = AT_BREAK;
        kept = i - start;
        const v = text.slice(start, i);
        return seed === '' ? v : seed + v;
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          pos = i + 2;
          line += 1;
          ended = AT_BREAK;
          kept = i - start;
          const v = text.slice(start, i);
          return seed === '' ? v : seed + v;
        }
        return plainTail(seed, start, i);
      }
      i += 1;
    }
    pos = n;
    ended = AT_END;
    kept = n - start;
    const v = text.slice(start, n);
    return seed === '' ? v : seed + v;
  }

  // Reads a quoted field whose opening quote is at pos. Inside it only a
  // quote and a CR cut the current slice: an LF stays in its slice and is
  // counted as it passes.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let seg = i;
    let parts = null;
    for (;;) {
      if (i >= n) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        fail('unterminated_quote');
        return readPlain('"');
      }
      const c = text.charCodeAt(i);
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          // A doubled quote is one quote in the value.
          if (parts === null) parts = [];
          parts.push(text.slice(seg, i), '"');
          i += 2;
          seg = i;
          continue;
        }
        let value;
        if (parts === null) {
          value = text.slice(seg, i);
        } else {
          parts.push(text.slice(seg, i));
          value = parts.join('');
        }
        i += 1; // past the closing quote
        if (i >= n) {
          pos = i;
          ended = AT_END;
          return value;
        }
        const d = text.charCodeAt(i);
        if (d === 44) {
          pos = i + 1;
          ended = AT_COMMA;
          return value;
        }
        if (d === 10) {
          pos = i + 1;
          line += 1;
          ended = AT_BREAK;
          return value;
        }
        if (d === 13 && text.charCodeAt(i + 1) === 10) {
          pos = i + 2;
          line += 1;
          ended = AT_BREAK;
          return value;
        }
        // What follows the closing quote is appended as it stands, up to
        // the next comma or line break.
        pos = i;
        const joined = readPlain(value);
        if (kept > 0) fail('quote_junk');
        return joined;
      }
      if (c === 13) {
        // A CRLF or a lone CR inside quotes is read as one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(seg, i), '\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        seg = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const fields = [];
    let quoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        fields.push(readQuoted());
      } else {
        quoted = false;
        fields.push(readPlain(''));
      }
      if (ended !== AT_COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: it is no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
