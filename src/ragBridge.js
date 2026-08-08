import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/**
 * Run `python3 -m rag <args…>` and parse JSON stdout.
 * Pass API keys via env, not argv.
 */
export function runRag(
  args,
  { timeoutMs = 600_000, openaiApiKey, googleApiKey } = {}
) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONUNBUFFERED: "1" };
    if (openaiApiKey) env.OPENAI_API_KEY = openaiApiKey;
    if (googleApiKey) env.GOOGLE_API_KEY = googleApiKey;

    const proc = spawn("python3", ["-m", "rag", ...args], {
      cwd: ROOT,
      env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`RAG command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .pop();
      if (!line) {
        reject(
          new Error(
            stderr.trim() ||
              `RAG process exited with code ${code} and no JSON output`
          )
        );
        return;
      }
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        reject(
          new Error(
            `Invalid RAG JSON: ${line.slice(0, 200)}${stderr ? ` | ${stderr.slice(0, 300)}` : ""}`
          )
        );
        return;
      }
      if (!data.ok) {
        reject(new Error(data.error || "RAG command failed"));
        return;
      }
      resolve(data);
    });
  });
}
