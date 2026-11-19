(function (root) {
  function parseCsv(text) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < source.length; i += 1) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"') {
          if (source[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && source[i + 1] === '\n') i += 1;
        row.push(field);
        field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else {
        field += ch;
      }
    }

    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function serializeCsv(rows) {
    return rows
      .map((row) =>
        row
          .map((field) => {
            const value = String(field === null || field === undefined ? '' : field);
            return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
          })
          .join(',')
      )
      .join('\n') + '\n';
  }

  const api = { parseCsv, serializeCsv };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CSV = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
