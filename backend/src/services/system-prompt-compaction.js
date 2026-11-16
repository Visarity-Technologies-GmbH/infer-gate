import { fail } from '../errors.js';

export const compactionOptions = ['removeComments', 'minifyJson', 'compactLists', 'cleanWhitespace', 'collapseNewlines'];

export function validateCompaction(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.entries(options).some(([key, value]) => !compactionOptions.includes(key) || typeof value !== 'boolean'))
    fail(400, 'invalid_input', 'Supply a system_prompt_compaction object with supported boolean options');
  return JSON.stringify(options);
}

function minifyJson(source) {
  try { JSON.parse(source); } catch { return source; }
  // Preserve every lexeme, including duplicate keys, escapes and large integers.
  return source.replace(/"(?:[^"\\]|\\.)*"|[ \t\r\n]+/g, token => token.startsWith('"') ? token : '');
}

function compactListIndent(value) {
  // Dedent only standalone, flat list paragraphs with a uniform margin.
  // Nested items and wrapped lines depend on the original marker columns.
  return value.split('\n\n').map(paragraph => {
    const lines = paragraph.split('\n');
    const indent = /^( {1,3})(?=[-+*] |\d{1,9}[.)] )/.exec(lines[0])?.[1];
    if (!indent || !lines.every(line => line.startsWith(indent) &&
        /^(?:[-+*]|\d{1,9}[.)]) /.test(line.slice(indent.length)))) return paragraph;
    return lines.map(line => line.slice(indent.length)).join('\n');
  }).join('\n\n');
}

export function compactText(text, options) {
  // Remove comments first so any newly adjacent whitespace is cleaned together.
  if (options.removeComments && Object.values(options).filter(Boolean).length > 1) {
    const stripped = compactText(text, { removeComments: true });
    return compactText(stripped, { ...options, removeComments: false });
  }
  // Scan protected regions before rewriting prose. An unfinished literal protects
  // the remaining text, since its intended boundary is ambiguous.
  const tokens = /^ {0,3}(?:`{3,}|~{3,})[^\r\n]*|^(?: {4}|\t| {0,3}>)[^\r\n]*|^[^\r\n|]*\|[^\r\n]*|<!--|`+/gm;
  let cursor = 0;
  const chunks = [];
  function prose(start, end) {
    let value = text.slice(start, end);
    // Recognize indentation only at actual line starts, not after inline code.
    const startOfLine = start === 0 || /[\r\n]/.test(text[start - 1]);
    value = value.replace(/^[^\r\n]+/gm, (line, offset) => {
      const atStart = offset > 0 || startOfLine;
      const prefix = atStart ? line.match(/^[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?/)[0] : '';
      const marker = options.compactLists ? prefix.replace(/(\S) {2,4}$/, '$1 ') : prefix;
      const rest = line.slice(prefix.length);
      if (!options.cleanWhitespace) return marker + rest;
      return marker + rest.replace(/[ \t]+/g, (spaces, index) => {
        const next = start + offset + prefix.length + index + spaces.length;
        return next === text.length || /[\r\n]/.test(text[next]) ? spaces : ' ';
      });
    });
    if (options.compactLists && start === 0 && end === text.length) value = compactListIndent(value);
    return options.collapseNewlines ? value.replace(/(\r\n|\n)(?:\1){2,}/g, '$1$1') : value;
  }
  let match;
  while ((match = tokens.exec(text))) {
    chunks.push(prose(cursor, match.index));
    const token = match[0];
    const fence = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(token);
    const lineStart = match.index === 0 || /[\r\n]/.test(text[match.index - 1]);
    let replacement;
    if (fence && lineStart) {
      const [marker, info] = fence.slice(1);
      const close = new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}[ \\t]*$', 'gm');
      close.lastIndex = tokens.lastIndex + 1;
      const end = close.exec(text);
      if (end && options.minifyJson && info.trim().toLowerCase() === 'json') {
        const source = text.slice(tokens.lastIndex, end.index);
        const compact = minifyJson(source);
        if (compact !== source) {
          const newline = source.startsWith('\r\n') ? '\r\n' : '\n';
          replacement = token + newline + compact + newline + end[0];
        }
      }
      tokens.lastIndex = end ? close.lastIndex : text.length;
    } else if (token === '<!--') {
      const end = text.indexOf('-->', tokens.lastIndex);
      tokens.lastIndex = end < 0 ? text.length : end + 3;
      if (end >= 0 && options.removeComments) {
        const before = text[match.index - 1], after = text[tokens.lastIndex];
        replacement = before && after && !/\s/.test(before + after) ? ' ' : '';
      }
    } else if (/^`+$/.test(token)) {
      const runs = /`+/g;
      runs.lastIndex = tokens.lastIndex;
      let end;
      while ((end = runs.exec(text)) && end[0].length !== token.length) {}
      tokens.lastIndex = end ? runs.lastIndex : text.length;
    }
    cursor = tokens.lastIndex;
    chunks.push(replacement ?? text.slice(match.index, cursor));
  }
  chunks.push(prose(cursor, text.length));
  const result = chunks.join('');
  return result.trim() ? result : text;
}

export function compactSystemBody(body, protocol, options) {
  if (!body?.length || !options || !Object.values(options).some(Boolean)) return body;
  // Retain numeric literals in unrelated fields when reserializing a changed body.
  const input = JSON.parse(body, (_key, value, context) =>
    typeof value === 'number' ? JSON.rawJSON(context.source) : value);
  let changed = false;
  function rewrite(object, key) {
    if (typeof object?.[key] !== 'string') return;
    const value = compactText(object[key], options);
    if (value !== object[key]) { object[key] = value; changed = true; }
  }
  function content(object, key, partType) {
    if (Array.isArray(object?.[key])) {
      for (const part of object[key]) if (part?.type === partType) rewrite(part, 'text');
    } else rewrite(object, key);
  }
  if (protocol === 'ANTHROPIC') content(input, 'system', 'text');
  else {
    const responses = protocol === 'OPENAI_RESPONSES';
    if (responses) rewrite(input, 'instructions');
    const messages = responses ? input?.input : input?.messages;
    if (Array.isArray(messages)) for (const message of messages) {
      if (message?.role === 'system' && (!responses || message.type === undefined || message.type === 'message'))
        content(message, 'content', responses ? 'input_text' : 'text');
    }
  }
  return changed ? Buffer.from(JSON.stringify(input)) : body;
}
