import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { config } from '../config.js';

// Resolve a file_url (as returned by UploadFile) to an absolute path on disk.
function resolveUploadPath(fileUrl) {
  if (!fileUrl) throw new Error('file_url is required');
  const name = fileUrl.split('/').pop().split('?')[0];
  return path.join(config.uploadDir, name);
}

// Mirror of the platform's ExtractDataFromUploadedFile.
// Reads a CSV/XLSX upload and returns rows shaped by the provided json_schema
// (array of objects). Falls back to raw rows when no schema is given.
export async function extractDataFromFile({ file_url, json_schema } = {}) {
  try {
    const filePath = resolveUploadPath(file_url);
    if (!fs.existsSync(filePath)) return { status: 'error', details: 'File not found' };

    const wb = XLSX.readFile(filePath, { cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    // If a schema of type array is provided, coerce known property types.
    const itemSchema = json_schema?.items?.properties || json_schema?.properties || null;
    let output = rows;
    if (itemSchema) {
      output = rows.map((row) => {
        const obj = {};
        for (const [key, def] of Object.entries(itemSchema)) {
          let val = row[key];
          if (val === undefined) {
            // Case-insensitive header match.
            const hit = Object.keys(row).find((h) => h.toLowerCase().trim() === key.toLowerCase().trim());
            val = hit ? row[hit] : '';
          }
          if (def.type === 'number') val = val === '' ? null : Number(val);
          else if (def.type === 'boolean') val = /^(1|true|yes)$/i.test(String(val));
          obj[key] = val;
        }
        return obj;
      });
    }

    return { status: 'success', output };
  } catch (err) {
    return { status: 'error', details: err.message };
  }
}

export default extractDataFromFile;
