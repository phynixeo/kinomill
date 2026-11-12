// Windows optical drive access through IMAPI2 (built into Windows), driven by
// small PowerShell scripts: list burners and burn an ISO image with progress.
import fs from 'node:fs';
import path from 'node:path';
import type { DiscDrive } from '../../../shared/types';
import { isWin, runCapture } from '../util';

const PS = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';

export const LIST_DRIVES_PS = String.raw`
$ErrorActionPreference = 'Stop'
$out = @()
try { $dm = New-Object -ComObject IMAPI2.MsftDiscMaster2 } catch { Write-Output '[]'; exit 0 }
if (-not $dm.IsSupportedEnvironment) { Write-Output '[]'; exit 0 }
for ($i = 0; $i -lt $dm.Count; $i++) {
  try {
    $id = $dm.Item($i)
    $r = New-Object -ComObject IMAPI2.MsftDiscRecorder2
    $r.InitializeDiscRecorder($id)
    $profiles = @($r.SupportedProfiles)
    $dvd = @(0x11,0x13,0x14,0x15,0x16,0x1A,0x1B,0x2B) | Where-Object { $profiles -contains $_ }
    $bd = @(0x41,0x42,0x43) | Where-Object { $profiles -contains $_ }
    $media = $false
    try { $f = New-Object -ComObject IMAPI2.MsftDiscFormat2Data; $f.Recorder = $r; $null = $f.CurrentPhysicalMediaType; $media = $true } catch { }
    $letter = @($r.VolumePathNames) | Select-Object -First 1
    $out += [pscustomobject]@{ id = $id; name = (($r.VendorId + ' ' + $r.ProductId) -replace '\s+', ' ').Trim(); letter = $letter; canWriteDvd = [bool]$dvd; canWriteBd = [bool]$bd; mediaPresent = $media }
  } catch { }
}
if ($out.Count -eq 0) { Write-Output '[]' } else { ConvertTo-Json -InputObject @($out) -Compress }
`;

export const BURN_PS = String.raw`
param([string]$RecorderId, [string]$Iso, [string]$Label)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("2735413C-7F64-5B0F-8F00-5D77AFBE261E"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface DDiscFormat2DataEvents {
  [DispId(0x200)] void Update([In, MarshalAs(UnmanagedType.IDispatch)] object sender, [In, MarshalAs(UnmanagedType.IDispatch)] object progress);
}

[ClassInterface(ClassInterfaceType.None), ComVisible(true)]
public class VfBurnSink : DDiscFormat2DataEvents {
  static object Get(object o, string name) { return o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, null); }
  public void Update(object sender, object progress) {
    try {
      int action = Convert.ToInt32(Get(progress, "CurrentAction"));
      long start = Convert.ToInt64(Get(progress, "StartLba"));
      long count = Convert.ToInt64(Get(progress, "SectorCount"));
      long written = Convert.ToInt64(Get(progress, "LastWrittenLba"));
      double p = (action == 4 && count > 0) ? Math.Max(0, Math.Min(1, (double)(written - start) / count)) : -1;
      Console.WriteLine("BURN " + action + " " + (p < 0 ? "-1" : p.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture)));
    } catch { }
  }
}

public static class VfBurn {
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateStreamOnFileEx(string pszFile, uint grfMode, uint dwAttributes, bool fCreate, IntPtr pstmTemplate, out IStream ppstm);
  public static object OpenStream(string path) { IStream s; SHCreateStreamOnFileEx(path, 0x20, 0, false, IntPtr.Zero, out s); return s; }
  public static int Advise(object format, object sink) {
    IConnectionPointContainer cpc = (IConnectionPointContainer)format;
    IConnectionPoint cp; Guid g = typeof(DDiscFormat2DataEvents).GUID;
    cpc.FindConnectionPoint(ref g, out cp); int cookie; cp.Advise(sink, out cookie); return cookie;
  }
}
'@
$dm = New-Object -ComObject IMAPI2.MsftDiscMaster2
if ($dm.Count -eq 0) { throw 'No disc burner was found on this PC.' }
$r = New-Object -ComObject IMAPI2.MsftDiscRecorder2
$r.InitializeDiscRecorder($RecorderId)
$f = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
if (-not $f.IsRecorderSupported($r)) { throw 'This drive cannot write data discs.' }
$f.Recorder = $r
$f.ClientName = 'Kinomill'
try { $null = $f.CurrentPhysicalMediaType } catch { throw 'Insert a blank disc into the burner and try again.' }
if (-not $f.IsCurrentMediaSupported($r)) { throw 'The disc in the drive is not supported for writing.' }
if (-not $f.MediaHeuristicallyBlank) { throw 'The disc in the drive is not blank.' }
$isoBlocks = [math]::Ceiling((Get-Item $Iso).Length / 2048)
if ($f.FreeSectorsOnMedia -lt $isoBlocks) { throw ('The disc is too small: needs ' + $isoBlocks + ' sectors, ' + $f.FreeSectorsOnMedia + ' free.') }
$f.ForceMediaToBeClosed = $true
$null = [VfBurn]::Advise($f, (New-Object VfBurnSink))
Write-Output 'BURN 2 -1'
$f.Write([VfBurn]::OpenStream($Iso))
try { $r.EjectMedia() } catch { }
Write-Output 'BURN 6 1'
`;

