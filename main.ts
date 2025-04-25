#!/usr/bin/env -S pkgx +node@20 npx ts-node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { writeFile, unlink, mkdir } from "fs/promises";
import { execSync } from "child_process";
import { platform, tmpdir } from "os";
import { spawn } from "child_process";
import { join } from "path";
import { z } from "zod";

const tmp = join(tmpdir(), "pkgx-mcp");

const server = new McpServer({
  name: "pkgx-mcp",
  version: "0.1.0",
});

// Check if running as root
function checkNotRoot(): void {
  if (process.getuid && process.getuid() === 0) {
    console.error("lol u wot mate? running as root is not allowed.");
    process.exit(1);
  }
}

// Execute pkgx command in sandbox
async function runPkgxCommand(program: string, args: string[], cwd?: string): Promise<CallToolResult> {
  let cmd = await get_pkgx();
  args = [program, ...args];

  let sandboxProfilePath = "";
  if (platform() === "darwin") {
    //TODO do the sandbox *after* pkgx so it can have zero writes anywhere
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const SANDBOX_PROFILE = `
    (version 1)
    (allow default)
    (deny file-write*)
    (allow file-write*
      (subpath "/var")
      (subpath "/tmp")
      (subpath "/private")
      (subpath "/dev/null")
    )
    (deny file-read*
      (subpath "${home}/.ssh")
      (subpath "${home}/.aws")
    )
    `;

    sandboxProfilePath = join(tmpdir(), `pkgx_sandbox_${process.pid}_${Math.random().toString(36).substring(2, 15)}.sb`);
    await writeFile(sandboxProfilePath, SANDBOX_PROFILE);
    args = ["-f", sandboxProfilePath, cmd, ...args];
    cmd = "sandbox-exec";
  }

  try {
    // we make our own home so tools like `npx` can cache things since we prohibit writes everywhere else
    const HOME = tmp;
    const OLD_HOME = process.env.HOME;

    await mkdir(tmp, {recursive: true});

    const [stdout, stderr] = await new Promise<[string, string]>((resolve, reject) => {
      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {...process.env, HOME, OLD_HOME},
        cwd
      });

      let stdout = "";
      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      let stderr = "";
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code, signal) => {
        if (code === 0) {
          resolve([stdout, stderr]);
        } else {
          const title = signal ? `signal(${signal})` : `exit(${code})`;
          reject(new Error(JSON.stringify({ code, signal, program, args, cwd, HOME, stderr, stdout, title })));
        }
      });
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ stdout, stderr }) }],
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: error.message,
      }]
    };
  } finally {
    try {
      //TODO lets not block u numpty
      if (sandboxProfilePath) await unlink(sandboxProfilePath);
    } catch (e) {
      //noop
    }
  }
}

// Parse command line with proper quote handling
function parseCommandLine(cmd: string): [string, string[]] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i];

    if (char === '\\' && i + 1 < cmd.length) {
      // Handle escaped characters
      current += cmd[++i];
      continue;
    }

    if ((char === '"' || char === "'") && !inQuote) {
      // Start of quoted section
      inQuote = true;
      quoteChar = char;
      continue;
    }

    if (char === quoteChar && inQuote) {
      // End of quoted section
      inQuote = false;
      quoteChar = '';
      continue;
    }

    if (char === ' ' && !inQuote) {
      // Space outside quotes - split argument
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  // Add the last argument if there is one
  if (current) {
    args.push(current);
  }

  if (args.length === 0) {
    return ['', []];
  }

  return [args[0], args.slice(1)];
}

server.tool(
  "run-command-line",
  `
    Run a command line with \`pkgx\`.
    The command line can only contain a single program instantiation.
    Programs cannot write to the file system.
    HOME is set to a temporary directory you can write to.
    OLD_HOME is the previous HOME.
    Programs do not run in a terminal and thus do not have stdin capabilities.
    Shell syntax like pipes \`|\` will not work.
    If you need pipes, run the tool multiple times and pipe the output yourself.
  `,
  {
    commandLine: z.string().describe(`
      The program to run, pkgx provides almost all open source tools.
      The program string can be versioned, eg. \`node@20\`.
      Many tools are in npm or pypa—if so set the program to \`npx\` or \`uvx\` and put the tool you want in args!`),
    workingDirectory: z.string().default(".").describe(`
      Some tools work differently based on the directory they are run in.
      Use this parameter accordingly.`)
  },
  async ({ commandLine, workingDirectory }) => {
    checkNotRoot();
    const [cmd, args] = parseCommandLine(commandLine);
    return await runPkgxCommand(cmd, args, workingDirectory == "." ? undefined : workingDirectory);
  }
);

server.tool(
  "run-program-with-array-of-args",
  `
    Run a single program with \`pkgx\`.
    Programs cannot write to the file system.
    HOME is set to a temporary directory you can write to.
    OLD_HOME is the previous HOME.
    Programs do not run in a terminal and thus do not have stdin capabilities.
    Shell syntax like pipes \`|\` will not work.
    If you need pipes, run the tool multiple times and pipe the output yourself.
    The \`args\` parameter must be an array of strings.
    `,
  {
    program: z.string().describe(`
      The program to run, pkgx provides almost all open source tools.
      The program string can be versioned, eg. \`node@20\`.
      Many tools are in npm or pypa—if so set the program to \`npx\` or \`uvx\` and put the tool you want in args!`),
    args: z.array(z.string()).default([]).describe(`
      Arguments to pass to the program.
      The program is not run inside a shell, so do not use shell syntax like pipes.
      Shell quoting rules should also be ignored, any quotes will be passed directly to the program.
      `),
    workingDirectory: z.string().default(".").describe(`
      Some tools work differently based on the directory they are run in.
      Use this parameter accordingly.`)
  },
  async ({ program, args, workingDirectory }) => {
    checkNotRoot();
    return await runPkgxCommand(program, args, workingDirectory == "." ? undefined : workingDirectory);
  }
);

server.resource(
  "list-runnable-programs",
  "pkgx://programs/list",
  async (uri) => {
    const result = execSync("pkgx -Q", { stdio: ["inherit", "pipe", "inherit"] });
    return {
      contents: [{
        uri: uri.href,
        text: result.toString(),
      }]
    }
  }
)

server.resource(
  "list-mash-scripts",
  "pkgx://mash/list",
  async (uri) => {
    const rsp = await fetch("https://pkgxdev.github.io/mash/index.json");
    const text = await rsp.text();
    return {
      contents: [{
        uri: uri.href,
        text,
      }]
    }
  }
)

const transport = new StdioServerTransport();

server.connect(transport).catch((err) => {
  console.error(`Server failed: ${err}`);
  process.exit(1);
});

async function get_pkgx() {
  try {
    execSync("pkgx --version")
    throw new Error();
    return "pkgx";
  } catch {
    const platform = (() => {
      switch (`${process.platform}/${process.arch}`) {
        case "linux/x64":
          return "Linux/x86-64"
        case "linux/arm64":
          return "Linux/arm64"
        case "darwin/arm64":
          return "Darwin/arm64"
        case "darwin/x64":
          return "Darwin/x86-64"
        default:
          throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
      }
    })()

    await mkdir(tmp, {recursive: true});

    const url = `https://pkgx.sh/${platform}`;
    const filePath = join(tmp, "pkgx");
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to download pkgx: ${response.statusText}`);
    }

    const fileBuffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(fileBuffer), { mode: 0o755 });

    return filePath;
  }
}
