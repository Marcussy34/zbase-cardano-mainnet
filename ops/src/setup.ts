import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Network } from '@zbase-cardano/txlib';
import { readSettings } from './env.js';

/** M0's largest circuit needs the power-16 transcript pinned in artifacts/dev. */
export function setupPaths(repoRoot: string, network: Network): { workDir: string; publishDir: string; ptauSource: string } {
  if (network !== 'mainnet' && network !== 'preprod') throw new Error('Invalid network');
  return { workDir: join(repoRoot, `circuits/build/keys-${network}`), publishDir: join(repoRoot, `deployments/${network}/keys`),
    ptauSource: join(repoRoot, 'circuits/build/dev/pot16_final.ptau') };
}

/** A deployed pool is bound to these files. No later setup run can make the same keys again. */
const PROVING_KEYS = ['spend.zkey', 'insert.zkey', 'ragequit.zkey'];

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

/** Copy public setup receipts too, so setup-dev can rehash its verified phase-1 cache. */
export async function runSetup(a: { repoRoot: string; network: Network; run?: (command: string, args: string[]) => Promise<void>;
  log?: (line: string) => void }): Promise<void> {
  const paths = setupPaths(resolve(a.repoRoot), a.network);
  await mkdir(paths.workDir, { recursive: true });
  const publish = async () => {
    await mkdir(paths.publishDir, { recursive: true });
    for (const file of ['spend_vkey.json', 'insert_vkey.json', 'ragequit_vkey.json', 'manifest.json']) {
      await copyFile(join(paths.workDir, file), join(paths.publishDir, file));
    }
  };
  // The key script replaces a key whenever Node.js, circom, snarkjs or a circuit changed since the last run.
  // A complete set may already guard funds, so it is never handed to that script. A partial set is an interrupted first run.
  if ((await Promise.all(PROVING_KEYS.map(file => exists(join(paths.workDir, file))))).every(Boolean)) {
    (a.log ?? console.log)(`Proving keys for ${a.network} already exist in ${paths.workDir}. The setup keeps them, because a deployed pool cannot work with other keys. To make new keys, move that folder away first.`);
    return publish();
  }
  try {
    await access(join(paths.workDir, 'pot16_final.ptau'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await copyFile(paths.ptauSource, join(paths.workDir, 'pot16_final.ptau'), constants.COPYFILE_EXCL);
    try {
      await copyFile(join(dirname(paths.ptauSource), 'phase1-verified.json'), join(paths.workDir, 'phase1-verified.json'), constants.COPYFILE_EXCL);
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  const run = a.run ?? ((command: string, args: string[]) => new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: a.repoRoot, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error('Key setup failed')));
  }));
  await run(process.execPath, [join(resolve(a.repoRoot), 'circuits/scripts/setup-dev.mjs'), '--out-dir', paths.workDir]);
  await publish();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { network } = readSettings();
    console.warn('CAUTION: this is a single-party key setup. Whoever runs it could forge proofs by keeping its randomness. Run a ceremony with several parties before these keys guard real funds.');
    await runSetup({ repoRoot: fileURLToPath(new URL('../../', import.meta.url)), network });
  } catch {
    // Child and filesystem errors can include caller-supplied environment data.
    console.error('Key setup failed. Check settings, the phase-1 cache, and setup output.');
    process.exitCode = 1;
  }
}