async function runScript(script: string, args: string[], tempDir: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  fs.mkdirSync(tempDir, { recursive: true });
  const file = path.join(tempDir, `vf-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  // UTF-8 with BOM so Windows PowerShell 5.1 reads non-ASCII paths correctly
  fs.writeFileSync(file, '\ufeff' + script, 'utf8');
  try {
    return await runCapture(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { timeoutMs });
  } finally {
    fs.rm(file, { force: true }, () => undefined);
  }
}

/** List optical drives that can burn. Never throws: returns [] when IMAPI2 or drives are unavailable. */
export async function listDrives(tempDir: string): Promise<DiscDrive[]> {
  if (!isWin) return [];
  try {
    const r = await runScript(LIST_DRIVES_PS, [], tempDir, 30000);
    const text = r.stdout.trim().split(/\r?\n/).pop() ?? '[]';
    const parsed = JSON.parse(text || '[]') as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof (d as { id?: unknown }).id === 'string')
      .map((d) => ({
        id: String(d.id),
        name: String(d.name ?? 'Optical drive'),
        letter: d.letter ? String(d.letter) : undefined,
        canWriteDvd: !!d.canWriteDvd,
        canWriteBd: !!d.canWriteBd,
        mediaPresent: !!d.mediaPresent,
      }));
  } catch {
    return [];
  }
}

const ACTIONS: Record<number, string> = {
  0: 'Checking the disc',
  1: 'Formatting the disc',
  2: 'Preparing the burner',
  3: 'Calibrating laser power',
  4: 'Burning',
  5: 'Finalizing the disc',
  6: 'Done',
  7: 'Verifying',
};

export function parseBurnLine(line: string): { stage: string; progress: number } | null {
  const m = /^BURN (\d+) (-?[\d.]+)/.exec(line.trim());
  if (!m) return null;
  return { stage: ACTIONS[Number(m[1])] ?? 'Burning', progress: Number(m[2]) };
}

/** Script text + arguments for burning (executed through the job runtime so it can be canceled). */
export function burnInvocation(tempDir: string, drive: string, iso: string, label: string): { cmd: string; args: string[]; cleanup: () => void } {
  fs.mkdirSync(tempDir, { recursive: true });
  const file = path.join(tempDir, `vf-burn-${Date.now()}.ps1`);
  fs.writeFileSync(file, '\ufeff' + BURN_PS, 'utf8');
  return {
    cmd: PS,
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-RecorderId', drive, '-Iso', iso, '-Label', label],
    cleanup: () => fs.rm(file, { force: true }, () => undefined),
  };
}
