import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const database = process.argv[2];
const output = resolve(process.argv[3] || 'offline-dictionary-data.json');
if (!database) throw new Error('Usage: node scripts/build-offline-dictionary.mjs /path/to/ecdict.db [output.json]');
const query = 'select word, phonetic, definition, translation, pos, oxford, tag from stardict where word = lower(word) order by word';
const rows = JSON.parse(execFileSync('sqlite3', ['-json', database, query], { encoding:'utf8', maxBuffer:128 * 1024 * 1024 }));
const entries = rows.filter((row) => row.word && (row.translation || row.definition)).map((row) => ({ word:row.word, phonetic:row.phonetic || '', definition:row.definition || '', translation:row.translation || '', pos:row.pos || '', oxford:Boolean(row.oxford), tag:row.tag || '' }));
writeFileSync(output, JSON.stringify(entries));
console.log(`Wrote ${entries.length} offline dictionary entries to ${output}`);
