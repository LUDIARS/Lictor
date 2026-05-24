import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startSidecar, type SidecarContext, type TitleState } from "./sidecar.js";
import { gatherBaseMeta, type Meta } from "./meta.js";
import { resetTitle, setTitle } from "./osc.js";
import { ConcordiaClient, loadConcordiaConfig, type LivenessHandle } from "./concordia.js";
import { gatherRepoStat } from "./stat.js";
import { buildAutoTitle } from "./auto-title.js";
import { renderSkillMd, SkillInjector } from "./skill-injector.js";
import { findRepoMemories, memoryDirForCwd, renderMemoryDigest, repoLeafFromCwd } from "./memory-loader.js";

const STAT_INTERVAL_MS = 10 * 60 * 1000;

export async function runWrapped(args: string[]): Promise<void> {
  const meta = gatherBaseMeta();

  // Concordia registration — best-effort. A failure here downgrades to v0.0
  // behavior (no persona, no auto-stat, no liveness) but does NOT block the
  // wrapped claude from starting.
  const concordia = await tryRegisterConcordia(meta);

  if (concordia) {
    meta.session_id = concordia.id;
    meta.persona = concordia.persona;
    meta.role_label = concordia.roleLabel;
  }

  const titleState: TitleState = { manualOverride: null };

  // Skill injection — pre-spawn writes go to <root>/.claude/skills/, and we
  // pass <root> to claude via --add-dir so it's scanned at boot. Mid-session
  // overwrites of existing SKILL.md files reload live via claude's watcher.
  const sessionIdForSkills = concordia?.id ?? `lictor-${randomUUID()}`;
  const injector = new SkillInjector(sessionIdForSkills);
  seedSkills(injector, meta);

  const ctx: SidecarContext = {
    meta,
    titleState,
    concordia: concordia?.client ?? null,
    sessionId: concordia?.id ?? null,
    roleLabel: meta.role_label,
    injector,
  };

  const sidecar = await startSidecar(ctx);

  // Initial auto title — only if not manually set later via /v1/title.
  applyAutoTitle(ctx, gatherRepoStat(meta.cwd));

  // Periodic stat polling — only when Concordia is reachable.
  const statTimer = concordia
    ? setInterval(() => pushStat(ctx).catch(() => {}), STAT_INTERVAL_MS)
    : null;
  statTimer?.unref?.();
  // Send first stat immediately so dashboards aren't blank for 10 minutes.
  if (concordia) pushStat(ctx).catch(() => {});

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LICTOR_PORT: String(sidecar.port),
    LICTOR_PID: String(process.pid),
    LICTOR_SESSION_START: meta.start_iso,
  };
  if (concordia) {
    env.LICTOR_SESSION_ID = concordia.id;
    env.CONCORDIA_SESSION_ID = concordia.id;
    if (meta.persona?.name) env.LICTOR_PERSONA_NAME = String(meta.persona.name);
    if (meta.role_label) env.LICTOR_ROLE_LABEL = meta.role_label;
  }

  const useShell = process.platform === "win32";
  // Prepend --add-dir <sessionDir> so claude scans our injected skill dir.
  const claudeArgs = ["--add-dir", injector.sessionDir, ...args];
  const child = spawn("claude", claudeArgs, { stdio: "inherit", env, shell: useShell });

  let childExited = false;
  const cleanup = async () => {
    if (statTimer) clearInterval(statTimer);
    concordia?.liveness.close();
    sidecar.close();
    resetTitle();
    injector.cleanup();
    if (concordia) {
      try {
        await concordia.client.unregister(concordia.id);
      } catch {
        // best-effort
      }
    }
  };

  child.on("exit", (code, signal) => {
    childExited = true;
    void cleanup().finally(() => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
  });

  child.on("error", (err) => {
    process.stderr.write(`lictor: failed to spawn claude: ${err.message}\n`);
    void cleanup().finally(() => process.exit(127));
  });

  const forward = (sig: NodeJS.Signals) => () => {
    if (!childExited) child.kill(sig);
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  if (process.platform !== "win32") {
    process.on("SIGHUP", forward("SIGHUP"));
  }
}

interface ConcordiaSlot {
  client: ConcordiaClient;
  id: string;
  persona: Meta["persona"];
  roleLabel: string | null;
  liveness: LivenessHandle;
}

async function tryRegisterConcordia(meta: Meta): Promise<ConcordiaSlot | null> {
  const cfg = loadConcordiaConfig();
  if (!cfg.enabled) return null;
  const client = new ConcordiaClient(cfg);
  const id = `lictor-${randomUUID()}`;
  try {
    const stat0 = gatherRepoStat(meta.cwd);
    const registered = await client.register({
      id,
      provider: "claude-code",
      repo_path: meta.cwd,
      host: meta.hostname,
      branch: stat0.branch ?? undefined,
      metadata: {
        lictor_pid: meta.lictor_pid,
        parent_pid: meta.parent_pid,
        wt_session: meta.wt_session,
        start_iso: meta.start_iso,
        platform: meta.platform,
        wrapped_by: "lictor",
      },
    });
    const liveness = client.openLiveness(id);
    return {
      client,
      id: registered.id,
      persona: registered.persona,
      roleLabel: registered.roleLabel,
      liveness,
    };
  } catch (err) {
    process.stderr.write(
      `lictor: Concordia registration failed (${(err as Error).message}); ` +
        `continuing without coordinator integration.\n`,
    );
    return null;
  }
}

export function applyAutoTitle(ctx: SidecarContext, stat: ReturnType<typeof gatherRepoStat>): void {
  if (ctx.titleState.manualOverride !== null) return;
  const title = buildAutoTitle({
    persona: ctx.meta.persona,
    roleLabel: ctx.roleLabel,
    stat,
    cwd: ctx.meta.cwd,
  });
  if (title) setTitle(title);
}

/**
 * Pre-spawn skill seeding. Writes:
 *   - lictor-persona   : Concordia's persona.skill_template (if assigned)
 *   - lictor-session-context : repo-relevant memories scraped from
 *                              ~/.claude/projects/<cwd-key>/memory/
 *
 * Both are best-effort — failures log to stderr but don't block startup.
 */
function seedSkills(injector: SkillInjector, meta: Meta): void {
  // Persona skill
  const persona = meta.persona as Record<string, unknown> | null;
  const skillTemplate = persona && typeof persona.skill_template === "string"
    ? persona.skill_template
    : null;
  if (skillTemplate) {
    const display = (persona?.display_name as string | undefined) ?? "";
    const role = (persona?.name as string | undefined) ?? "persona";
    const description = display
      ? `Concordia-assigned persona for this session (${role} / ${display})`
      : `Concordia-assigned persona for this session (${role})`;
    try {
      injector.writeSkill(
        "lictor-persona",
        renderSkillMd({ name: "lictor-persona", description, body: skillTemplate }),
      );
    } catch (err) {
      process.stderr.write(`lictor: skill seed (persona) failed: ${(err as Error).message}\n`);
    }
  }

  // Session-context skill from memories
  try {
    const memDir = memoryDirForCwd(meta.cwd);
    const repoLeaf = repoLeafFromCwd(meta.cwd);
    const matches = findRepoMemories(memDir, repoLeaf, 3);
    if (matches.length > 0) {
      const body = renderMemoryDigest(matches);
      injector.writeSkill(
        "lictor-session-context",
        renderSkillMd({
          name: "lictor-session-context",
          description: `Repo-relevant memory matches for ${repoLeaf} (lictor-scoped, this session only)`,
          body,
        }),
      );
    }
  } catch (err) {
    process.stderr.write(`lictor: skill seed (memory) failed: ${(err as Error).message}\n`);
  }
}

async function pushStat(ctx: SidecarContext): Promise<void> {
  if (!ctx.concordia || !ctx.sessionId) return;
  const stat = gatherRepoStat(ctx.meta.cwd);
  applyAutoTitle(ctx, stat); // auto-refresh title each cycle in case branch changed
  await ctx.concordia.stat(ctx.sessionId, stat);
}
