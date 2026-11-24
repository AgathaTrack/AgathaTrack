/**
 * Markdown link + in-file heading anchor validation for validate_docs.sh.
 * Resolves repo-root (/path), relative (./ ../), and file-relative paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;
const EXTERNAL_RE = /^(?:https?:|ftp:|mailto:)/i;
const PLACEHOLDER_TARGET_RE = /^\[?\^|^[a-z]*path$/i;

function normalizeAnchorCompare(anchor) {
  return anchor.toLowerCase().replace(/-+/g, '-');
}

function looseAnchorMatch(want, candidate) {
  const compact = (s) => s.toLowerCase().replace(/[_=-]+/g, '');
  return compact(want) === compact(candidate);
}

function isSkippableTarget(rawTarget) {
  const target = rawTarget.trim();
  if (PLACEHOLDER_TARGET_RE.test(target)) {
    return true;
  }
  if (target.includes('[^') || target.includes('(*') || target.includes('\\')) {
    return true;
  }
  if (/['"]/.test(target) && !target.includes('/')) {
    return true;
  }
  return false;
}

export function headingAnchorSlug(text) {
  return text
    .replace(/^#+\s*/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[<>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s*\u2014\s*/g, '--')
    .replace(/\s*\u2013\s*/g, '-')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{3,}/g, '--');
}

export function collectHeadingAnchors(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const counts = new Map();
  const anchors = new Set();
  for (const line of content.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) {
      let slug = headingAnchorSlug(m[1]);
      const seen = counts.get(slug) || 0;
      if (seen > 0) {
        slug = `${slug}-${seen}`;
      }
      counts.set(headingAnchorSlug(m[1]), seen + 1);
      anchors.add(slug);
    }
  }
  return anchors;
}

