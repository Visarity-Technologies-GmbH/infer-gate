import { mkdir, readdir, rm, writeFile, appendFile, chmod } from 'node:fs/promises';
import { ChatOutputCollector } from './chat-output.js';
import { MessagesOutputCollector } from './messages-output.js';
import { UsageCollector } from './usage.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const debugLogDirectory = fileURLToPath(new URL('../../logs/', import.meta.url));
const retentionMs = 60 * 86400000;
const requestDirectory = /^\d{13}-[a-f0-9-]{36}$/;

export async function debugLoggingEnabled(db) {
  const [setting] = await db.query('SELECT enabled FROM debug_logging_settings WHERE id=1');
  return setting?.enabled === 1 || setting?.enabled === true;
}

// Only this diagnostic feature writes bodies. Never include HTTP headers or credentials.
export function createDebugLogger({ directory = debugLogDirectory, log = () => {} } = {}) {
  let lastCleanup = 0;
  const failed = requestId => log({ event: 'debug_log_write_failed', request_id: requestId });
  return async (record, input) => {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const now = Date.now();
      if (now - lastCleanup > 3600000) {
        lastCleanup = now;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isDirectory() && requestDirectory.test(entry.name) && Number(entry.name.slice(0, 13)) < now - retentionMs) {
            await rm(join(directory, entry.name), { recursive: true, force: true });
          }
        }
      }
      const path = join(directory, `${now}-${record.request_id}`);
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'input.json'), input, { mode: 0o600, flag: 'wx' });
      let collector, broken = false;
      const streamFiles = new Set();
      const outputEventWriter = filename => {
        let originalStream = false, originalStreamBytes = 0, originalStreamTruncated = false;
        return async result => {
          if (originalStreamTruncated) return;
          try {
            if (!originalStream) {
              await writeFile(join(path, filename), '[', { mode: 0o600, flag: 'wx' });
              originalStream = true;
              streamFiles.add(filename);
            }
            const value = JSON.stringify(result);
            const size = Buffer.byteLength(value) + (originalStreamBytes ? 1 : 0);
            if (originalStreamBytes + size > 16 * 1024 * 1024) {
              await appendFile(join(path, filename), (originalStreamBytes ? ',' : '') + '{"truncated":true}');
              originalStreamTruncated = true;
              return;
            }
            await appendFile(join(path, filename), (originalStreamBytes ? ',' : '') + value);
            originalStreamBytes += size;
          } catch { originalStreamTruncated = true; failed(record.request_id); }
        };
      };

      const originalOutputEvent = outputEventWriter('original_output.json');
      const originalOutput = async result => {
        try {
          await writeFile(join(path, 'original_output.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
        } catch { failed(record.request_id); }
      };
      let originalCollector;
      let originalValues = [];
      const flushOriginal = async () => {
        for (const value of originalValues) {
          await (originalCollector.sse ? originalOutputEvent(value) : originalOutput(value));
        }
        originalValues = [];
      };

      return {
        async logDebug(fileName, text) {
          if (typeof fileName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(fileName) || typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) return false;
          try { await writeFile(join(path, fileName), text, { mode: 0o600, flag: 'w' }); return true; }
          catch { failed(record.request_id); return false; }
        },
        // Observe pass-through output without changing forwarding or requiring a script.
        async pushOriginal(chunk, contentType) {
          try {
            if (!originalCollector) {
              originalCollector = new UsageCollector(contentType, 16 * 1024 * 1024);
              originalCollector.parse = value => {
                try { originalValues.push(JSON.parse(value)); } catch { /* Ignore non-JSON SSE markers. */ }
              };
            }
            originalCollector.push(chunk);
            await flushOriginal();
          } catch { failed(record.request_id); }
        },
        async classificationRequest(body) {
          try {
            await writeFile(join(path, 'classification_req.json'), body, { mode: 0o600, flag: 'wx' });
          } catch { failed(record.request_id); }
        },
        originalOutputEvent,
        updatedOutputEvent: outputEventWriter('updated_output.json'),
        async updatedOutput(result) {
          try {
            await writeFile(join(path, 'updated_output.json'), result, { mode: 0o600, flag: 'wx' });
          } catch { failed(record.request_id); }
        },
        originalOutput,
        async compactedInput(body) {
          try {
            await writeFile(join(path, 'input_compacted.json'), body, { mode: 0o600, flag: 'wx' });
          } catch { failed(record.request_id); }
        },
        async updateInput(result) {
          try {
            await writeFile(join(path, 'update_input.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
          } catch { failed(record.request_id); }
        },
        async evaluation(result) {
          try {
            await writeFile(join(path, 'evaluate.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
          } catch { failed(record.request_id); }
        },
        async classification(result) {
          try {
            await writeFile(join(path, 'classification.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
          } catch { failed(record.request_id); }
        },
        push(chunk, contentType = 'application/json') {
          if (broken) return;
          try {
            collector ||= record.endpoint?.replace(/\/$/, '') === '/v1/messages' ? new MessagesOutputCollector(contentType) : new ChatOutputCollector(contentType);
            collector.push(chunk);
          } catch { broken = true; failed(record.request_id); }
        },
        async finish(finalRecord, usage, outputComplete) {
          try {
            originalCollector?.finish();
            if (originalCollector?.sse && !originalCollector.skipping && originalCollector.buffer.trim()) {
              originalCollector.parse(originalCollector.buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
            }
            await flushOriginal();
          } catch { failed(record.request_id); }
          for (const filename of streamFiles) {
            try { await appendFile(join(path, filename), ']'); }
            catch { failed(record.request_id); }
          }
          try {
            if (!broken) collector?.finish();
            await writeFile(join(path, 'metadata.json'), JSON.stringify({
              request_id: record.request_id, started_at: record.started_at,
              endpoint: record.endpoint, http_method: record.http_method,
              user_id: finalRecord.user_id ?? null, user_name: finalRecord.user_name ?? null,
              user_email: finalRecord.user_email ?? null,
              role_id: finalRecord.role_id ?? null, role_name: finalRecord.role_name ?? null,
              upstream_id: finalRecord.upstream_api_key_id ?? null, upstream_name: finalRecord.upstream_name ?? null,
              proxy_api_key_id: finalRecord.proxy_api_key_id ?? null, proxy_api_key_name: finalRecord.proxy_api_key_name ?? null,
              completed_at: new Date(), model: finalRecord.model_resolved || finalRecord.model_requested,
              classification_cache_hit: !!finalRecord.classification_cache_hit,
              stream: finalRecord.stream, http_status: finalRecord.http_status,
              request_status: finalRecord.request_status, error_code: finalRecord.error_code,
              output_complete: !!outputComplete && !broken && !collector?.truncated,
              output_truncated: collector?.truncated ?? false,
              output: broken ? null : collector?.output ?? null,
              usage: usage ?? null,
            }, null, 2), { mode: 0o600, flag: 'wx' });
          } catch { failed(record.request_id); }
        },
      };
    } catch {
      failed(record.request_id);
      return null;
    }
  };
}
