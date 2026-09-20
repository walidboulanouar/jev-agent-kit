// Safe file reads for the MCP server. An agent supplies the path, so this must
// not become a way to send secrets to a third party. Only files inside the
// working directory (or JEV_ROOT) are readable, secret-looking names are
// refused, and size is capped. The CLI's --file flag is not restricted, because
// a human typed it.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { homedir } from 'node:os';
import { JevError } from './client.js';

// Only plain text and log-like files can be read. Dotfiles and dot-folders are refused
// outright (.env, .ssh, .git, .config), and so is anything with a secret-looking name.
const ALLOWED_EXT = new Set(['.log', '.txt', '.md', '.csv', '.tsv', '.out', '.err', '.jsonl', '.json', '.xml', '.html', '.diff', '.patch', '']);
const SECRET_NAME = /(secret|credential|passw(or)?d|private[-_]?key|service[-_]?account|api[-_]?key|apikey|^token(\.|$)|[-_.]token\.|^key$|\.env|id_(rsa|dsa|ecdsa|ed25519)|\.pem$|\.p12$|\.pfx$|\.kdbx$)/i;
const MAX_BYTES = 5_000_000;

export function readTextFile(p, { root = process.env.JEV_ROOT || process.cwd(), maxBytes = MAX_BYTES } = {}) {
  if (typeof p !== 'string' || !p) throw new JevError('path must be a non-empty string', { code: 'bad_input' });
  let real;
  let realRoot;
  // reject escapes before touching the disk, so the message is always the same
  const lexical = relative(resolve(root), resolve(root, p));
  if (lexical.startsWith('..') || isAbsolute(lexical)) {
    throw new JevError('path must be inside the working directory', { code: 'bad_input' });
  }
  try {
    realRoot = realpathSync(root);
    real = realpathSync(resolve(realRoot, p));
  } catch {
    throw new JevError(`cannot read file ${p}`, { code: 'bad_input' });
  }
  const rel = relative(realRoot, real);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new JevError('path must be inside the working directory', { code: 'bad_input' });
  }
  if (realRoot === realpathSync(homedir())) {
    throw new JevError('refusing to serve files from the home directory. Start the server in a project folder or set JEV_ROOT.', { code: 'bad_input' });
  }
  for (const part of rel.split(sep)) {
    if (part.startsWith('.') || SECRET_NAME.test(part)) {
      throw new JevError(`refusing to read a file that looks like it holds secrets: ${part}`, { code: 'bad_input' });
    }
  }
  if (!ALLOWED_EXT.has(extname(rel).toLowerCase())) {
    throw new JevError(`only text and log files can be read (got ${extname(rel) || 'no extension'})`, { code: 'bad_input' });
  }
  const st = statSync(real);
  if (!st.isFile()) throw new JevError(`not a file: ${p}`, { code: 'bad_input' });
  if (st.nlink > 1) throw new JevError('refusing to read a file with several hard links', { code: 'bad_input' });
  if (st.size > maxBytes) throw new JevError(`file is larger than ${maxBytes} bytes`, { code: 'bad_input' });
  return readFileSync(real, 'utf8');
}

// Split text into lines. Handles CRLF and drops one trailing empty line.
export function splitLines(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
