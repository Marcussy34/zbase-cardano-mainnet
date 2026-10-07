import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { Address, AssetId, CborWriter, CredentialType, toTxUnspentOutput, Transaction, TxCBOR, type CredentialCore } from '@meshsdk/core-cst';
import { NETWORKS, type Network } from '@zx402/crypto';
import { ScriptFailure, type Utxo, type RedeemerUnits, type RedeemerTag } from '../types.js';

const execute = promisify(execFile);
const binary = fileURLToPath(new URL('../../../../node_modules/.bin/aiken', import.meta.url));
const build = fileURLToPath(new URL('../../build/', import.meta.url));
const tags: RedeemerTag[] = ['spend', 'mint', 'cert', 'reward', 'vote', 'propose'];

// Aiken takes parallel input and output arrays, not a map of UTXOs.
function cborArray(items: string[]): string {
  const writer = new CborWriter();
  writer.writeStartArray(items.length);
  for (const item of items) writer.writeEncodedValue(Buffer.from(item, 'hex'));
  return writer.encodeAsHex();
}

/**
 * Evaluates scripts with the pinned Aiken and the selected network's slot settings.
 * resolved must include every spent, reference, and collateral input.
 * Script failures include Aiken's diagnostic lines; other problems throw Error.
 */
export async function simulate(txCbor: string, resolved: Utxo[], network: Network = 'mainnet'): Promise<RedeemerUnits[]> {
  const { zeroTime, zeroSlot, slotLength } = NETWORKS[network];
  const tx = Transaction.fromCbor(TxCBOR(txCbor));
  const body = tx.body();
  const inputs = [
    ...body.inputs().values(),
    ...(body.referenceInputs()?.values() ?? []),
    ...(body.collateral()?.values() ?? []),
  ];
  const available = new Map(resolved.map(u => [`${u.ref.txId}#${u.ref.index}`, u]));
  const required = new Map<string, Utxo>();
  for (const input of inputs) {
    const ref = `${input.transactionId()}#${input.index()}`;
    const utxo = available.get(ref);
    if (!utxo) throw new Error(`Missing resolved input ${ref}`);
    required.set(ref, utxo);
  }
  const neededScripts = new Set<string>();
  const addCredential = (credential: CredentialCore | undefined): void => {
    if (credential?.type === CredentialType.ScriptHash) neededScripts.add(credential.hash);
  };
  for (const input of body.inputs().values()) {
    const utxo = required.get(`${input.transactionId()}#${input.index()}`)!;
    addCredential(Address.fromBech32(utxo.address).getProps().paymentPart);
  }
  for (const asset of body.mint()?.keys() ?? []) neededScripts.add(AssetId.getPolicyId(asset));
  for (const account of body.withdrawals()?.keys() ?? []) addCredential(Address.fromBech32(account).getProps().paymentPart);
  for (const certificate of body.certs()?.values() ?? []) {
    const core = certificate.toCore();
    if ('stakeCredential' in core) addCredential(core.stakeCredential);
    if ('dRepCredential' in core) addCredential(core.dRepCredential);
    // A committee's cold credential authorizes its certificate, not the new hot credential.
    if ('coldCredential' in core) addCredential(core.coldCredential);
  }
  const redeemers = [...(tx.witnessSet().redeemers()?.values() ?? [])]
    .sort((a, b) => a.tag() - b.tag() || Number(a.index() - b.index()));
  const utxos = [...required.values()].map(u => toTxUnspentOutput({
    input: { txHash: u.ref.txId, outputIndex: u.ref.index },
    output: {
      address: u.address,
      amount: [
        { unit: 'lovelace', quantity: u.value.lovelace.toString() },
        ...Object.entries(u.value.assets).map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
      ],
      ...(u.inlineDatum === null ? {} : { plutusData: u.inlineDatum }),
      ...(u.datumHash === null ? {} : { dataHash: u.datumHash }),
      // Aiken rejects unused references. Filter only its input copy, preserving ledger fees and witnesses.
      ...(u.scriptRef === null || !neededScripts.has(u.scriptRef.hash) ? {} : { scriptRef: u.scriptRef.cbor }),
    },
  }));

  await mkdir(build, { recursive: true });
  // The process ID keeps parallel test files from seeing each other's directories.
  const temporary = await mkdtemp(`${build}simulate-${process.pid}-`);
  try {
    await writeFile(`${temporary}/tx.hex`, txCbor);
    await writeFile(`${temporary}/inputs.hex`, cborArray(utxos.map(u => u.input().toCbor())));
    await writeFile(`${temporary}/outputs.hex`, cborArray(utxos.map(u => u.output().toCbor())));
    let stdout: string;
    try {
      ({ stdout } = await execute(binary, [
        'tx', 'simulate', `${temporary}/tx.hex`, `${temporary}/inputs.hex`, `${temporary}/outputs.hex`,
        '--zero-time', String(zeroTime), '--zero-slot', String(zeroSlot), '--slot-length', String(slotLength),
      ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
    } catch (error) {
      const failure = error as Error & { stderr?: string; stdout?: string };
      const diagnostic = stripVTControlCharacters([failure.stderr, failure.stdout].filter(Boolean).join('\n')).trim();
      const message = `Aiken simulation failed: ${diagnostic || failure.message}`;
      // Do not misclassify missing scripts, malformed CBOR, or process errors as script rejection.
      if (/failed script execution/i.test(diagnostic)) {
        throw new ScriptFailure(message, diagnostic.split(/\r?\n/).filter(line => line.trim().length > 0));
      }
      throw new Error(message, { cause: error });
    }
    const result: unknown = JSON.parse(stdout);
    if (!Array.isArray(result) || result.length !== redeemers.length) {
      throw new Error('Aiken returned an unexpected redeemer count');
    }
    return result.map((entry: unknown, i) => {
      if (typeof entry !== 'object' || entry === null || !('mem' in entry) || !('cpu' in entry)
        || typeof entry.mem !== 'number' || typeof entry.cpu !== 'number'
        || !Number.isSafeInteger(entry.mem) || !Number.isSafeInteger(entry.cpu) || entry.mem < 0 || entry.cpu < 0) {
        throw new Error('Aiken did not return valid execution units');
      }
      const redeemer = redeemers[i]!;
      const tag = tags[redeemer.tag()];
      const index = Number(redeemer.index());
      if (tag === undefined || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid redeemer identifier');
      return { tag, index, mem: BigInt(entry.mem), steps: BigInt(entry.cpu) };
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
