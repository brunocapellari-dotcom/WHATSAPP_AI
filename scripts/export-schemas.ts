import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CollectorStatusSchema,
  FreightEventSchema,
  FreightObservationSchema,
  OutboxEventSchema,
  RawMessageSchema,
} from '../src/domain/schemas.js';

const outputDir = join(process.cwd(), 'generated-schemas');
await mkdir(outputDir, { recursive: true });

const schemas = {
  'raw-message.schema.json': RawMessageSchema,
  'freight-observation.schema.json': FreightObservationSchema,
  'freight-event.schema.json': FreightEventSchema,
  'outbox-event.schema.json': OutboxEventSchema,
  'collector-status.schema.json': CollectorStatusSchema,
};

for (const [fileName, schema] of Object.entries(schemas)) {
  const jsonSchema = z.toJSONSchema(schema);
  await writeFile(
    join(outputDir, fileName),
    JSON.stringify(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        ...jsonSchema,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

console.log(`Exported ${Object.keys(schemas).length} JSON Schemas to generated-schemas/`);
