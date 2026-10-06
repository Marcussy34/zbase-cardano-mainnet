import { Transaction, TxCBOR, type TransactionInput, type TransactionOutput } from '@meshsdk/core-cst';
import { witnessKeyHashes } from './keys.js';
import type { RedeemerTag, ScriptRef, Utxo, UtxoRef, Value } from './types.js';

export interface TxOutputView {
  address: string;
  value: Value;
  inlineDatum: string | null;
  datumHash: string | null;
  scriptRef: ScriptRef | null;
}
export interface TxRedeemerView { tag: RedeemerTag; index: number; dataCbor: string; mem: bigint; steps: bigint }
export interface TxView {
  txId: string;
  size: number;
  inputs: UtxoRef[];
  referenceInputs: UtxoRef[];
  collateral: UtxoRef[];
  outputs: TxOutputView[];
  fee: bigint;
  mint: Record<string, bigint>;
  validFrom: number | null;
  invalidHereafter: number | null;
  requiredSigners: string[];
  redeemers: TxRedeemerView[];
  witnessKeyHashes: string[];
  witnessScriptHashes: string[];
  hasWithdrawals: boolean;
  hasCertificates: boolean;
  totalCollateral: bigint | null;
  collateralReturn: TxOutputView | null;
}

const tags: RedeemerTag[] = ['spend', 'mint', 'cert', 'reward', 'vote', 'propose'];

function refs(inputs: readonly TransactionInput[]): UtxoRef[] {
  return inputs.map(input => ({ txId: input.transactionId(), index: Number(input.index()) }))
    .sort((a, b) => (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : a.index - b.index));
}

function outputView(output: TransactionOutput): TxOutputView {
  const script = output.scriptRef();
  // Plutus fees count script bytes, excluding the enclosing CBOR byte string.
  const plutus = script?.asPlutusV1() ?? script?.asPlutusV2() ?? script?.asPlutusV3();
  const code = plutus?.rawBytes() ?? script?.asNative()?.toCbor();
  return {
    address: output.address().toBech32(),
    value: { lovelace: output.amount().coin(), assets: Object.fromEntries(output.amount().multiasset() ?? []) },
    inlineDatum: output.datum()?.asInlineData()?.toCbor() ?? null,
    datumHash: output.datum()?.asDataHash() ?? null,
    scriptRef: script && code ? { hash: script.hash(), cbor: script.toCbor(), size: code.length / 2 } : null,
  };
}

/** Decode ledger bytes once into a view independent of Mesh types. */
export function decodeTx(txCbor: string): TxView {
  const tx = Transaction.fromCbor(TxCBOR(txCbor));
  const body = tx.body();
  const witnesses = tx.witnessSet();
  const scripts = [
    ...(witnesses.nativeScripts()?.values() ?? []),
    ...(witnesses.plutusV1Scripts()?.values() ?? []),
    ...(witnesses.plutusV2Scripts()?.values() ?? []),
    ...(witnesses.plutusV3Scripts()?.values() ?? []),
  ];
  const collateralReturn = body.collateralReturn();
  return {
    txId: tx.getId(), size: txCbor.length / 2,
    inputs: refs(body.inputs().values()),
    referenceInputs: refs(body.referenceInputs()?.values() ?? []),
    collateral: refs(body.collateral()?.values() ?? []),
    outputs: body.outputs().map(outputView), fee: body.fee(),
    mint: Object.fromEntries(body.mint() ?? []),
    validFrom: body.validityStartInterval() ?? null,
    invalidHereafter: body.ttl() ?? null,
    requiredSigners: body.requiredSigners()?.toCore() ?? [],
    redeemers: [...(witnesses.redeemers()?.values() ?? [])]
      .sort((a, b) => a.tag() - b.tag() || Number(a.index() - b.index()))
      .map(redeemer => {
        const tag = tags[redeemer.tag()];
        const index = Number(redeemer.index());
        if (tag === undefined || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid redeemer identifier');
        return { tag, index, dataCbor: redeemer.data().toCbor(), mem: redeemer.exUnits().mem(), steps: redeemer.exUnits().steps() };
      }),
    witnessKeyHashes: witnessKeyHashes(txCbor),
    witnessScriptHashes: scripts.map(script => script.hash()),
    hasWithdrawals: (body.withdrawals()?.size ?? 0) > 0,
    hasCertificates: (body.certs()?.size() ?? 0) > 0,
    totalCollateral: body.totalCollateral() ?? null,
    collateralReturn: collateralReturn ? outputView(collateralReturn) : null,
  };
}

/** The outputs as UTXOs with refs txId#0, txId#1, and so on, for chaining. */
export function outputsOf(view: TxView): Utxo[] {
  return view.outputs.map((output, index) => ({ ref: { txId: view.txId, index }, ...structuredClone(output) }));
}
