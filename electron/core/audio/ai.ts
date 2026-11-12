// Optional "AI audio pack": Demucs (MIT licensed, by Meta) in a private Python
// virtual environment under <data>/ai. Separates vocals / instrumental / stems.
import fs from 'node:fs';
import path from 'node:path';
import { isWin, runCapture } from '../util';

export const DEMUCS_MODEL = 'htdemucs';
/**
 * Pinned versions. PyTorch 2.8 has Windows wheels for Python 3.10–3.13 on the CPU and CUDA 12.8
 * indexes (CUDA 12.8 is required for RTX 50-series / Blackwell GPUs). Demucs 4.1 needs Python ≥ 3.10
 * and no longer depends on torchaudio for audio I/O.
 */
export const TORCH_VERSION = '2.8.0';
export const DEMUCS_VERSION = '4.1.0';

export interface AiConfig {
  python: string; // venv python.exe
  device: 'cuda' | 'cpu';
  torch: string;
  installedAt: number;
}

export interface AiPaths {
  root: string;
  venv: string;
  python: string;
  torchHome: string;
  config: string;
}

export function aiPaths(dataDir: string): AiPaths {
  const root = path.join(dataDir, 'ai');
  const venv = path.join(root, 'venv');
  return {
    root,
    venv,
    python: isWin ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'),
    torchHome: path.join(root, 'torch'),
    config: path.join(root, 'config.json'),
  };
}

export function readAiConfig(p: AiPaths): AiConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(p.config, 'utf8')) as AiConfig;
    return fs.existsSync(c.python) ? c : null;
  } catch {
    return null;
  }
}

export interface PythonCandidate {
  cmd: string;
  args: string[]; // prefix args, e.g. ['-3.11'] for the py launcher
  version: string;
}

/** Python versions Demucs 4.1 + PyTorch 2.8 wheels support, most preferred first. */
const PREFERRED = ['3.12', '3.11', '3.10', '3.13'];

export function parsePyVersion(out: string): string | undefined {
  return /Python (\d+\.\d+)(\.\d+)?/.exec(out)?.[1];
}

/** Find a system Python suitable for creating the venv. */
export async function findPython(): Promise<PythonCandidate | null> {
  const found: PythonCandidate[] = [];
  if (isWin) {
    for (const v of PREFERRED) {
      try {
        const r = await runCapture('py', [`-${v}`, '--version'], { timeoutMs: 15000 });
        const ver = parsePyVersion(r.stdout + r.stderr);
        if (r.code === 0 && ver === v) found.push({ cmd: 'py', args: [`-${v}`], version: v });
      } catch {
        /* no py launcher */
      }
    }
  }
  for (const cmd of isWin ? ['python', 'python3'] : ['python3', 'python']) {
    try {
      const r = await runCapture(cmd, ['--version'], { timeoutMs: 15000 });
      const ver = parsePyVersion(r.stdout + r.stderr);
      // skip the Microsoft Store alias, which prints nothing useful
      if (r.code === 0 && ver && PREFERRED.includes(ver)) found.push({ cmd, args: [], version: ver });
    } catch {
      /* not on PATH */
    }
  }
  found.sort((a, b) => PREFERRED.indexOf(a.version) - PREFERRED.indexOf(b.version));
  return found[0] ?? null;
}

export async function hasNvidiaGpu(): Promise<boolean> {
  try {
    const r = await runCapture('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { timeoutMs: 15000 });
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** pip arguments installing PyTorch from the official PyTorch wheel index. */
export function torchInstallArgs(cuda: boolean): string[] {
  return [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
    `torch==${TORCH_VERSION}`,
    '--index-url', cuda ? 'https://download.pytorch.org/whl/cu128' : 'https://download.pytorch.org/whl/cpu',
  ];
}

export function demucsInstallArgs(): string[] {
  return ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `demucs==${DEMUCS_VERSION}`, 'soundfile'];
}

/** Python snippet that downloads the model weights and reports the torch build. */
export const WARMUP_PY = [
  'import json, torch',
  'from demucs.pretrained import get_model',
  `get_model("${DEMUCS_MODEL}")`,
  'print("VFAI " + json.dumps({"torch": torch.__version__, "cuda": bool(torch.cuda.is_available())}))',
].join('; ');

/**
 * Demucs command line (https://github.com/adefossez/demucs#separating-tracks):
 *   python -m demucs.separate -n htdemucs [--two-stems vocals] -d cuda|cpu -o OUT --filename "{stem}.{ext}" input.wav
 * Two-stem mode writes vocals.wav + no_vocals.wav, otherwise vocals/drums/bass/other.wav into OUT/htdemucs/.
 */
export function demucsArgs(opts: { input: string; outDir: string; twoStems: boolean; device: 'cuda' | 'cpu' }): string[] {
  return [
    '-m', 'demucs.separate',
    '-n', DEMUCS_MODEL,
    ...(opts.twoStems ? ['--two-stems', 'vocals'] : []),
    '-d', opts.device,
    '-o', opts.outDir,
    '--filename', '{stem}.{ext}',
    opts.input,
  ];
}

export function demucsOutput(outDir: string, stem: string): string {
  return path.join(outDir, DEMUCS_MODEL, `${stem}.wav`);
}

/** Environment for running the venv's Python: private model cache, ffmpeg on PATH, UTF-8 output. */
export function aiEnv(p: AiPaths, ffmpegDir?: string): NodeJS.ProcessEnv {
  const sep = isWin ? ';' : ':';
  return {
    ...process.env,
    TORCH_HOME: p.torchHome,
    HF_HOME: path.join(p.root, 'hf'),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PIP_NO_INPUT: '1',
    PATH: [ffmpegDir, process.env.PATH].filter(Boolean).join(sep),
  };
}
