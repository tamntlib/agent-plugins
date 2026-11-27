#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGIN_DIR = path.join(REPO_ROOT, "plugins", "hermes-builtin-skills");
const MANIFEST_PATH = path.join(PLUGIN_DIR, "upstream-manifest.json");
const SKILLS_DEST = path.join(PLUGIN_DIR, "skills");
const LICENSE_DEST = path.join(PLUGIN_DIR, "LICENSE");

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const IGNORED_DIRS = new Set([
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
  ".git",
]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

function parseArgs(argv) {
  const opts = { sourceDir: null, checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-dir" && i + 1 < argv.length) {
      opts.sourceDir = path.resolve(argv[++i]);
    } else if (arg === "--check") {
      opts.checkOnly = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: node scripts/sync-hermes-builtin-skills.mjs [--source-dir DIR] [--check]"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function validateRelativePath(relPath, label) {
  if (typeof relPath !== "string" || !relPath.trim()) {
    throw new Error(`Invalid ${label}: must be a non-empty relative path`);
  }
  if (path.isAbsolute(relPath) || relPath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Unsafe ${label}: ${relPath}`);
  }
}

function shouldSkip(name, isDir) {
  if (isDir) return IGNORED_DIRS.has(name);
  return IGNORED_FILES.has(name) || name.endsWith(".pyc") || name.endsWith(".pyo");
}

function copyFilteredDir(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const isDir = entry.isDirectory();
    if (shouldSkip(entry.name, isDir)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (isDir) {
      copyFilteredDir(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
      const mode = fs.statSync(srcPath).mode & 0o777;
      fs.chmodSync(dstPath, mode);
    }
  }
}

function walkFiles(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, base, out);
    } else if (entry.isFile()) {
      out.push({
        rel: path.relative(base, full).split(path.sep).join("/"),
        full,
      });
    }
  }
  return out;
}

function hashPayload(skillsDir, licensePath, excludeTopLevel = new Set()) {
  const hash = crypto.createHash("sha256");
  if (fs.existsSync(licensePath) && fs.statSync(licensePath).isFile()) {
    hash.update("LICENSE\0");
    hash.update(fs.readFileSync(licensePath));
    hash.update("\0");
  }
  if (fs.existsSync(skillsDir)) {
    const topDirs = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => !e.isSymbolicLink() && e.isDirectory() && !excludeTopLevel.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dirEntry of topDirs) {
      const skillDir = path.join(skillsDir, dirEntry.name);
      for (const file of walkFiles(skillDir)) {
        hash.update(`skills/${dirEntry.name}/${file.rel}\0`);
        hash.update(fs.readFileSync(file.full));
        hash.update("\0");
      }
    }
  }
  return hash.digest("hex");
}

function verifyFlatSkills(skillsDir, expectedNames) {
  for (const name of expectedNames) {
    const skillDir = path.join(skillsDir, name);
    const skillMd = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      throw new Error(`Skill "${name}" is missing SKILL.md`);
    }
    const content = fs.readFileSync(skillMd, "utf8");
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm || !/^name\s*:/m.test(fm[1]) || !/^description\s*:/m.test(fm[1])) {
      throw new Error(`Skill "${name}" has invalid SKILL.md frontmatter`);
    }
    for (const file of walkFiles(skillDir)) {
      if (file.rel !== "SKILL.md" && path.posix.basename(file.rel) === "SKILL.md") {
        throw new Error(`Nested SKILL.md found in "${name}": ${file.rel}`);
      }
    }
  }
}

function sparseCheckoutUpstream(repoUrl, branch, pathsToCheckout) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skills-sync-"));
  try {
    execFileSync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        branch,
        "--single-branch",
        repoUrl,
        tmpDir,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    execFileSync("git", ["-C", tmpDir, "sparse-checkout", "set", "--no-cone", ...pathsToCheckout], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const commitSha = execFileSync("git", ["-C", tmpDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    return { tmpDir, commitSha };
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

function writeGithubOutput(pairs) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile) return;
  const lines = Object.entries(pairs).map(([k, v]) => `${k}=${v}`);
  fs.appendFileSync(outFile, `${lines.join("\n")}\n`, "utf8");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const upstream = manifest.upstream || {};
  const skills = Array.isArray(manifest.skills) ? manifest.skills : [];
  const localSkills = Array.isArray(manifest.localSkills) ? manifest.localSkills : [];

  if (!upstream.repo || !upstream.branch) {
    throw new Error("upstream-manifest.json must specify upstream.repo and upstream.branch");
  }
  if (skills.length === 0) {
    throw new Error("upstream-manifest.json must list at least one skill");
  }

  const localSkillSet = new Set();
  for (const name of localSkills) {
    if (!SKILL_NAME_RE.test(name || "")) {
      throw new Error(`Invalid localSkill name in manifest: ${name}`);
    }
    if (localSkillSet.has(name)) {
      throw new Error(`Duplicate localSkill name in manifest: ${name}`);
    }
    localSkillSet.add(name);
  }

  const seenNames = new Set();
  for (const item of skills) {
    if (!SKILL_NAME_RE.test(item.name || "")) {
      throw new Error(`Invalid skill name in manifest: ${item.name}`);
    }
    if (seenNames.has(item.name) || localSkillSet.has(item.name)) {
      throw new Error(`Duplicate or colliding skill name in manifest: ${item.name}`);
    }
    seenNames.add(item.name);
    validateRelativePath(item.source, `source for ${item.name}`);
  }
  if (upstream.licensePath) {
    validateRelativePath(upstream.licensePath, "upstream.licensePath");
  }

  const beforeHash = hashPayload(SKILLS_DEST, LICENSE_DEST, localSkillSet);
  let sourceRoot = opts.sourceDir;
  let commitSha = null;
  let cleanupDir = null;

  try {
    if (sourceRoot) {
      try {
        commitSha = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        commitSha = upstream.commitSha || "local";
      }
    } else {
      const sparsePaths = skills.map((s) => `/${s.source.replace(/^\/+/, "")}`);
      if (upstream.licensePath) {
        sparsePaths.push(`/${upstream.licensePath.replace(/^\/+/, "")}`);
      }
      const cloned = sparseCheckoutUpstream(upstream.repo, upstream.branch, sparsePaths);
      sourceRoot = cloned.tmpDir;
      commitSha = cloned.commitSha;
      cleanupDir = cloned.tmpDir;
    }

    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skills-stage-"));
    try {
      const stagedSkills = path.join(stagingRoot, "skills");
      const stagedLicense = path.join(stagingRoot, "LICENSE");
      fs.mkdirSync(stagedSkills, { recursive: true });

      if (upstream.licensePath) {
        const srcLicense = path.join(sourceRoot, upstream.licensePath);
        if (!fs.existsSync(srcLicense)) {
          throw new Error(`Upstream license not found: ${upstream.licensePath}`);
        }
        fs.copyFileSync(srcLicense, stagedLicense);
      }

      for (const item of skills) {
        const srcSkill = path.join(sourceRoot, item.source);
        if (!fs.existsSync(srcSkill) || !fs.statSync(srcSkill).isDirectory()) {
          throw new Error(`Upstream skill directory not found: ${item.source}`);
        }
        copyFilteredDir(srcSkill, path.join(stagedSkills, item.name));
      }

      verifyFlatSkills(
        stagedSkills,
        skills.map((s) => s.name)
      );
      if (localSkills.length > 0) {
        verifyFlatSkills(SKILLS_DEST, localSkills);
      }

      const afterHash = hashPayload(stagedSkills, stagedLicense);
      const contentChanged = beforeHash !== afterHash;
      const needsMetadataBootstrap = !upstream.commitSha;
      const changed = contentChanged || needsMetadataBootstrap;

      if (opts.checkOnly) {
        console.log(
          JSON.stringify({
            changed,
            contentChanged,
            commitSha,
            skillCount: skills.length,
            localSkillCount: localSkills.length,
          })
        );
        process.exit(changed ? 1 : 0);
      }

      if (changed) {
        fs.mkdirSync(SKILLS_DEST, { recursive: true });
        for (const entry of fs.readdirSync(SKILLS_DEST, { withFileTypes: true })) {
          if (localSkillSet.has(entry.name)) continue;
          fs.rmSync(path.join(SKILLS_DEST, entry.name), { recursive: true, force: true });
        }
        for (const item of skills) {
          copyFilteredDir(path.join(stagedSkills, item.name), path.join(SKILLS_DEST, item.name));
        }
        if (fs.existsSync(stagedLicense)) {
          fs.copyFileSync(stagedLicense, LICENSE_DEST);
        }
        const nextManifest = {
          ...manifest,
          upstream: {
            ...upstream,
            commitSha,
          },
        };
        fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
      }

      writeGithubOutput({
        changed: String(changed),
        commit_sha: commitSha || "",
        skill_count: String(skills.length),
      });

      console.log(
        changed
          ? `Synced ${skills.length} upstream skills (+${localSkills.length} local preserved) from ${upstream.repo}@${String(commitSha).slice(0, 12)}`
          : `No skill content changes detected (upstream HEAD ${String(commitSha).slice(0, 12)})`
      );
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  } finally {
    if (cleanupDir) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
  }
}

main();
