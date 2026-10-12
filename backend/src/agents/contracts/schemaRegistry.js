import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schemas');
const files = fs.readdirSync(schemaDir).filter((name) => name.endsWith('.schema.json')).sort();
const schemas = new Map();

for (const file of files) {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
  const shortId = file.replace('.schema.json', '');
  schemas.set(shortId, schema);
  schemas.set(`${shortId}.v1`, schema);
  schemas.set(schema.$id, schema);
}

export function getSupportAgentSchema(id) {
  return schemas.get(String(id || '')) || null;
}

export function listSupportAgentSchemas() {
  return files.map((file) => getSupportAgentSchema(file.replace('.schema.json', '')));
}
