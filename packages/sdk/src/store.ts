import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

export type NoteStatus = 'created' | 'deposited' | 'inserted' | 'queued' | 'spendable' | 'spent' | 'refunded' | 'exited';
/** Derivation indexes reconstruct private material. The store never holds that material. */
export interface NoteRecord {
  id: string;
  kind: 'deposit' | 'change';
  secretIndex: number;
  status: NoteStatus;
  value: bigint | null;
  label: bigint | null;
  leafIndex: number | null;
  /** Change notes inherit the original deposit needed for a public exit. */
  origin: { txId: string; index: number; refundKeyHash: string } | null;
  gross: bigint | null;
  precommitment: bigint;
  /** A local submission is tentative until confirmed or expired. validUntil is POSIX milliseconds. */
  pending?: { kind: 'settle' | 'exit' | 'refund'; validUntil: number; changeNoteId: string | null };
  /** Seed recovery alone cannot recover the refund key chosen during preparation. */
  expectedRefundKeyHash?: string | null;
}
export interface StoreData { nextDepositIndex: number; nextChangeIndex: number; nextOneTimeIndex: number; notes: NoteRecord[] }
export interface NoteStore { load(): Promise<StoreData | null>; save(data: StoreData): Promise<void> }

export function memoryStore(): NoteStore {
  let data: StoreData | null = null;
  return {
    async load() { return structuredClone(data); },
    async save(value) { data = structuredClone(value); },
  };
}

/** JSON uses decimal strings for big integers. Rename publishes a complete file. */
export function fileStore(path: string): NoteStore {
  return {
    async load() {
      let text: string;
      try { text = await readFile(path, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const decimal = new Set(['value', 'label', 'gross', 'precommitment']);
      return JSON.parse(text, (key, value: unknown) => {
        if (!decimal.has(key) || value === null) return value;
        if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid stored ${key}`);
        return BigInt(value);
      }) as StoreData;
    },
    async save(data) {
      // Pick the public fields explicitly, even if a caller supplies extra properties.
      const safe: StoreData = {
        nextDepositIndex: data.nextDepositIndex, nextChangeIndex: data.nextChangeIndex, nextOneTimeIndex: data.nextOneTimeIndex,
        notes: data.notes.map(n => ({ id: n.id, kind: n.kind, secretIndex: n.secretIndex, status: n.status,
          value: n.value, label: n.label, leafIndex: n.leafIndex, gross: n.gross, precommitment: n.precommitment,
          ...(n.expectedRefundKeyHash === undefined ? {} : { expectedRefundKeyHash: n.expectedRefundKeyHash }),
          ...(n.pending === undefined ? {} : { pending: { kind: n.pending.kind, validUntil: n.pending.validUntil,
            changeNoteId: n.pending.changeNoteId } }),
          origin: n.origin === null ? null : { txId: n.origin.txId, index: n.origin.index, refundKeyHash: n.origin.refundKeyHash } })),
      };
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(safe, (_, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
  };
}
