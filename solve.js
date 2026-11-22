// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// run(input) returns exactly csv-reader 1.0.0's answer for {text, header}:
// {columns, rows, errors}. The reading rules, in brief:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled
//     ("" inside it is one quote, each CRLF or lone CR inside it is read as LF);
//     what follows its closing quote, up to the next comma or line break, is
//     appended as it stands (error quote_junk, when the field ends); a quote
//     that never closes is a literal character and the text after it is read
//     again as unquoted (error unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based line
//     its record starts on, counting every LF, CRLF and lone CR inside quotes,
//     and row its record's index in rows (null for the header).
//
// How it is fast: the reference reads one character at a time and builds every
// field by appending one character at a time. This reader instead works on
// slices between delimiters, each found with one native scan. Every record is
// read in plain runs: each run is the text up to the next quote, CR or LF,
// split on ',' by native code, so its plain fields come out whole; only a
// field that actually opens with a quote, or the junk after one, is read
// field by field. (An earlier version first probed for runs of clean lines
// and split those whole; on the drawn sets the probe and the extra split
// cost more than they saved, so the probe is gone.) Nothing is kept from
// one call to the next.

/** A field ends at a comma (the record goes on), at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The next delimiter (, \r or \n) at or after lastIndex, in one native scan.
  const DELIM = /[,\r\n]/g;
  // The next '"' , '\r' or '\n' at or after lastIndex, in one native scan.
  const PLAIN = /["\r\n]/g;
  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Takes one record's fields: the first record sets the width (and is the
  // columns when a header is read); a later one is padded or cut to the width,
  // with its short_row or long_row error, and appended to rows.
  function finishFields(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). A quote in here is a literal character: the
  // scan stops only at a comma, a CR or an LF, so one inside the field is kept as part
  // of the slice. Returns the field and how it ended. Only used where a field is known
  // to be unquoted already: the junk after a closing quote, and the text after a quote
  // that never closes.
  function readUnquoted(value) {
    let start = pos;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (start < n) value += text.slice(start, n);
        pos = n;
        return { value, ended: END };
      }
      const at = m.index;
      const c = m[0];
      if (c === ',') {
        if (start < at) value += text.slice(start, at);
        pos = at + 1;
        return { value, ended: COMMA };
      }
      if (c === '\n') {
        if (start < at) value += text.slice(start, at);
        pos = at + 1;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      // c === '\r'
      if (text.charCodeAt(at + 1) === 10) {
        if (start < at) value += text.slice(start, at);
        pos = at + 2;
        line += 1;
        return { value, ended: LINE_BREAK };
      }
      error('stray_cr');
      if (start < at) value += text.slice(start, at);
      pos = at + 1;
      start = at + 1;
    }
  }

  // The last quoted (or re-read) field's value and how it ended, written by
  // readQuoted into these instead of a fresh result object per field.
  let qv = '';
  let qe = 0;

  // Reads a quoted field whose opening quote is at pos into qv and qe.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let closed = false;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (q > pos) {
        const seg = text.slice(pos, q);
        if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
          value += seg;
        } else {
          // CRLF and a lone CR inside quotes are each one LF, and each counts as one line.
          let extra = 0;
          for (let i = 0; i < seg.length; i++) {
            const cc = seg.charCodeAt(i);
            if (cc === 10) extra += 1;
            else if (cc === 13) {
              extra += 1;
              if (seg.charCodeAt(i + 1) === 10) i += 1;
            }
          }
          line += extra;
          value += seg.replace(/\r\n?|\n/g, '\n');
        }
      }
      if (text.charCodeAt(q + 1) === 34) {
        value += '"';
        pos = q + 2;
        continue;
      }
      pos = q + 1;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      const re = readUnquoted('"');
      qv = re.value;
      qe = re.ended;
      return;
    }
    if (pos >= n) { qv = value; qe = END; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      qv = value; qe = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      qv = value; qe = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      qv = value; qe = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.value.length > value.length) error('quote_junk');
    qv = junk.value;
    qe = junk.ended;
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

    // Read the record in plain runs, each split on ',' by native code, with
    // quoted fields read singly.
    {
      const fields = [];
      let cur = ''; // the field being built ('' while the next field has taken nothing yet)
      let fresh = true; // the field being built has taken nothing yet: a quote here opens one
      let quoted = false; // the last field pushed opened with a quote
      let ended;
      for (;;) {
        if (fresh && text.charCodeAt(pos) === 34) {
          readQuoted();
          fields.push(qv);
          quoted = true;
          ended = qe;
          if (ended === COMMA) {
            fresh = true;
            continue;
          }
          break;
        }
        PLAIN.lastIndex = pos;
        const hit = PLAIN.exec(text);
        const h = hit === null ? n : hit.index;
        if (h > pos) {
          // The run holds no quote, CR or LF: its commas are field breaks.
          const parts = text.slice(pos, h).split(',');
          if (parts.length === 1) {
            cur += parts[0];
            fresh = false;
          } else {
            cur += parts[0];
            fields.push(cur);
            quoted = false;
            for (let i = 1; i < parts.length - 1; i++) fields.push(parts[i]);
            cur = parts[parts.length - 1];
            fresh = cur === '';
          }
          pos = h;
        }
        if (hit === null) {
          fields.push(cur);
          quoted = false;
          ended = END;
          break;
        }
        const c = text.charCodeAt(h);
        if (c === 10) {
          fields.push(cur);
          quoted = false;
          pos = h + 1;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        if (c === 13) {
          if (text.charCodeAt(h + 1) === 10) {
            fields.push(cur);
            quoted = false;
            pos = h + 2;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          error('stray_cr');
          pos = h + 1;
          fresh = false;
          continue;
        }
        // c === 34 (a quote): inside an unquoted field it is a literal
        // character — unless the field has taken nothing yet, in which case
        // it opens a quoted field.
        if (fresh) {
          readQuoted();
          fields.push(qv);
          quoted = true;
          ended = qe;
          if (ended === COMMA) {
            fresh = true;
            continue;
          }
          break;
        }
        cur += '"';
        pos = h + 1;
        fresh = false;
      }

      // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;

      if (width >= 0 && fields.length === width) rows.push(fields);
      else finishFields(fields);
    }
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
