import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHindsightProfile } from "../src/profile.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-hindsight-prof-"));
}

test("delegates to sibling agent-profiles CLI and respects fail-closed unknown profile", () => {
  const tmp = makeTempDir();
  try {
    const workDir = path.join(tmp, "work", "svc");
    fs.mkdirSync(workDir, { recursive: true });
    const apConfigPath = path.join(tmp, "ap-config.json");
    fs.writeFileSync(
      apConfigPath,
      JSON.stringify({
        version: 1,
        defaultProfile: "default",
        envVars: ["AGENT_PROFILE"],
        markerFiles: [".agent-profile"],
        strictUnknownProfile: true,
        profiles: {
          default: { paths: [], env: { AGENT_PROFILE: "default" } },
          work: { paths: [path.join(tmp, "work")], env: { AGENT_PROFILE: "work" } },
        },
      }),
      "utf8"
    );

    const okWork = resolveHindsightProfile(
      { cwd: workDir },
      { env: { AGENT_PROFILES_CONFIG: apConfigPath } }
    );
    assert.equal(okWork.valid, true);
    assert.equal(okWork.profile, "work");
    assert.equal(okWork.managedByAgentProfiles, true);

    const failClosed = resolveHindsightProfile(
      { cwd: workDir },
      { env: { AGENT_PROFILES_CONFIG: apConfigPath, AGENT_PROFILE: "nonexistent" } }
    );
    assert.equal(failClosed.valid, false);
    assert.equal(failClosed.profile, null);
    assert.equal(failClosed.managedByAgentProfiles, true);

    // Broken/unparseable agent-profiles CLI fails closed instead of falling back to default
    const brokenCli = path.join(tmp, "broken-ap.mjs");
    fs.writeFileSync(brokenCli, "process.stdout.write('not-json'); process.exit(1);\n", "utf8");
    const brokenRes = resolveHindsightProfile(
      { cwd: workDir },
      { agentProfilesCli: brokenCli, env: {} }
    );
    assert.equal(brokenRes.valid, false);
    assert.equal(brokenRes.profile, null);
    assert.equal(brokenRes.managedByAgentProfiles, true);
    assert.match(brokenRes.error, /fail-closed/i);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("works standalone without agent-profiles using AGENT_PROFILE -> default", () => {
  const fromDefault = resolveHindsightProfile({}, { disableAgentProfiles: true, env: {} });
  assert.equal(fromDefault.valid, true);
  assert.equal(fromDefault.profile, "default");
  assert.equal(fromDefault.managedByAgentProfiles, false);

  const fromEnv = resolveHindsightProfile(
    {},
    { disableAgentProfiles: true, env: { AGENT_PROFILE: "work" } }
  );
  assert.equal(fromEnv.valid, true);
  assert.equal(fromEnv.profile, "work");

  const badEnv = resolveHindsightProfile(
    {},
    { disableAgentProfiles: true, env: { AGENT_PROFILE: "../escape" } }
  );
  assert.equal(badEnv.valid, false);
});
