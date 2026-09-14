import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("../../scripts/live.ts", import.meta.url));
const jiti = fileURLToPath(new URL("../../node_modules/jiti/lib/jiti-cli.mjs", import.meta.url));
const temporaryDirectories: string[] = [];
const childReport = `console.log('LAUNCH_REPORT=' + JSON.stringify({
  args: process.argv.slice(2),
  node: process.execPath,
  mode: process.env.NODE_ENV,
  viewerMode: process.env.CODEX_VIEWER_MODE,
  host: process.env.HOST,
  nitroHost: process.env.NITRO_HOST,
  port: process.env.PORT,
  nitroPort: process.env.NITRO_PORT,
  socket: process.env.NITRO_UNIX_SOCKET,
  codexHome: process.env.CODEX_VIEWER_CODEX_HOME,
  mediaRoots: JSON.parse(process.env.CODEX_VIEWER_MEDIA_ROOTS || 'null')
}));`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "viewer-launcher-"));
  temporaryDirectories.push(root);
  const codexHome = join(root, "Codex home");
  await mkdir(codexHome);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCALAPPDATA: root,
    XDG_CONFIG_HOME: root,
    XDG_CACHE_HOME: root,
    HOST: "0.0.0.0",
    NITRO_HOST: "0.0.0.0",
    PORT: "9000",
    NITRO_PORT: "9001",
    NITRO_UNIX_SOCKET: join(root, "unwanted.socket"),
  };
  delete env["CODEX_VIEWER_BUILD_OUTPUT"];
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const childEnvironment = { ...env };
    for (const [key, value] of Object.entries(overrides)) {
      // Windows execFile keeps only one case-insensitive spelling. PNPM may supply NPM_EXECPATH.
      for (const inherited of Object.keys(childEnvironment)) {
        if (inherited.toLowerCase() === key.toLowerCase()) {
          delete childEnvironment[inherited];
        }
      }
      childEnvironment[key] = value;
    }
    return execute(process.execPath, [jiti, launcher, "--codex-home", codexHome, ...args], {
      cwd: root,
      env: childEnvironment,
      timeout: 15_000,
      windowsHide: true,
    });
  };
  return { root, codexHome, run };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("live launcher", () => {
  it.each([undefined, "custom build"])(
    "runs the production entrypoint with loopback and CLI overrides (%s)",
    async (buildOutput) => {
      const { root, codexHome, run } = await fixture();
      const serverDirectory = join(root, buildOutput ?? ".output-live", "server");
      await mkdir(serverDirectory, { recursive: true });
      await writeFile(join(serverDirectory, "index.mjs"), childReport);
      const mediaRoots = [join(root, "Media one"), join(root, "Media two")];
      const { stdout } = await run(
        ["-p", "4123", "--media-root", mediaRoots[0]!, `--media-root=${mediaRoots[1]}`],
        buildOutput === undefined ? {} : { CODEX_VIEWER_BUILD_OUTPUT: buildOutput },
      );
      const report = JSON.parse(stdout.split("LAUNCH_REPORT=")[1]!.trim()) as unknown;
      expect(report).toEqual({
        args: [],
        node: process.execPath,
        mode: "production",
        viewerMode: "live",
        host: "127.0.0.1",
        nitroHost: "127.0.0.1",
        port: "4123",
        nitroPort: "4123",
        socket: "",
        codexHome,
        mediaRoots,
      });
    },
  );

  it("reports an absent build with the build and development commands", async () => {
    const { run } = await fixture();
    await expect(run([])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        /production build is missing.*pnpm build.*pnpm live.*pnpm dev/s,
      ),
    });
  });

  it("starts Nuxt only with the explicit development switch", async () => {
    const { root, codexHome, run } = await fixture();
    const pnpm = join(root, "pnpm fixture.mjs");
    await writeFile(pnpm, childReport);
    const { stdout } = await run(["--dev", "--port=4124"], { npm_execpath: pnpm });
    const report = JSON.parse(stdout.split("LAUNCH_REPORT=")[1]!.trim()) as unknown;
    expect(report).toMatchObject({
      args: ["exec", "nuxt", "dev", "--host", "127.0.0.1", "--port", "4124"],
      mode: "development",
      viewerMode: "live",
      codexHome,
    });
  });

  it("surfaces production child failures", async () => {
    const { root, run } = await fixture();
    const serverDirectory = join(root, ".output-live", "server");
    await mkdir(serverDirectory, { recursive: true });
    await writeFile(join(serverDirectory, "index.mjs"), "process.exitCode = 7;");
    await expect(run([])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Nuxt live server stopped with exit code 7"),
    });
  });
});
