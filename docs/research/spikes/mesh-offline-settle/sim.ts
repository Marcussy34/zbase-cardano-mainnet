import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CborWriter, toTxUnspentOutput, Transaction, TxCBOR } from '@meshsdk/core-cst';
import type { UTxO } from '@meshsdk/core';

export type Evaluation = {
  tag: string;
  index: number;
  budget: { mem: number; steps: number };
};

// Aiken expects two parallel arrays, not the UTXO map used by Scalus.
function cborArray(items: string[]): string {
  const writer = new CborWriter();
  writer.writeStartArray(items.length);
  for (const item of items) writer.writeEncodedValue(Buffer.from(item, 'hex'));
  return writer.encodeAsHex();
}

export function simulate(cbor: string, resolved: UTxO[]): Evaluation[] {
  const build = fileURLToPath(new URL('./stub/build/', import.meta.url));
  mkdirSync(build, { recursive: true });
  const temporary = mkdtempSync(`${build}simulate-`);
  try {
    const utxos = resolved.map(toTxUnspentOutput);
    writeFileSync(`${temporary}/tx.hex`, cbor);
    writeFileSync(`${temporary}/inputs.hex`, cborArray(utxos.map(u => u.input().toCbor())));
    writeFileSync(`${temporary}/outputs.hex`, cborArray(utxos.map(u => u.output().toCbor())));
    const binary = fileURLToPath(new URL('../../../../node_modules/.bin/aiken', import.meta.url));
    const output = execFileSync(binary, [
      'tx', 'simulate', `${temporary}/tx.hex`, `${temporary}/inputs.hex`, `${temporary}/outputs.hex`,
      '--zero-time', '1596059091000', '--zero-slot', '4492800', '--slot-length', '1000',
    ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(output) as { mem: number; cpu: number }[];
    const redeemers = [...(Transaction.fromCbor(TxCBOR(cbor)).witnessSet().redeemers()?.values() ?? [])]
      .sort((a, b) => a.tag() - b.tag() || Number(a.index() - b.index()));
    if (result.length !== redeemers.length) throw new Error('Aiken returned an unexpected redeemer count');
    return result.map((entry, i) => {
      if (!Number.isSafeInteger(entry.mem) || !Number.isSafeInteger(entry.cpu)) {
        throw new Error('Aiken did not return execution units');
      }
      const redeemer = redeemers[i]!;
      return {
        tag: ['SPEND', 'MINT', 'CERT', 'REWARD', 'VOTE', 'PROPOSE'][redeemer.tag()]!,
        index: Number(redeemer.index()), budget: { mem: entry.mem, steps: entry.cpu },
      };
    });
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    throw new Error(`Aiken simulation failed: ${failure.stderr?.toString() || failure.stdout?.toString() || failure.message}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