/** Remove inline backtick spans so example syntax is not treated as links. */
export function stripInlineCode(line) {
  return line.replace(/`+[^`]*`+/g, '');
}

export function extractMarkdownLinks(line) {
  const links = [];
  let match;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(line)) !== null) {
    const full = match[0];
    const target = match[1];
    const label = full.slice(1, full.indexOf(']('));
    links.push({ full, label, target });
  }
  return links;
}

export function resolveLinkTarget(repoRoot, sourceFile, rawTarget) {
  const target = rawTarget.trim().replace(/^<(.+)>$/, '$1');
  const hashIdx = target.indexOf('#');
  const pathPart = hashIdx === -1 ? target : target.slice(0, hashIdx);
  const anchor = hashIdx === -1 ? '' : target.slice(hashIdx + 1);

  if (!pathPart && anchor) {
    return { absPath: sourceFile, anchor, isDir: false };
  }

  let absPath;
  if (pathPart.startsWith('/')) {
    absPath = path.join(repoRoot, pathPart.slice(1));
  } else if (pathPart.startsWith('./') || pathPart.startsWith('../')) {
    absPath = path.resolve(path.dirname(sourceFile), pathPart);
  } else if (pathPart) {
    absPath = path.resolve(path.dirname(sourceFile), pathPart);
  } else {
    absPath = sourceFile;
  }

  return { absPath, anchor, isDir: pathPart.endsWith('/') };
}

function targetExists(absPath, isDir) {
  if (isDir) {
    return fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
  }
  if (fs.existsSync(absPath)) {
    const st = fs.statSync(absPath);
    return st.isFile() || st.isDirectory();
  }
  if (fs.existsSync(`${absPath}.md`)) {
    return true;
  }
  return false;
}

// Legacy fallback: a bare `docs/…` path may resolve from the repo root. Relative `./` and `../` targets
// resolve only from their source file; a dead relative link must fail, never match another file.
function fallbackCandidatePaths(repoRoot, pathPart) {
  if (pathPart.startsWith('docs/')) {
    return [path.join(repoRoot, pathPart)];
  }
  return [];
}

function resolveExistingPath(repoRoot, sourceFile, pathPart, isDir) {
  const { absPath } = resolveLinkTarget(repoRoot, sourceFile, isDir ? `${pathPart}/` : pathPart);
  if (targetExists(absPath, isDir)) {
    return absPath;
  }
  for (const candidate of fallbackCandidatePaths(repoRoot, pathPart)) {
    if (targetExists(candidate, isDir)) {
      return candidate;
    }
  }
  return absPath;
}

export function validateLink(repoRoot, sourceFile, rawTarget) {
  if (EXTERNAL_RE.test(rawTarget.trim()) || isSkippableTarget(rawTarget)) {
    return null;
  }
  if (/^\/legal\//i.test(rawTarget.trim().split('#')[0])) {
    return null;
  }
  const hashIdx = rawTarget.trim().indexOf('#');
  const pathPart = hashIdx === -1 ? rawTarget.trim() : rawTarget.trim().slice(0, hashIdx);
  const anchor = hashIdx === -1 ? '' : rawTarget.trim().slice(hashIdx + 1);
  const isDir = pathPart.endsWith('/');
  const absPath = resolveExistingPath(repoRoot, sourceFile, pathPart.replace(/\/$/, ''), isDir);
  if (!targetExists(absPath, isDir)) {
    return `missing target ${rawTarget} (resolved ${absPath})`;
  }
  if (anchor) {
    const anchorFile = fs.statSync(absPath).isDirectory()
      ? path.join(absPath, 'README.md')
      : fs.existsSync(absPath)
        ? absPath
        : `${absPath}.md`;
    const checkPath = fs.existsSync(anchorFile)
      ? anchorFile
      : fs.existsSync(`${absPath}.md`)
        ? `${absPath}.md`
        : absPath;
    if (!fs.existsSync(checkPath) || fs.statSync(checkPath).isDirectory()) {
      return `anchor #${anchor} in missing file for ${rawTarget}`;
    }
    const anchors = collectHeadingAnchors(checkPath);
    const want = anchor.toLowerCase();
  const normalizedAnchors = new Set([...anchors].map((a) => a.toLowerCase()));
  const normalizedWant = normalizeAnchorCompare(want);
  const fuzzy = [...normalizedAnchors].some(
      (a) =>
        normalizeAnchorCompare(a) === normalizedWant || looseAnchorMatch(want, a),
    );
    if (!normalizedAnchors.has(want) && !fuzzy) {
      return `missing heading anchor #${anchor} in ${path.relative(repoRoot, checkPath)}`;
    }
  }
  return null;
}

export function findMarkdownFiles(repoRoot) {
  // regulatory/ holds legal-notice templates whose link text is placeholder (for example `(link-to-privacy-notice)`);
  // it is an intentional exclusion, covered by a fixture test.
  const skip = new Set(['.git', 'node_modules', 'artifacts', 'regulatory']);
  const results = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.github') {
          continue;
        }
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        results.push(full);
      }
    }
  }
  walk(repoRoot);
  return results;
}

/** @returns {Array<{ file: string, link: string, reason: string }>} */
export function validateRepoMarkdownLinks(repoRoot) {
  const issues = [];
  for (const file of findMarkdownFiles(repoRoot)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      const links = extractMarkdownLinks(stripInlineCode(line));
      for (const { full, target } of links) {
        const err = validateLink(repoRoot, file, target);
        if (err) {
          issues.push({ file, link: full, reason: err });
        }
      }
    }
  }
  return issues;
}

function main() {
  const repoRoot = process.argv[2] || process.cwd();
  const issues = validateRepoMarkdownLinks(path.resolve(repoRoot));
  for (const { file, link, reason } of issues) {
    console.log(`  Broken link in ${file}: ${link} (${reason})`);
  }
  if (issues.length > 0) {
    console.log(`  Found ${issues.length} broken links`);
    process.exit(1);
  }
  console.log('  All links are valid');
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === selfPath) {
  main();
}