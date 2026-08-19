/**
 * Paths whose *content* the extension refuses to copy anywhere.
 *
 * Capture duplicates file content by design: a baseline snapshot holds the
 * pre-change version of every tracked file, and the event log holds the text of
 * each edit. For a credentials file that is a second copy of the secret, sitting
 * in a directory the workspace hides from `git status` — quiet enough that
 * nobody would think to look. So the exclusion belongs here, at the capture
 * layer, and not at the review layer: skipping a review advances a baseline,
 * which means the content was already written down by then.
 *
 * The rule is content-only. An edit to a matching file is still recorded as an
 * occurrence, so the fact that an agent touched it is never hidden — only the
 * text is withheld. A file with no baseline has no review debt, so these are
 * not offered for retyping either; typing a secret back in was never the point.
 *
 * Not configurable, and biased toward withholding: a false positive costs one
 * file being un-reviewable, a false negative writes somebody's private key to
 * disk. The one place that bias is tempered is the secret/credential name rule,
 * which applies only to data and config files — `secrets.json` holds secrets,
 * while `src/secrets.ts` is code that reads them and is exactly the kind of file
 * worth reviewing.
 *
 * `hook/copyworkcode-hook.js` re-implements these patterns in plain JS because
 * it runs as a standalone script — the two lists must stay in sync.
 */

/** Key material and credential stores, whatever they sit next to. */
const SENSITIVE_NAMES: RegExp[] = [
  /^\.env(\.|$)/, // .env, .env.local
  /\.env$/, // staging.env
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^\.(npmrc|netrc|pgpass|htpasswd)$/,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|kdbx)$/,
];

/** Sensitive in a data or config file, unremarkable in a source file. */
const SENSITIVE_DATA_NAMES: RegExp[] = [
  /(^|[._-])secrets?([._-]|$)/,
  /(^|[._-])credentials?([._-]|$)/,
];

/** Extensions that hold data rather than code. '' covers extensionless files. */
const DATA_EXTENSIONS = new Set([
  '',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'ini',
  'toml',
  'cfg',
  'conf',
  'config',
  'properties',
  'txt',
  'xml',
  'csv',
  'tfvars',
  'plist',
  'enc',
]);

/** Matched against every directory along the path. */
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.gcloud', '.azure']);

/**
 * True when nothing from this path may be copied. Takes a workspace-relative
 * path; separators may be either kind.
 */
export function isSensitivePath(relativePath: string): boolean {
  const segments = relativePath.toLowerCase().split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return false;

  const name = segments[segments.length - 1];
  if (SENSITIVE_NAMES.some((pattern) => pattern.test(name))) return true;
  if (
    DATA_EXTENSIONS.has(extensionOf(name)) &&
    SENSITIVE_DATA_NAMES.some((pattern) => pattern.test(name))
  ) {
    return true;
  }
  return segments.slice(0, -1).some((segment) => SENSITIVE_DIRS.has(segment));
}

/** '' for an extensionless name, and for a dotfile like `.secrets`. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1);
}
